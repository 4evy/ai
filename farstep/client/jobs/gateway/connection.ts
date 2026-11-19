import { recordSchema } from "@ai/values/schema/input";
import { Effect } from "effect";
import * as v from "valibot";
import { COORDINATION_CAPABILITY } from "#farstep/protocol/coordination";
import type { HelperConnection } from "#farstep/transport/connection/bun";
import {
  gatewayEnvironmentSchema,
  JOB_CAPABILITIES,
  SCRIPT_CAPABILITY,
} from "../../../protocol/jobs/gateway";
import { WORKFLOW_CAPABILITY } from "../../../protocol/workflow/workflow";
import type { GatewayConnection } from "../gateway";

const recoveryEnvironmentSchema = v.object({
  env: recordSchema(v.string(), v.string()),
  scriptRunner: v.object({
    application: v.pipe(v.string(), v.startsWith("/")),
  }),
});

export const gatewayEnvironmentEffect = Effect.fnUntraced(function* (
  helper: HelperConnection,
  connection: GatewayConnection,
  launch: boolean,
) {
  const platform = connection.platform === "macos" ? "darwin" : "linux";
  if (helper.identity.platform !== platform)
    return yield* Effect.fail(
      new Error("Job helper platform does not match the execution target"),
    );
  for (const capability of [
    ...JOB_CAPABILITIES.filter((value) => launch || value !== SCRIPT_CAPABILITY),
    WORKFLOW_CAPABILITY,
    COORDINATION_CAPABILITY,
  ]) {
    if (!helper.identity.capabilities.includes(capability))
      return yield* Effect.fail(
        new Error(
          `Job helper lacks ${capability}. Upgrade and activate Farstep on the target, then disconnect and reconnect the target. No user script was run`,
        ),
      );
  }
  const response = yield* helper.callEffect(
    "job.environment",
    launch ? {} : { launch: false },
  );
  return yield* Effect.try({
    try: () => {
      if (launch) {
        const environment = v.parse(
          gatewayEnvironmentSchema,
          response.structuredContent,
        );
        return { ...environment, application: environment.scriptRunner.application };
      }
      const environment = v.parse(
        recoveryEnvironmentSchema,
        response.structuredContent,
      );
      return {
        env: environment.env,
        application: environment.scriptRunner.application,
        scriptRunner: undefined,
        activation: undefined,
      };
    },
    catch: (error) =>
      new Error(
        "Job helper did not prove the requested environment/API contract. Upgrade and activate Farstep on the target, then disconnect and reconnect the target. No user script was run",
        { cause: error },
      ),
  });
});
