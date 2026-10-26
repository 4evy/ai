import { plainToolCard } from "@oh-my-pi/pi-tui/render";
import { describeMCPResult, renderMCPResult } from "@oh-my-pi/pi-tui/tools/mcp";
import type { ToolRenderer, ToolRenderResult } from "@oh-my-pi/pi-tui/tools/renderer";
import { isRecord } from "@oh-my-pi/pi-utils";

// Use OMP's bounded, expandable JSON trees instead of serialized payloads
// Content and details remain untouched for the model and persisted history
export function farstepPresentation(title: string) {
  const target = (input: unknown): string => {
    if (!isRecord(input)) return "";
    return [input.action, input.target ?? input.connection, input.path]
      .filter((value): value is string => typeof value === "string")
      .join(" · ");
  };
  const viewResult = (result: ToolRenderResult<unknown>) => ({
    ...result,
    details: { serverName: "Farstep", mcpToolName: title },
  });
  return {
    renderCall: (args, options, theme) =>
      plainToolCard(theme, () => ({
        status: {
          icon: options.isPartial ? "running" : "pending",
          ...(options.spinnerFrame === undefined
            ? {}
            : { spinnerFrame: options.spinnerFrame }),
          title,
          description: target(args),
        },
        applyBg: false,
      })),
    renderResult: (result, options, theme) =>
      renderMCPResult(viewResult(result), options, theme),
    describeCall: (args) => ({ tool: { title, target: target(args) } }),
    describeResult: (result, options, args) => ({
      ...describeMCPResult(viewResult(result), options),
      tool: { title, target: target(args) },
    }),
  } satisfies ToolRenderer<unknown, unknown>;
}
