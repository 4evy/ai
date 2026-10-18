import { objectSchema } from "@ai/core/schema/input";
import * as v from "valibot";
import { GUIDE_TOPICS } from "./guides/topics";

export function createSkylightParameters() {
  const targetFields = {
    target: v.pipe(
      v.optional(v.string()),
      v.description(
        "local (default), or an OpenSSH host/alias such as evy@100.123.214.78; each target has independent bindings",
      ),
    ),
    cwd: v.pipe(
      v.optional(v.string()),
      v.description(
        "Working directory on the selected machine; remote targets default to their login directory",
      ),
    ),
  };
  const guideParameters = v.object({
    ...targetFields,
    topic: v.pipe(
      v.picklist(GUIDE_TOPICS),
      v.description("Load just the guidance needed for the next step"),
    ),
  });
  const inputFields = v.object({
    ...targetFields,
    code: v.pipe(
      v.optional(v.string()),
      v.description("Computer-use JavaScript with top-level await"),
    ),
    title: v.pipe(
      v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(80))),
      v.description("Short action or observation title shown in chat"),
    ),
    timeout_ms: v.optional(v.pipe(v.number(), v.integer(), v.gtValue(0))),
    reset: v.pipe(
      v.optional(v.boolean()),
      v.description("Clear Skylight bindings before executing code"),
    ),
  });
  const parameters = objectSchema(inputFields);
  const endpoint = v.strictObject({
    ...targetFields,
    path: v.pipe(v.string(), v.minLength(1)),
  });
  const syncParameters = v.strictObject({
    from: endpoint,
    to: endpoint,
    expectedSha256: v.nullable(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/))),
  });
  return { guideParameters, parameters, syncParameters };
}
