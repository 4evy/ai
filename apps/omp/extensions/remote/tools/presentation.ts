import type { ToolPresenter } from "@oh-my-pi/pi-coding-agent/ui/tools/contract";
import { mcpPresenter } from "@oh-my-pi/pi-coding-agent/ui/tools/mcp";
import { isRecord } from "@oh-my-pi/pi-utils";

// Use OMP's bounded JSON trees and expandable arguments without changing results
export function farstepPresentation(title: string): { presenter: ToolPresenter } {
  const target = (input: unknown): string => {
    if (!isRecord(input)) return "";
    return [input.action, input.target ?? input.connection, input.path]
      .filter((value): value is string => typeof value === "string")
      .join(" · ");
  };
  const mcp = mcpPresenter(title);
  return {
    presenter: {
      merge: true,
      inline: true,
      call(args, state) {
        const view = mcp.call?.(isRecord(args) ? args : {}, state);
        return view && { ...view, head: { ...view.head, title, target: target(args) } };
      },
      result(result, state, args) {
        const view = mcp.result?.(
          { ...result, details: { serverName: "Farstep", mcpToolName: title } },
          state,
          isRecord(args) ? args : undefined,
        );
        return view && { ...view, head: { ...view.head, title, target: target(args) } };
      },
    },
  };
}
