import * as v from "valibot";

export const textSchema = v.pipe(v.string(), v.excludes("\0", "NUL is not allowed"));
export const identifierSchema = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
  v.check((value) => !value.startsWith("__ai_"), "The __ai_ prefix is reserved"),
);
