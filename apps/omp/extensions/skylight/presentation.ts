import type { AgentToolResult, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { plainToolCard, type ToolCardSnapshot } from "@oh-my-pi/pi-tui/render";
import {
  describeMCPResult,
  type MCPToolDetails,
  renderMCPResult,
} from "@oh-my-pi/pi-tui/tools/mcp";
import { formatCount, isRecord } from "@oh-my-pi/pi-utils";
import type { Guide } from "farstep/skylight/guides/guides";

interface SkylightDetails extends MCPToolDetails {
  topic?: Guide;
}

function outputMeta(result: AgentToolResult<SkylightDetails>): string[] {
  const meta = result.details?.mcpMeta;
  const surface = meta?.["codex/toolSurface"];
  const duration = meta?.["codex/nodeReplExecutionDurationMs"];
  const screenshots = result.content.reduce(
    (count, item) => count + Number(item.type === "image"),
    0,
  );
  const parts: string[] = [];
  if (
    isRecord(surface) &&
    isRecord(surface.app) &&
    typeof surface.app.appId === "string"
  ) {
    parts.push(surface.app.appId);
  }
  if (typeof duration === "number" && Number.isFinite(duration))
    parts.push(`${Math.round(duration)} ms`);
  if (screenshots) parts.push(formatCount("screenshot", screenshots));
  return parts;
}

type SkylightPresentation = Pick<
  ToolDefinition<Record<string, unknown>, SkylightDetails>,
  "label" | "renderCall" | "renderResult" | "describeCall" | "describeResult"
>;

export function skylightPresentation(
  label: string,
  target: (input: unknown) => string,
): SkylightPresentation {
  return {
    label,
    renderCall: (args, options, theme) => {
      const snapshot = {
        applyBg: false,
        status: {
          ...(options.isPartial ? { icon: "pending" } : {}),
          title: label,
          description: target(args),
        },
      } satisfies ToolCardSnapshot;
      return plainToolCard(theme, () => snapshot);
    },
    renderResult: (result, options, theme, args) =>
      renderMCPResult(result, options, theme, isRecord(args) ? args : undefined),
    describeCall: (args) => ({
      tool: { title: label, target: target(args) },
    }),
    describeResult: (result, options, args) => {
      const view = describeMCPResult(
        result,
        options,
        isRecord(args) ? args : undefined,
      );
      return {
        ...view,
        tool: { title: label, meta: outputMeta(result) },
      };
    },
  };
}
