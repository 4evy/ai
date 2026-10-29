import { readFileSync as readResource } from "node:fs";
import { Worker } from "node:worker_threads";
import { attempt } from "@ai/runtime/effect/effect";
import { toError } from "@oh-my-pi/pi-utils/type-guards";
import { Effect } from "effect";
import type { WorkflowReady } from "#farstep/protocol/workflow/workflow";

import { errorMessage, type ReadinessContext } from "./context";

const patternScript = readResource(new URL("../pattern.cjs", import.meta.url), "utf8");

const MAX_LOG_CHARS = 65536;

export interface LogMatcher {
  worker: Worker;
  error?: Error;
  matching: boolean;
}

export const logProbe = Effect.fnUntraced(function* (
  matcher: LogMatcher,
  log: ReadinessContext["log"],
) {
  const text = yield* attempt(async () => log());
  if (matcher.error)
    return { ready: false, fatal: true, reason: errorMessage(matcher.error) };
  let detach = () => {};
  const matched = yield* Effect.callback<boolean, unknown>((resume) => {
    const match = (matched: unknown) => {
      matcher.matching = false;
      resume(
        typeof matched === "boolean"
          ? Effect.succeed(matched)
          : Effect.fail(new Error("Invalid readiness regex worker response")),
      );
    };
    const fail = (error: Error) => resume(Effect.fail(error));
    const exit = (code: number) =>
      fail(
        new Error(`Readiness regex worker exited with code ${code} before matching`),
      );
    detach = () => {
      matcher.worker.removeListener("message", match);
      matcher.worker.removeListener("error", fail);
      matcher.worker.removeListener("exit", exit);
    };
    matcher.worker.once("message", match);
    matcher.worker.once("error", fail);
    matcher.worker.once("exit", exit);
    try {
      matcher.matching = true;
      matcher.worker.postMessage(text.slice(-MAX_LOG_CHARS));
    } catch (error) {
      resume(Effect.fail(error));
    }
  }).pipe(Effect.ensuring(Effect.sync(() => detach())));
  return {
    ready: matched,
    reason: matched
      ? "Readiness log pattern matched"
      : "Readiness log pattern has not matched the bounded log tail",
  };
});

export function matcherEffect(
  ready: Extract<WorkflowReady, { kind: "log" }>,
  cleanupFailed: (reason: string) => void,
) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const worker = new Worker(patternScript, {
        eval: true,
        workerData: ready.pattern,
      });
      const lifecycle: LogMatcher = { worker, matching: false };
      worker.on("error", (error) => {
        lifecycle.error = toError(error);
      });
      worker.on("exit", (code) => {
        lifecycle.error = new Error(`Readiness regex worker exited with code ${code}`);
      });
      return lifecycle;
    }),
    ({ worker }) =>
      attempt(() => worker.terminate()).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            cleanupFailed(
              `Readiness regex worker cleanup failed: ${errorMessage(error)}`,
            );
          }),
        ),
      ),
  );
}
