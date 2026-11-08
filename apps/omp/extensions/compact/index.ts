import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { TruncatedText } from "@oh-my-pi/pi-tui/components/truncated-text";
import { renderStatusLine } from "@oh-my-pi/pi-tui/render";
import { toolRenderers } from "@oh-my-pi/pi-tui/tools";
import { createEvalRenderer } from "@oh-my-pi/pi-tui/tools/eval";
import {
  getActiveTodoDescriptions,
  todoMatchesAnyDescription,
  todoToolRenderer,
} from "@oh-my-pi/pi-tui/tools/todo";
import { compactEvalHistory } from "../../lib/compact/eval-history";
import { installCompactFooterSegments } from "../../lib/compact/footer";
import { queuedScriptRenderer } from "../../lib/compact/queued-script";
import { summarizeTodos } from "../../lib/todo/summary";

const compactTodoRenderer = {
  ...todoToolRenderer,
  renderResult(result, options, theme, args) {
    const phases = result.details?.phases ?? [];
    if (
      result.isError ||
      options.expanded ||
      !phases.some((phase) => phase.tasks.length)
    )
      return todoToolRenderer.renderResult(result, options, theme, args);
    const descriptions = getActiveTodoDescriptions();
    const summary = summarizeTodos(phases, (task) =>
      todoMatchesAnyDescription(task.content, descriptions),
    );
    const meta = [`${summary.closed}/${summary.total} done`];
    if (summary.blocked > 0) meta.push(`${summary.blocked} blocked`);
    if (summary.current) meta.push(summary.current);
    return new TruncatedText(
      renderStatusLine(
        {
          iconOverride: theme.styledSymbol("tool.todo", "accent"),
          title: "Todo",
          meta,
        },
        theme,
      ),
    );
  },
  describeResult(result, options) {
    const summary = summarizeTodos(result.details?.phases ?? []);
    if (result.isError || summary.total === 0 || options.expanded)
      return todoToolRenderer.describeResult(result, options);
    return {
      tool: {
        title: "Todo",
        target: `${summary.closed}/${summary.total}`,
        targetKind: "text",
      },
      preview: "none",
      open: false,
    };
  },
} satisfies typeof todoToolRenderer;

const compactEvalRenderer = createEvalRenderer(compactEvalHistory);

export default function compact(_api: ExtensionAPI) {
  // The public renderer catalog is process-wide, just like the replaced policy
  // Rebinding a child installs the same object, never another wrapper
  installCompactFooterSegments();
  toolRenderers.todo = compactTodoRenderer;
  toolRenderers.eval = compactEvalRenderer;
  toolRenderers["xdev:queued"] = queuedScriptRenderer;
}
