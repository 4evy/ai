import {
  type CompiledTool,
  compileSchemaTool,
  type SchemaToolCompiler,
  type ToolResult,
} from "@ai/core/tool/tool";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";

export const compileTool: SchemaToolCompiler<ExtensionContext> = compileSchemaTool;

type ToolPresentation<D> = Omit<
  ToolDefinition<Record<string, unknown>, D>,
  keyof CompiledTool | "execute"
>;

export function registerCompiledTool<R extends ToolResult, D>(
  api: ExtensionAPI,
  ...registration:
    | [
        tool: CompiledTool<ExtensionContext, AgentToolResult<D>>,
        presentation?: ToolPresentation<D>,
      ]
    | [
        tool: CompiledTool<ExtensionContext, R>,
        presentation: ToolPresentation<D>,
        mapResult: (result: R) => AgentToolResult<D>,
      ]
): void {
  if (registration.length === 3) {
    const [tool, presentation, mapResult] = registration;
    registerInvocation(api, tool, presentation, mapResult, (result) =>
      result.then(mapResult),
    );
  } else {
    const [tool, presentation = {}] = registration;
    registerInvocation(
      api,
      tool,
      presentation,
      (result) => result,
      (result) => result,
    );
  }
}

// Keep the native Promise untouched. MCP mappings apply identically to progress
// and completion, while the core executor owns parsing and cancellation
function registerInvocation<R extends ToolResult, D>(
  api: ExtensionAPI,
  tool: CompiledTool<ExtensionContext, R>,
  presentation: ToolPresentation<D>,
  mapUpdate: (result: R) => AgentToolResult<D>,
  mapCompletion: (result: Promise<R>) => Promise<AgentToolResult<D>>,
): void {
  const { execute, executeEffect: _executeEffect, ...metadata } = tool;
  api.registerTool({
    ...metadata,
    ...presentation,
    parameters: { ...tool.parameters },
    execute(id, input, signal, update, context) {
      return mapCompletion(
        execute(input, {
          id,
          signal,
          context,
          update: update ? (result) => update(mapUpdate(result)) : undefined,
        }),
      );
    },
  });
}
