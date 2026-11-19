import { run } from "@ai/runtime/effect/effect";
import { Effect } from "effect";
import * as v from "valibot";
import { systemHelper } from "../../installation";
import { uuidSchema } from "../../protocol/identity";
import { scriptRunnerSchema } from "../../protocol/jobs/gateway";
import { type ScriptTransport, scriptCommandEffect } from "./execution";
import { helperCommand, unixHelperSelection } from "./helper";

export const helperStatusSchema = v.pipe(
  v.looseObject({
    installed: v.boolean(),
    installationId: v.optional(uuidSchema),
    version: v.optional(v.string()),
    manager: v.optional(v.string()),
    jobsReady: v.optional(v.boolean()),
    scriptRunner: v.optional(v.unknown()),
  }),
  v.transform((status) => {
    const runner = v.safeParse(scriptRunnerSchema, status.scriptRunner);
    return {
      ...status,
      scriptRunner: runner.success ? runner.output : undefined,
      scriptApiCompatible: runner.success,
      jobsReady: status.jobsReady === true && runner.success,
      ...(status.jobsReady === true && !runner.success
        ? {
            reason:
              "Helper has not verified the cmd/Env/Effect script API. Upgrade and activate Farstep on the target, then disconnect and reconnect the target",
          }
        : {}),
    };
  }),
);
export type HelperStatus = Partial<v.InferOutput<typeof helperStatusSchema>> & {
  installed: boolean;
};

export const helperStatusEffect = Effect.fnUntraced(function* (
  platform: string,
  transport: ScriptTransport,
): Effect.fn.Return<HelperStatus, unknown> {
  if (platform === "windows") {
    const output = yield* scriptCommandEffect(
      transport,
      helperCommand({ info: { os: platform } }, ["status"]),
    );
    return yield* Effect.try({
      try: () => v.parse(helperStatusSchema, JSON.parse(output)),
      catch: (error) => error,
    });
  }
  if (platform !== "linux" && platform !== "macos")
    return {
      installed: false,
      jobsReady: false,
      reason: "farstep supports Linux and macOS jobs",
    };
  const output = yield* scriptCommandEffect(
    transport,
    `${unixHelperSelection(platform)}\nif [ -x "$helper" ]; then "$helper" status; elif [ -x '${systemHelper}' ]; then '${systemHelper}' status; elif [ -x /usr/bin/farstep ]; then /usr/bin/farstep status; elif [ -x /usr/local/bin/farstep ]; then /usr/local/bin/farstep status; else printf '%s\\n' '{"installed":false,"jobsReady":false,"status":"not-installed"}'; fi`,
  );
  return yield* Effect.try({
    try: () => v.parse(helperStatusSchema, JSON.parse(output)),
    catch: (error) => error,
  });
});

export function helperStatus(
  platform: string,
  transport: ScriptTransport,
  signal?: AbortSignal,
): Promise<HelperStatus> {
  return run(helperStatusEffect(platform, transport), signal);
}
