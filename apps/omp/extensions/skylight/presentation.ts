import type { MCPToolDetails } from "@oh-my-pi/pi-coding-agent/tools/details/mcp";
import type {
  ToolPresenter,
  ToolResult,
} from "@oh-my-pi/pi-coding-agent/ui/tools/contract";
import { mcpPresenter } from "@oh-my-pi/pi-coding-agent/ui/tools/mcp";
import { formatCount, isRecord } from "@oh-my-pi/pi-utils";

function outputMeta(result: ToolResult<MCPToolDetails>): string[] {
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

export function skylightPresentation(
  title: string,
  target: (input: unknown) => string,
): { label: string; presenter: ToolPresenter<unknown, MCPToolDetails> } {
  const mcp = mcpPresenter(title);
  return {
    label: title,
    presenter: {
      merge: true,
      inline: true,
      call(args, state) {
        const view = mcp.call?.(isRecord(args) ? args : {}, state);
        return view && { ...view, head: { ...view.head, title, target: target(args) } };
      },
      result(result, state, args) {
        const view = mcp.result?.(result, state, isRecord(args) ? args : undefined);
        return (
          view && {
            ...view,
            head: {
              ...view.head,
              title,
              target: target(args),
              meta: outputMeta(result),
            },
          }
        );
      },
    },
  };
}
