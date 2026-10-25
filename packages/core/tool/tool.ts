import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { JsonSchema } from "@valibot/to-json-schema";
import { Effect } from "effect";
import * as v from "valibot";
import { attempt, run } from "../effect/effect";
import { schemaJsonSchema } from "../schema/json";

export interface ToolContext {
  cwd: string;
}

export interface ToolResult<D = unknown> {
  content: CallToolResult["content"];
  details?: D | undefined;
  isError?: boolean | undefined;
  structuredContent?: Record<string, unknown> | undefined;
  _meta?: Record<string, unknown> | undefined;
}
export type Approval = "read" | "write" | "exec";
export interface ToolMetadata<S extends v.GenericSchema> {
  name: string;
  label: string;
  description: string;
  parameters: S;
  loadMode?: "essential" | "discoverable";
  approval?: Approval | ((input: unknown) => Approval);
  strict?: boolean;
  mcpServerName?: string;
  mcpToolName?: string;
  beforeParse?: (input: unknown) => void;
}
export interface Invocation<C extends ToolContext, R extends ToolResult = ToolResult> {
  id: string;
  context: C;
  signal?: AbortSignal | undefined;
  update?: ((result: R) => void) | undefined;
}
export type ToolExecution<
  T,
  C extends ToolContext,
  R extends ToolResult = ToolResult,
> = (input: T, invocation: Invocation<C, NoInfer<R>>) => Promise<R>;
export type EffectToolExecution<
  T,
  C extends ToolContext,
  R extends ToolResult = ToolResult,
> = (input: T, invocation: Invocation<C, NoInfer<R>>) => Effect.Effect<R, unknown>;
export interface CompiledTool<
  C extends ToolContext = ToolContext,
  R extends ToolResult = ToolResult,
> extends Omit<ToolMetadata<v.GenericSchema>, "parameters" | "beforeParse"> {
  parameters: JsonSchema;
  execute: ToolExecution<unknown, C, R>;
  executeEffect: EffectToolExecution<unknown, C, R>;
}

// Bind a host context without erasing schema output or result inference
// Annotate handler results when progress callbacks would make inference circular
export type SchemaToolCompiler<C extends ToolContext> = <
  S extends v.GenericSchema,
  R extends ToolResult,
>(
  definition: ToolMetadata<S> & { execute: ToolExecution<v.InferOutput<S>, C, R> },
) => CompiledTool<C, R>;

// Validation and defaults run for every adapter, even when a host skips validation
export function compileSchemaTool<
  S extends v.GenericSchema,
  C extends ToolContext,
  R extends ToolResult,
>(
  definition: ToolMetadata<S> & { execute: ToolExecution<v.InferOutput<S>, C, R> },
): CompiledTool<C, R> {
  const { execute, ...metadata } = definition;
  return compileEffectTool({
    ...metadata,
    execute: (input, invocation) =>
      attempt((signal) => execute(input, { ...invocation, signal }), {
        awaitOnInterrupt: true,
      }),
  });
}

// Effect callers own the fiber's cancellation; Promise adapters supply its signal
export function compileEffectTool<
  S extends v.GenericSchema,
  C extends ToolContext,
  R extends ToolResult,
>(
  definition: ToolMetadata<S> & {
    execute: EffectToolExecution<v.InferOutput<S>, C, R>;
  },
): CompiledTool<C, R> {
  const { parameters, execute, beforeParse, ...metadata } = definition;
  const executeEffect: EffectToolExecution<unknown, C, R> = (input, invocation) =>
    Effect.gen(function* () {
      const parsed = yield* Effect.try({
        try: () => parseSchemaInput(parameters, input, beforeParse),
        catch: (error) => error,
      });
      return yield* execute(parsed, invocation);
    });
  return {
    strict: false,
    ...metadata,
    parameters: schemaJsonSchema(parameters),
    executeEffect,
    execute(input, invocation) {
      return run(executeEffect(input, invocation), invocation.signal);
    },
  };
}

export function parseSchemaInput<S extends v.GenericSchema>(
  parameters: S,
  input: unknown,
  beforeParse?: (input: unknown) => void,
): v.InferOutput<S> {
  beforeParse?.(input);
  return v.parse(parameters, input);
}
