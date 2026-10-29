import * as v from "valibot";

export { objectInputSchema } from "@ai/values/schema/input";

export const uuidSchema = v.pipe(
  v.string(),
  v.regex(
    /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/,
  ),
);

export const maintenanceTokenSchema = v.pipe(
  v.string(),
  v.regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u),
);

export const urlSchema = v.pipe(
  v.string(),
  v.metadata({ jsonSchemaInput: v.pipe(v.string(), v.url()) }),
  v.trim(),
  v.url(),
  v.transform((value) => value.replace(/[\t\n\r]/gu, "")),
);

export const helperHandshakeSchema = v.strictObject({
  protocolMajor: v.literal(1),
  version: v.pipe(v.string(), v.regex(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u)),
  installationId: uuidSchema,
  platform: v.picklist(["linux", "darwin", "win32"]),
  capabilities: v.array(v.pipe(v.string(), v.minLength(1))),
});
export type HelperIdentity = v.InferOutput<typeof helperHandshakeSchema>;

export function structuredResult(result: {
  isError?: boolean | undefined;
  structuredContent?: unknown;
}): unknown {
  if (result.structuredContent === undefined) {
    throw new Error(
      result.isError
        ? "Helper operation failed without structured metadata"
        : "Helper omitted structured metadata",
    );
  }
  return result.structuredContent;
}
