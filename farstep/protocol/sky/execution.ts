import * as v from "valibot";

export const MAX_FRAME = 32 * 1024 * 1024;
export const EMPTY_INPUT = v.strictObject({});
export const skyBackendSchema = v.picklist(["upstream", "wayland"]);
export type SkyBackend = v.InferOutput<typeof skyBackendSchema>;

export const skyTurnSchema = v.strictObject({
  sessionId: v.pipe(v.string(), v.minLength(1)),
  turnId: v.pipe(v.string(), v.minLength(1)),
});
export type SkyTurn = v.InferOutput<typeof skyTurnSchema>;

export const EXECUTION_TOOLS = [
  {
    name: "js",
    schema: v.strictObject({
      code: v.string(),
      turn: skyTurnSchema,
      title: v.optional(v.string()),
      timeout_ms: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(3_600_000)),
      ),
    }),
    defaultTimeoutMs: 30_000,
    graceMs: 15_000,
  },
  {
    name: "js_reset",
    schema: EMPTY_INPUT,
    defaultTimeoutMs: 30_000,
    graceMs: 0,
  },
] as const;
