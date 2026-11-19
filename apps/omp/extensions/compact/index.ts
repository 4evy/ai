import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { setLiveHudRenderer } from "@oh-my-pi/pi-tui/chrome/live-hud";
import { TruncatedText } from "@oh-my-pi/pi-tui/components/truncated-text";
import { renderStatusLine } from "@oh-my-pi/pi-tui/render";
import { setStatusLinePresentation } from "@oh-my-pi/pi-tui/status-line/presentation";
import { setThemeRulePolicy } from "@oh-my-pi/pi-tui/theme/rules";
import { toolRenderers } from "@oh-my-pi/pi-tui/tools";
import { createEvalRenderer } from "@oh-my-pi/pi-tui/tools/eval";
import {
  getActiveTodoDescriptions,
  todoMatchesAnyDescription,
  todoToolRenderer,
} from "@oh-my-pi/pi-tui/tools/todo";
import { compactStatusLine } from "../../lib/compact/billing";
import { compactEvalHistory } from "../../lib/compact/eval-history";
import { installCompactFooterSegments } from "../../lib/compact/footer";
import { compactLiveHudRenderer } from "../../lib/compact/hud";
import { queuedScriptRenderer } from "../../lib/compact/queued-script";
import {
  compactEvalPresentation,
  installCompactRendererPolicies,
} from "../../lib/compact/renderers";
import { compactRibbon } from "../../lib/compact/ribbon";
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

const compactEvalRenderer = createEvalRenderer(
  compactEvalHistory,
  compactEvalPresentation,
);

export default function compact(_api: ExtensionAPI) {
  // Host registries are process-wide, just like the replaced policy
  // Rebinding a child installs the same objects, never another wrapper
  installCompactFooterSegments();
  setStatusLinePresentation(compactStatusLine);
  setLiveHudRenderer(compactLiveHudRenderer);
  setThemeRulePolicy(compactRibbon);
  installCompactRendererPolicies();
  toolRenderers.todo = compactTodoRenderer;
  toolRenderers.eval = compactEvalRenderer;
  toolRenderers["xdev:queued"] = queuedScriptRenderer;
}
