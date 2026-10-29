import { run } from "@ai/runtime/effect/effect";
import { Effect } from "effect";
import * as v from "valibot";
import { uuidSchema } from "../../protocol/identity";
import { type ScriptTransport, scriptCommandEffect } from "./execution";
import { currentHelper, helperCommand } from "./helper";

export const helperStatusSchema = v.looseObject({
  installed: v.boolean(),
  installationId: v.optional(uuidSchema),
  version: v.optional(v.string()),
  jobsReady: v.optional(v.boolean()),
});
export type HelperStatus = v.InferOutput<typeof helperStatusSchema>;

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
    `if [ -x ${currentHelper} ]; then ${currentHelper} status; elif [ -x /run/current-system/sw/bin/farstep ]; then /run/current-system/sw/bin/farstep status; elif [ -x /usr/bin/farstep ]; then /usr/bin/farstep status; elif [ -x /usr/local/bin/farstep ]; then /usr/local/bin/farstep status; else printf '%s\\n' '{"installed":false,"jobsReady":false,"status":"not-installed"}'; fi`,
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
