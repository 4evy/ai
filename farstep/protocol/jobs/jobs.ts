import * as v from "valibot";
export const jobIdentitySchema = v.strictObject({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(256), v.excludes("\0")),
  nativeId: v.pipe(v.string(), v.minLength(1), v.maxLength(256), v.excludes("\0")),
});
export const actionIdSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9._:-]{1,128}$/u));
export const settlingShape = {
  settleMs: v.optional(
    v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(1000)),
    100,
  ),
  maxWaitMs: v.optional(
    v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(5000)),
    500,
  ),
};
export const observeRequestSchema = v.strictObject({
  ...jobIdentitySchema.entries,
  ...settlingShape,
  waitForFrame: v.optional(v.boolean(), false),
});
export const terminalSizeSchema = v.strictObject({
  columns: v.pipe(v.number(), v.safeInteger(), v.minValue(20), v.maxValue(400)),
  rows: v.pipe(v.number(), v.safeInteger(), v.minValue(5), v.maxValue(200)),
});
