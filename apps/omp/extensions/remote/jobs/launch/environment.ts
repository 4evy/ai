import * as Records from "effect/Record";
import { jobEnvironmentKey } from "farstep/protocol/jobs/gateway";
import type { ExecutionTarget } from "../../connections/types";

export function launchEnvironment(
  target: ExecutionTarget,
  policy: "shared" | "inherit" | undefined,
  baseline: Record<string, string>,
): Record<string, string> {
  if (target.backend !== "local" || policy !== "inherit") return { ...baseline };
  return {
    ...Records.filter(baseline, (_value, key) => !jobEnvironmentKey.test(key)),
    ...Records.filter(
      process.env,
      (value, key): value is string =>
        jobEnvironmentKey.test(key) && value !== undefined,
    ),
  };
}
