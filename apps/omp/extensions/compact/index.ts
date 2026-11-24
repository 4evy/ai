import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  getLiveHudTodoDescriptions,
  setLiveHudRenderer,
} from "@oh-my-pi/pi-tui/chrome/live-hud";
import { TruncatedText } from "@oh-my-pi/pi-tui/components/truncated-text";
import { node } from "@oh-my-pi/pi-tui/native/describe";
import { OwnerMemo } from "@oh-my-pi/pi-tui/native/memo";
import { renderStatusLine } from "@oh-my-pi/pi-tui/render";
import { setStatusLinePresentation } from "@oh-my-pi/pi-tui/status-line/presentation";
import { toolRenderers } from "@oh-my-pi/pi-tui/tools";
import { createEvalRenderer } from "@oh-my-pi/pi-tui/tools/eval";
import type { NativeToolView } from "@oh-my-pi/pi-tui/tools/renderer";
import {
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
import { installCompactRibbon } from "../../lib/compact/ribbon";
import { checklistWithNotes, summarizeTodos } from "../../lib/todo/summary";

const nativeTodo = new OwnerMemo<NativeToolView | undefined>();

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
    const descriptions = getLiveHudTodoDescriptions();
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
    return nativeTodo.get(result, [options.expanded], () => {
      if (result.isError) return todoToolRenderer.describeResult(result, options);
      const phases = (result.details?.phases ?? []).filter(
        (phase) => phase.tasks.length > 0,
      );
      if (phases.length === 0) return todoToolRenderer.describeResult(result, options);
      const { closed, total } = summarizeTodos(phases);
      const tool = {
        title: "Todo",
        target: `${closed}/${total}`,
        targetKind: "text",
      } as const;
      if (!options.expanded) return { tool, preview: "none", open: false };
      return {
        tool,
        body: [
          node(
            "checklist",
            { mode: "full", phases: checklistWithNotes(phases) },
            [],
            "checklist",
          ),
        ],
        preview: "none",
        open: true,
      };
    });
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
  installCompactRibbon();
  installCompactRendererPolicies();
  toolRenderers.todo = compactTodoRenderer;
  toolRenderers.eval = compactEvalRenderer;
  toolRenderers["tool-command:queued"] = queuedScriptRenderer;
}
