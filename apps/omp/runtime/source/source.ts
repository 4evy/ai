import * as v from "valibot";

export const sourceSchema = v.strictObject({
  version: v.pipe(v.string(), v.regex(/^\d+\.\d+\.\d+$/u)),
  url: v.pipe(v.string(), v.url()),
  sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
});
