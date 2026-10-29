import { type JsonSchema, toJsonSchema } from "@valibot/to-json-schema";
import * as Records from "effect/Record";
import * as v from "valibot";
import { isRecord } from "../value/value";

function isNativeSchema(value: unknown): value is v.GenericSchema {
  return (
    isRecord(value) && value.kind === "schema" && typeof value["~run"] === "function"
  );
}

// Input-mode conversion stops before a second schema in a pipeline, so guarded
// inputs declare their native wire projection in metadata instead
function projectInputSchema(
  schema: v.GenericSchema,
  cache: WeakMap<object, v.GenericSchema>,
): v.GenericSchema {
  const cached = cache.get(schema);
  if (cached) return cached;

  const projection = v.getMetadata(schema).jsonSchemaInput;
  if (isNativeSchema(projection)) {
    const projected = projectInputSchema(projection, cache);
    cache.set(schema, projected);
    return projected;
  }

  const projected = { ...schema };
  const children: Record<string, unknown> = projected;
  cache.set(schema, projected);

  function projectChild(child: unknown): unknown {
    if (isNativeSchema(child)) return projectInputSchema(child, cache);
    if (Array.isArray(child)) return child.map(projectChild);
    return child;
  }

  if (
    "entries" in schema &&
    typeof schema.entries === "object" &&
    schema.entries !== null
  ) {
    children.entries = Records.map(schema.entries, projectChild);
  }
  for (const key of [
    "items",
    "item",
    "key",
    "value",
    "wrapped",
    "options",
    "rest",
    "pipe",
  ]) {
    if (key in children) children[key] = projectChild(children[key]);
  }
  if ("getter" in schema && typeof schema.getter === "function") {
    // Native lazy schemas expose this synchronous schema getter
    const getter = schema.getter as (input: unknown) => v.GenericSchema;
    children.getter = (input: unknown) => projectInputSchema(getter(input), cache);
  }
  return projected;
}

export function schemaJsonSchema(schema: v.GenericSchema): JsonSchema {
  const projected = projectInputSchema(schema, new WeakMap());
  return toJsonSchema(projected, {
    typeMode: "input",
    // JSON numbers are finite; content and cross-field checks run at execution
    ignoreActions: ["check", "partial_check", "finite", "excludes"],
    overrideAction({ valibotAction, jsonSchema, errors }) {
      // JSON Schema patterns use Unicode mode without a separate flags field
      if (
        valibotAction.type === "regex" &&
        "requirement" in valibotAction &&
        valibotAction.requirement instanceof RegExp &&
        valibotAction.requirement.flags === "u" &&
        errors?.every(
          (error) => error === "RegExp flags are not supported by JSON Schema.",
        )
      )
        return jsonSchema;
      return undefined;
    },
  });
}
