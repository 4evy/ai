import { resolve } from "node:path";
import { attempt, run } from "@ai/core/effect/effect";
import { Effect, Match, Schedule, type Scope } from "effect";
import type {
  WorkflowReadinessResult,
  WorkflowReady,
} from "#farstep/protocol/workflow/workflow";
import { commandProbe } from "./command";
import {
  entryExists,
  errorMessage,
  type Observation,
  type ReadinessContext,
} from "./context";
import { logProbe, matcherEffect } from "./log";
import { httpProbe, tcpProbe } from "./network";
import { validateReadiness } from "./validation";

const ATTEMPT_MS = 1000;
interface Probe {
  observe: Effect.Effect<Observation, unknown>;
  timeout?: () => Observation;
}

class ReadinessWait {
  private lastReason = "Readiness condition has not been observed";
  private cleanupFailure: string | undefined;
  constructor(
    private readonly ready: WorkflowReady,
    private readonly context: ReadinessContext,
  ) {}

  private result(
    state: "ready" | "failed" | "timed_out",
    reason: string,
  ): WorkflowReadinessResult {
    return { state, reason, observedAt: Date.now() };
  }

  private observerEffect() {
    const { context } = this;
    return Match.value(this.ready).pipe(
      Match.withReturnType<Effect.Effect<Probe, never, Scope.Scope>>(),
      Match.discriminatorsExhaustive("kind")({
        tcp: (ready) => Effect.succeed({ observe: tcpProbe(ready) }),
        http: (ready) => {
          const url = new URL(ready.url);
          return Effect.succeed({ observe: httpProbe(ready, url) });
        },
        command: (ready) =>
          Effect.succeed({
            observe: commandProbe(ready, context.cwd, (reason) => {
              this.cleanupFailure = reason;
            }),
          }),
        file: (ready) =>
          Effect.succeed({
            observe: Effect.gen(function* () {
              const path = resolve(context.cwd, ready.path);
              const exists = yield* attempt(() => entryExists(path));
              return {
                ready: exists === (ready.state === "present"),
                reason: `Readiness file ${path} ${exists ? "is present" : "is absent"}; required ${ready.state}`,
              };
            }),
          }),
        // Acquire one scoped matcher for all attempts so a timeout still owns cleanup
        log: (ready) =>
          matcherEffect(ready, (reason) => {
            this.cleanupFailure = reason;
          }).pipe(
            Effect.map(
              (matcher): Probe => ({
                observe: logProbe(matcher, context.log),
                // An interrupted matcher can still send a late reply; do not reuse it
                timeout: () =>
                  matcher.matching
                    ? {
                        ready: false,
                        fatal: true,
                        reason:
                          "Readiness log matching exceeded the per-attempt deadline",
                      }
                    : { ready: false, reason: "Readiness attempt timed out" },
              }),
            ),
          ),
      }),
    );
  }

  private attempt(probe: Probe) {
    return probe.observe.pipe(
      Effect.catch((error) =>
        Effect.succeed({
          ready: false,
          fatal: true,
          reason: errorMessage(error),
        }),
      ),
      Effect.timeoutOrElse({
        duration: ATTEMPT_MS,
        orElse: () =>
          Effect.succeed(
            probe.timeout?.() ?? {
              ready: false,
              reason: "Readiness attempt timed out",
            },
          ),
      }),
      Effect.map(
        (observation): Observation =>
          this.cleanupFailure
            ? { ready: false, fatal: true, reason: this.cleanupFailure }
            : observation,
      ),
    );
  }

  private probe() {
    const { ready } = this;
    return Effect.gen({ self: this }, function* () {
      const probe = yield* this.observerEffect();
      return yield* this.attempt(probe).pipe(
        Effect.tap((observation) =>
          Effect.sync(() => {
            this.lastReason = observation.reason;
          }),
        ),
        Effect.repeat({
          schedule: Schedule.spaced(ready.pollMs),
          until: (observation) => observation.ready || observation.fatal === true,
        }),
        Effect.map((observation) =>
          this.result(observation.ready ? "ready" : "failed", observation.reason),
        ),
      );
    }).pipe(
      Effect.timeoutOrElse({
        duration: ready.timeoutMs,
        orElse: () =>
          Effect.succeed(
            this.result(
              "timed_out",
              `Readiness timed out after ${ready.timeoutMs} ms: ${this.lastReason}`,
            ),
          ),
      }),
    );
  }

  private childExit() {
    const { context } = this;
    return attempt(() => context.exited).pipe(
      Effect.map((code) =>
        this.result(
          "failed",
          `Managed child exited with code ${code} before readiness`,
        ),
      ),
      Effect.catch((error) =>
        Effect.succeed(
          this.result(
            "failed",
            `Managed child exit observation failed: ${errorMessage(error)}`,
          ),
        ),
      ),
    );
  }

  async run(): Promise<WorkflowReadinessResult> {
    const { context } = this;
    let terminal: WorkflowReadinessResult;
    try {
      // Observe an already-settled child exit before starting the first probe
      terminal = await run(
        Effect.scoped(
          Effect.raceFirst(
            this.childExit(),
            Effect.yieldNow.pipe(Effect.andThen(this.probe())),
          ),
        ),
        context.signal,
      );
    } catch (error) {
      if (!context.signal.aborted) throw error;
      terminal = this.result("failed", "Readiness wait cancelled");
    }
    return this.cleanupFailure ? this.result("failed", this.cleanupFailure) : terminal;
  }
}

export async function waitForReady(
  requested: WorkflowReady,
  context: ReadinessContext,
): Promise<WorkflowReadinessResult> {
  const ready = validateReadiness(requested);
  return new ReadinessWait(ready, context).run();
}
