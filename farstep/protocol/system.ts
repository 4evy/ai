import * as v from "valibot";

export const SYSTEM_CAPABILITY = "system-exec-v1";
const SYSTEM_COMMAND_BYTES = 120 * 1024;
export const SYSTEM_TIMEOUT_SECONDS = 60;
export const SYSTEM_MAX_TIMEOUT_SECONDS = 3600;
export const SYSTEM_OUTPUT_BYTES = 256 * 1024;
const systemReplySchema = v.pipe(
  v.string(),
  v.parseJson(),
  v.union([
    v.object({ error: v.string() }),
    v.object({ result: v.nonOptional(v.unknown()) }),
  ]),
);

export function parseSystemReply(text: string): unknown {
  const reply = v.parse(systemReplySchema, text);
  if ("error" in reply) throw new Error(reply.error);
  return reply.result;
}

export const systemExecSchema = v.strictObject({
  command: v.pipe(
    v.string(),
    v.minLength(1),
    v.check(
      (value) =>
        !value.includes("\0") && Buffer.byteLength(value) <= SYSTEM_COMMAND_BYTES,
      "Command must fit 120 KiB and contain no NUL",
    ),
  ),
  cwd: v.optional(
    v.pipe(
      v.string(),
      v.check(
        (value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value),
        "Working directory must be absolute",
      ),
      v.excludes("\0"),
    ),
    "/",
  ),
  timeout: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(SYSTEM_MAX_TIMEOUT_SECONDS),
    ),
    SYSTEM_TIMEOUT_SECONDS,
  ),
});
export type SystemExec = v.InferOutput<typeof systemExecSchema>;

export const systemStatusSchema = v.strictObject({
  platform: v.picklist(["linux", "darwin", "win32"]),
  uid: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
  enabled: v.boolean(),
  root: v.boolean(),
  executable: v.string(),
  reason: v.optional(v.string()),
});
export const systemExecResultSchema = v.strictObject({
  exitCode: v.nullable(v.number()),
  stdout: v.string(),
  stderr: v.string(),
  stdoutTruncated: v.boolean(),
  stderrTruncated: v.boolean(),
  budgetSeconds: v.number(),
});
