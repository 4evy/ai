import { recordSchema } from "@ai/values/schema/input";
import { Effect } from "effect";
import * as v from "valibot";
import { COORDINATION_CAPABILITY } from "#farstep/protocol/coordination";
import type { HelperConnection } from "#farstep/transport/connection/bun";
import { JOB_CAPABILITIES, scriptRunnerSchema } from "../../../protocol/jobs/gateway";
import { WORKFLOW_CAPABILITY } from "../../../protocol/workflow/workflow";
import type { GatewayConnection } from "../gateway";

const environmentSchema = v.strictObject({
  env: recordSchema(v.string(), v.string()),
  scriptRunner: scriptRunnerSchema,
});

export const gatewayEnvironmentEffect = Effect.fnUntraced(function* (
  helper: HelperConnection,
  connection: GatewayConnection,
) {
  const platform = connection.platform === "macos" ? "darwin" : "linux";
  if (helper.identity.platform !== platform)
    return yield* Effect.fail(
      new Error("Job helper platform does not match the execution target"),
    );
  for (const capability of [
    ...JOB_CAPABILITIES,
    WORKFLOW_CAPABILITY,
    COORDINATION_CAPABILITY,
  ]) {
    if (!helper.identity.capabilities.includes(capability))
      return yield* Effect.fail(
        new Error(
          `Job helper lacks ${capability}; upgrade farstep before using managed jobs`,
        ),
      );
  }
  const response = yield* helper.callEffect("job.environment", {});
  const { env, scriptRunner } = yield* Effect.try({
    try: () => v.parse(environmentSchema, response.structuredContent),
    catch: (error) => error,
  });
  return { env, scriptRunner };
});
