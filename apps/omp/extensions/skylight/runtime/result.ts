import { isRecord } from "@ai/core/value/value";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AgentToolResult } from "@oh-my-pi/pi-coding-agent";
import { buildMCPToolResult } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { MCPToolDetails } from "@oh-my-pi/pi-tui/tools/mcp";

const MCP_SERVER_NAME = "farstep-sky";

export function present(
  result: Pick<
    CallToolResult,
    "content" | "isError" | "structuredContent" | "_meta"
  > & {
    details?: unknown;
  },
  toolName: string,
): AgentToolResult<MCPToolDetails> {
  const details = result.details ?? {};
  const native = buildMCPToolResult(
    {
      ...(result.isError === undefined ? {} : { isError: result.isError }),
      ...(result.structuredContent === undefined
        ? {}
        : { structuredContent: result.structuredContent }),
      ...(result._meta === undefined ? {} : { _meta: result._meta }),
      // OMP handles text, images and embedded resources; preserve other MCP
      // blocks as JSON until its content model supports them
      content: result.content.map((item) => {
        if (item.type === "text" || item.type === "image") return item;
        if (item.type === "resource") {
          const { mimeType, ...resource } = item.resource;
          return {
            ...item,
            resource: {
              ...resource,
              ...(mimeType === undefined ? {} : { mimeType }),
            },
          };
        }
        return { type: "text" as const, text: JSON.stringify(item) };
      }),
    },
    MCP_SERVER_NAME,
    toolName,
  );
  return {
    ...native,
    details: {
      ...(isRecord(details) ? details : { value: details }),
      ...native.details,
      serverName: MCP_SERVER_NAME,
      mcpToolName: toolName,
    },
  };
}
