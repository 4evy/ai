import { code } from "@oh-my-pi/pi-tui/native/describe";
import { plainToolCard, renderStatusLine } from "@oh-my-pi/pi-tui/render";
import { formatExpandHint } from "@oh-my-pi/pi-tui/render/render-utils";
import type { ToolRenderer } from "@oh-my-pi/pi-tui/tools/renderer";
import type { XdevQueuedArgs } from "@oh-my-pi/pi-tui/tools/xdev";

/** Keep queued scripts about the operation until their arguments are expanded */
function operation({ label, args }: XdevQueuedArgs) {
  if (typeof args.script !== "string" && !Array.isArray(args.steps)) return undefined;
  const title =
    typeof args.name === "string" && args.name.trim() ? args.name.trim() : label;
  const target =
    typeof args.target === "string" && args.target !== "local"
      ? `SSH · ${args.target}`
      : "Local";
  return { title, detail: `Queued · ${label} · ${target}` };
}

export const queuedScriptRenderer = {
  renderCall(args, options, theme) {
    const summary = operation(args);
    if (!summary) return undefined;
    let source: string[] | undefined;
    return plainToolCard(theme, () => {
      let content: string[];
      if (options.expanded) {
        source ??= JSON.stringify(args.args, null, 2).split("\n");
        content = source;
      } else {
        content = [
          theme.fg("dim", `Arguments ${formatExpandHint(theme, false, true)}`),
        ];
      }
      return {
        header: renderStatusLine(
          {
            icon: "pending",
            title: summary.title,
            description: summary.detail,
          },
          theme,
        ),
        phase: "pending",
        sections: [{ content }],
      };
    });
  },
  renderResult() {
    return undefined;
  },
  describeCall(args) {
    const summary = operation(args);
    if (!summary) return undefined;
    return {
      tool: { title: summary.title, target: summary.detail, targetKind: "text" },
      body: [
        code(JSON.stringify(args.args, null, 2), {
          lang: "json",
          preview: { lines: 0 },
        }),
      ],
      preview: "children",
    };
  },
} satisfies ToolRenderer<XdevQueuedArgs>;
