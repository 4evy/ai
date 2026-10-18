import { schemaJsonSchema } from "@ai/core/schema/json";
import * as v from "valibot";
import {
  authorizeRequestSchema,
  type DesktopAction,
  desktopActionSchema,
  desktopErrorSchema,
  textReceiptSchema,
} from "../desktop/desktop";

export const INPUT_METHODS = [
  "click",
  "move",
  "press_key",
  "type_text",
  "scroll",
  "drag",
] as const satisfies readonly DesktopAction["method"][];
export const DESKTOP_METHODS = [
  "get_screenshot",
  ...INPUT_METHODS,
  "drag_handle",
] as const;

export const screenshotOptionsSchema = v.pick(authorizeRequestSchema, ["outputName"]);
export const textResultSchema = v.variant("status", [
  v.strictObject({ ...textReceiptSchema.entries, status: v.literal("ok") }),
  v.strictObject({
    ...textReceiptSchema.entries,
    ...v.pick(desktopErrorSchema, ["status", "code", "message"]).entries,
  }),
]);

export function waylandReference() {
  const methods = new Set<string>(INPUT_METHODS);
  const inputs = Object.fromEntries(
    desktopActionSchema.options
      .filter((schema) => methods.has(schema.entries.method.literal))
      .map((schema) => [
        schema.entries.method.literal,
        schemaJsonSchema(schema.entries.input),
      ]),
  );
  return {
    methods: DESKTOP_METHODS,
    screenshotOptions: schemaJsonSchema(screenshotOptionsSchema),
    inputs,
    textResult: schemaJsonSchema(textResultSchema),
  };
}
