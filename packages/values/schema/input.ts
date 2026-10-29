import * as v from "valibot";
import { isRecord } from "../value/value";

// Native object and record schemas also accept arrays without an input guard
export const objectInputSchema = v.custom<Record<string, unknown>>(
  isRecord,
  "Expected an object",
);

function guardedInput<S extends v.GenericSchema>(
  schema: S,
  wireSchema: v.GenericSchema = schema,
) {
  return v.pipe(
    v.custom<v.InferInput<S>>(isRecord, objectInputSchema.message),
    v.metadata({ jsonSchemaInput: wireSchema }),
  );
}

export function objectSchema<S extends v.GenericSchema>(
  schema: S,
  wireSchema: v.GenericSchema = schema,
) {
  return v.pipe(guardedInput(schema, wireSchema), schema);
}

// Validate entries to retain constructor/prototype keys that v.record omits
// Discard __proto__ before validation, matching the native record policy
export function recordSchema<
  K extends v.GenericSchema<string, string>,
  V extends v.GenericSchema,
>(key: K, value: V) {
  return v.pipe(
    guardedInput(v.record(key, value)),
    v.transform((input) =>
      Object.entries(input).filter(([name]) => name !== "__proto__"),
    ),
    v.array(v.strictTuple([key, value])),
    v.transform(
      (entries) =>
        Object.fromEntries(entries) as Record<v.InferOutput<K>, v.InferOutput<V>>,
    ),
  );
}
