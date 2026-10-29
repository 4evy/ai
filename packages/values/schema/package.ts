import * as v from "valibot";
import { objectSchema, recordSchema } from "./input.ts";

const dependencies = v.optional(recordSchema(v.string(), v.string()));

// Retain package-specific metadata when build and update tools rewrite manifests
export const packageJsonSchema = objectSchema(
  v.looseObject({
    name: v.optional(v.string()),
    version: v.optional(v.string()),
    exports: v.optional(v.unknown()),
    imports: v.optional(v.unknown()),
    bin: v.optional(v.unknown()),
    dependencies,
    devDependencies: dependencies,
    peerDependencies: dependencies,
    optionalDependencies: dependencies,
    patchedDependencies: dependencies,
  }),
);
