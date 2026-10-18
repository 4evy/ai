import * as v from "valibot";
import { uuidSchema } from "#farstep/protocol/identity";

const workspaceId = uuidSchema;
export const scratchRecordSchema = v.strictObject({
  version: v.literal(1),
  id: workspaceId,
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  createdAt: v.pipe(
    v.string(),
    v.regex(
      /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z$/u,
    ),
    v.check(
      (value) =>
        new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) ===
        value.slice(0, 10),
      "Invalid ISO datetime",
    ),
  ),
});
export const scratchParameters = v.variant("action", [
  v.strictObject({
    action: v.literal("create"),
    target: v.optional(v.pipe(v.string(), v.minLength(1))),
    name: v.pipe(
      scratchRecordSchema.entries.name,
      v.description("Short label for the experiment"),
    ),
  }),
  v.strictObject({
    action: v.literal("list"),
    target: v.optional(v.pipe(v.string(), v.minLength(1))),
  }),
  ...(["inspect", "remove"] as const).map((action) =>
    v.strictObject({
      action: v.literal(action),
      target: v.optional(v.pipe(v.string(), v.minLength(1))),
      workspace: v.pipe(
        workspaceId,
        v.description("Exact workspace ID returned by scratch"),
      ),
    }),
  ),
]);
