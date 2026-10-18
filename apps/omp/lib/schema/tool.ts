import { schemaJsonSchema } from "@ai/core/schema/json";
import { parseSchemaInput } from "@ai/core/tool/tool";
import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type * as v from "valibot";

// OMP's static marker types handlers without constructing a runtime schema
export type SchemaToolDefinition<S extends v.GenericSchema, D = unknown> = Omit<
  ToolDefinition<{ static: v.InferOutput<S> }, D>,
  "parameters"
> & { parameters: S; beforeParse?: (input: unknown) => void };

// OMP validates the wire schema. Valibot applies defaults and refinements before
// execution, including calls that bypass OMP's validator
export function registerSchemaTool<S extends v.GenericSchema, D = unknown>(
  api: ExtensionAPI,
  definition: SchemaToolDefinition<S, D>,
): void {
  const { parameters, execute, beforeParse, ...presentation } = definition;
  api.registerTool({
    // Keep optional fields optional in provider schemas. Valibot validates input
    strict: false,
    ...presentation,
    parameters: { ...schemaJsonSchema(parameters) },
    execute(id, input, signal, update, ctx) {
      return execute(
        id,
        parseSchemaInput(parameters, input, beforeParse),
        signal,
        update,
        ctx,
      );
    },
  });
}
