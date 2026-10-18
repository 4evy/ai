import * as Records from "effect/Record";
import * as v from "valibot";
import {
  jobEnvironmentKey,
  jobEnvironmentSchema,
} from "#farstep/protocol/jobs/gateway";

const environmentKey =
  /^(?:HOME|PATH|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z_]+|TERM|COLORTERM|TZ|TMPDIR|XDG_(?:CONFIG_HOME|DATA_HOME|STATE_HOME|CACHE_HOME|RUNTIME_DIR|CONFIG_DIRS|DATA_DIRS))$/u;

export function executionEnvironment(): Record<string, string> {
  return Records.filter(
    process.env,
    (value, key): value is string => environmentKey.test(key) && value !== undefined,
  );
}

export function validateEnvironment(
  env: Record<string, string>,
  baseline: Record<string, string>,
  kind: "Job" | "Workflow",
): void {
  const changes = Records.filter(env, (value, key) => baseline[key] !== value);
  if (
    Records.some(
      baseline,
      (value, key) => !jobEnvironmentKey.test(key) && env[key] !== value,
    )
  )
    throw new Error(`${kind} identity environment must match the gateway`);
  if (!v.safeParse(jobEnvironmentSchema, changes).success)
    throw new Error(
      `${kind} environment overrides must use allowed names and bounded NUL-free values`,
    );
}
