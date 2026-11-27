import type { QueuedToolCommandArgs } from "@oh-my-pi/pi-coding-agent/tools/details/tool-commands";
import type { ToolPresenter } from "@oh-my-pi/pi-coding-agent/ui/tools/contract";
import { jsx } from "@oh-my-pi/pi-tui/jsx-runtime";

/** Keep queued scripts about the operation until their arguments are expanded */
function operation({ label, args }: QueuedToolCommandArgs) {
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
  call(args) {
    const summary = operation(args);
    if (!summary) return undefined;
    return {
      head: { title: summary.title, target: summary.detail, targetKind: "text" },
      body: jsx(
        "code",
        {
          text: JSON.stringify(args.args, null, 2),
          lang: "json",
          preview: { lines: 0 },
        },
        "arguments",
      ),
      preview: "children",
    };
  },
} satisfies ToolPresenter<QueuedToolCommandArgs>;
