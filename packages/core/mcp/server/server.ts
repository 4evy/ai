import type { Transform } from "node:stream";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { Effect } from "effect";
import * as v from "valibot";
import {
  attempt,
  type Lifetime,
  operationEffect,
  run,
  traceParent,
} from "../../effect/effect";
import { errorMessage } from "../../error/error";
import { schemaJsonSchema } from "../../schema/json";

export const serveStdioEffect = Effect.fnUntraced(function* (
  server: Server,
  bounded: Transform,
  wait: () => Promise<void>,
  close: () => void,
) {
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      close();
      process.stdin.unpipe(bounded);
      process.stdin.off("end", close);
      process.stdin.off("error", close);
      bounded.off("error", close);
    }),
  );
  yield* Effect.sync(() => {
    bounded.on("error", close);
    process.stdin.on("end", close);
    process.stdin.on("error", close);
    process.stdin.pipe(bounded);
  });
  yield* attempt(
    () => server.connect(new StdioServerTransport(bounded, process.stdout)),
    { awaitOnInterrupt: true },
  );
  yield* attempt(wait);
}, Effect.scoped);

export function serveStdio(
  server: Server,
  bounded: Transform,
  wait: () => Promise<void>,
  close: () => void,
): Promise<void> {
  return run(serveStdioEffect(server, bounded, wait, close));
}

type ToolOptions<S extends v.GenericSchema> = { inputSchema: S; description?: string };
type ToolHandler<S extends v.GenericSchema> = (
  input: v.InferOutput<S>,
  signal: AbortSignal,
) => Promise<CallToolResult>;

export type ToolRegistrar = <S extends v.GenericSchema>(
  name: string,
  options: ToolOptions<S>,
  handler: ToolHandler<S>,
) => void;

export function guardTools(register: ToolRegistrar, guard: () => void): ToolRegistrar {
  return <S extends v.GenericSchema>(
    name: string,
    options: ToolOptions<S>,
    handler: ToolHandler<S>,
  ) =>
    register(name, options, async (input, signal) => {
      guard();
      return handler(input, signal);
    });
}

/**
 * List tools with JSON Schema, but parse arguments with native Valibot before
 * calling handlers; validation and handler failures stay MCP tool error results
 */
export function toolRegistry(
  server: Server,
  lifetime: Lifetime,
  operation = { name: "mcp.handle", component: "mcp" },
): ToolRegistrar {
  const tools = new Map<
    string,
    {
      definition: Tool;
      call: (input: unknown, signal: AbortSignal) => Promise<CallToolResult>;
    }
  >();
  server.registerCapabilities({ tools: { listChanged: true } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools
      .values()
      .map(({ definition }) => definition)
      .toArray(),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const tool = tools.get(request.params.name);
      if (!tool)
        throw new McpError(
          ErrorCode.InvalidParams,
          `Tool ${request.params.name} not found`,
        );
      const effect = operationEffect(
        operation.name,
        { component: operation.component, method: request.params.name },
        attempt((signal) => tool.call(request.params.arguments ?? {}, signal), {
          awaitOnInterrupt: true,
        }),
      );
      const parent = traceParent(request.params._meta);
      return await lifetime.run(
        parent ? Effect.withParentSpan(effect, parent) : effect,
        extra.signal,
      );
    } catch (error) {
      if (error instanceof McpError && error.code === ErrorCode.UrlElicitationRequired)
        throw error;
      return {
        content: [
          {
            type: "text",
            text: errorMessage(error),
          },
        ],
        isError: true,
      };
    }
  });
  return function registerTool<S extends v.GenericSchema>(
    name: string,
    options: ToolOptions<S>,
    handler: ToolHandler<S>,
  ): void {
    const inputSchema = schemaJsonSchema(options.inputSchema);
    if (inputSchema.type !== "object")
      throw new Error(`Tool ${name} must have an object input schema`);
    // Object conversion is checked above; SDK types narrow JSON Schema keywords
    const mcpInputSchema = inputSchema as Tool["inputSchema"];
    tools.set(name, {
      definition: {
        name,
        description: options.description,
        inputSchema: mcpInputSchema,
      },
      async call(input, signal) {
        const parsed = v.safeParse(options.inputSchema, input);
        if (!parsed.success)
          throw new McpError(
            ErrorCode.InvalidParams,
            `Input validation error: Invalid arguments for tool ${name}: ${JSON.stringify(v.flatten(parsed.issues), null, 2)}`,
          );
        return handler(parsed.output, signal);
      },
    });
  };
}
