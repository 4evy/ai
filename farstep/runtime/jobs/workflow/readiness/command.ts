import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { attempt } from "@ai/core/effect/effect";
import { type ChildProcess, spawn } from "@oh-my-pi/pi-utils/ptree";
import { Effect, Record as Records, Schedule, Stream } from "effect";
import type { WorkflowReady } from "#farstep/protocol/workflow/workflow";

import { errorMessage, type Observation } from "./context";
import { ProbeProcesses } from "./processes";

function probeEnvironment(overrides: Record<string, string>): Record<string, string> {
  return Records.filter(
    { ...process.env, ...overrides },
    (value) => value !== undefined,
  );
}

const probeApplication = Effect.fnUntraced(function* (
  ready: Extract<WorkflowReady, { kind: "command" }>,
  commandCwd: string,
  env: Record<string, string>,
) {
  yield* attempt(() => access(commandCwd, constants.X_OK));
  if (!(yield* attempt(() => stat(commandCwd))).isDirectory())
    return yield* Effect.fail(new Error("Readiness command cwd is not a directory"));
  const application = ready.spec.application.includes("/")
    ? resolve(commandCwd, ready.spec.application)
    : ((yield* Effect.try({
        try: () =>
          Bun.which(ready.spec.application, {
            cwd: commandCwd,
            ...(env.PATH === undefined ? {} : { PATH: env.PATH }),
          }),
        catch: (error) => error,
      })) ?? "");
  if (!application)
    return yield* Effect.fail(
      new Error(
        `Readiness command application was not found: ${ready.spec.application}`,
      ),
    );
  yield* attempt(() => access(application, constants.X_OK));
  if (!(yield* attempt(() => stat(application))).isFile())
    return yield* Effect.fail(new Error("Readiness command application is not a file"));
  return application;
});

class CommandObservation {
  private readonly processes: ProbeProcesses;
  constructor(private readonly child: ChildProcess<"ignore">) {
    // Stderr is drained into the utility's bounded tail; discard stdout entirely
    void child.exited.catch(() => {});
    this.processes = new ProbeProcesses(child);
  }

  run(): Effect.Effect<Observation, unknown> {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.forkScoped(
        Effect.sync(() => this.processes.collect()).pipe(
          Effect.repeat(Schedule.spaced(20)),
        ),
      );
      const [code] = yield* Effect.all(
        [
          attempt(() => this.child.proc.exited),
          Stream.fromReadableStream({
            evaluate: () => this.child.proc.stdout,
            onError: (error) => error,
          }).pipe(Stream.runDrain),
        ],
        { concurrency: "unbounded" },
      );
      return {
        ready: code === 0,
        reason:
          code === 0
            ? "Readiness command exited with code 0"
            : `Readiness command exited with code ${code}: ${this.child.peekStderr().slice(-1024).replaceAll("\0", "\uFFFD")}`,
      };
    }).pipe(Effect.scoped);
  }

  cleanup(): Promise<void> {
    return this.processes.cleanup();
  }
}

export const commandProbe = Effect.fnUntraced(function* (
  ready: Extract<WorkflowReady, { kind: "command" }>,
  cwd: string,
  cleanupFailed: (reason: string) => void,
) {
  const commandCwd = resolve(cwd, ready.spec.cwd);
  const env = probeEnvironment(ready.spec.env);
  const application = yield* probeApplication(ready, commandCwd, env);
  let observation: CommandObservation | undefined;
  const child = yield* Effect.acquireRelease(
    Effect.try({
      // The native utility retains detached groups and, on Linux, a subreaper
      try: () =>
        spawn([application, ...ready.spec.args], {
          cwd: commandCwd,
          env,
          stdin: "ignore",
          detached: true,
          subreaper: true,
        }),
      catch: (error) => error,
    }),
    (child) =>
      attempt(() =>
        observation ? observation.cleanup() : new ProbeProcesses(child).cleanup(),
      ).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            cleanupFailed(`Readiness probe cleanup failed: ${errorMessage(error)}`);
          }),
        ),
      ),
  );
  observation = yield* Effect.try({
    try: () => new CommandObservation(child),
    catch: (error) => error,
  });
  return yield* observation.run();
}, Effect.scoped);
