import { recordSchema } from "@ai/core/schema/input";
import { readText } from "@ai/core/text/text";
import { isRecord } from "@ai/core/value/value";
import * as v from "valibot";
import { jsonValueSchema } from "#farstep/protocol/workflow/schemas";

const MAX_SOURCE_BYTES = 49152;
const MAX_PARAMS_BYTES = 16384;
export const DEFAULT_CAPTURE_BYTES = 1024 * 1024;

const parameters = recordSchema(v.string(), jsonValueSchema);

export const scriptFields = {
  script: v.pipe(
    v.string(),
    v.minLength(1),
    v.check(
      (source) => Buffer.byteLength(source) <= MAX_SOURCE_BYTES,
      "Script exceeds 48 KiB",
    ),
    v.description(
      readText(new URL("./script.md", import.meta.url), "script", {
        SOURCE_KIB: String(MAX_SOURCE_BYTES / 1024),
      }),
    ),
  ),
  params: v.pipe(
    v.optional(
      v.pipe(
        v.custom<v.InferInput<typeof parameters>>(
          isRecord,
          "Expected JSON parameters object",
        ),
        v.check((params) => {
          checkScriptInput({ params });
          return true;
        }),
        v.metadata({ jsonSchemaInput: parameters }),
        parameters,
      ),
    ),
    v.description(
      "JSON parameters available as params in the target script; at most 16 KiB and 32 nesting levels",
    ),
  ),
  captureBytes: v.pipe(
    v.optional(
      v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(16 * 1024 * 1024)),
    ),
    v.description(
      "Maximum combined stdout/stderr buffered by each zx command; default 1 MiB; exceeding it fails the job",
    ),
  ),
};
export const scriptInputSchema = v.strictObject(scriptFields);

// Bound nesting before the recursive JSON schema visits external parameters
export function checkScriptInput(input: unknown): void {
  if (typeof input !== "object" || input === null) return;
  if ("command" in input)
    throw new Error(
      "Use script and params; command inputs have been replaced by TypeScript + zx",
    );
  if (!("params" in input) || input.params === undefined) return;
  const pending = [{ value: input.params, depth: 0 }];
  const seen = new WeakSet<object>();
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current.value !== "object" || current.value === null)
      continue;
    if (current.depth > 32 || seen.has(current.value))
      throw new Error(
        "Parameters must be an acyclic JSON value with at most 32 nesting levels",
      );
    seen.add(current.value);
    for (const value of Object.values(current.value))
      pending.push({ value, depth: current.depth + 1 });
  }
  if (Buffer.byteLength(JSON.stringify(input.params)) > MAX_PARAMS_BYTES)
    throw new Error("Parameters exceed 16 KiB");
}
