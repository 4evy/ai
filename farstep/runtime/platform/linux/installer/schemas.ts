import { uuidSchema } from "farstep/protocol/identity";
import * as v from "valibot";
import { PROTOCOL_MAJOR } from "#farstep/runtime/state";
export const storePath = v.pipe(
  v.string(),
  v.regex(/^\/nix\/store\/[a-z0-9]{32}-[A-Za-z0-9+._?=-]+$/u),
);
export const manifestSchema = v.strictObject({
  protocolMajor: v.literal(PROTOCOL_MAJOR),
  version: v.pipe(v.string(), v.regex(/^\d+\.\d+\.\d+$/u)),
  platform: v.literal("linux"),
  desktopExecutable: v.literal("bin/farstep-desktop"),
});
const ownedFile = v.strictObject({ path: v.string(), sha256: v.string() });
const generationSchema = v.strictObject({
  manager: v.literal("nix"),
  packagePath: storePath,
  version: v.string(),
  root: v.string(),
});
export const recordSchema = v.strictObject({
  version: v.literal(2),
  current: generationSchema,
  previous: v.optional(generationSchema),
  files: v.array(ownedFile),
});
export const preparationSchema = v.strictObject({
  version: v.literal(1),
  maintenanceToken: uuidSchema,
  original: generationSchema,
  wasActive: v.boolean(),
  wasEnabled: v.boolean(),
});
export type InstallationRecord = v.InferOutput<typeof recordSchema>;
export type Generation = v.InferOutput<typeof generationSchema>;
export type Manager = Generation["manager"];
export type Preparation = v.InferOutput<typeof preparationSchema>;
