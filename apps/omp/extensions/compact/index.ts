import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { todoMatchesAnyDescription } from "@oh-my-pi/pi-coding-agent/tools/details/todo";
import {
  getLiveHudTodoDescriptions,
  setLiveHudRenderer,
} from "@oh-my-pi/pi-coding-agent/ui/dock/live-hud";
import { setStatusLinePresentation } from "@oh-my-pi/pi-coding-agent/ui/status/presentation";
import { createEvalRenderer } from "@oh-my-pi/pi-coding-agent/ui/tools/eval";
import { registerToolPresenter } from "@oh-my-pi/pi-coding-agent/ui/tools/registry";
import { todoPresenter } from "@oh-my-pi/pi-coding-agent/ui/tools/todo";
import { compactStatusLine } from "../../lib/compact/billing";
import { compactEvalHistory } from "../../lib/compact/eval-history";
import { compactLiveHudRenderer } from "../../lib/compact/hud";
import { queuedScriptRenderer } from "../../lib/compact/queued-script";
import {
  compactEvalPresentation,
  installCompactRendererPolicies,
} from "../../lib/compact/renderers";
import { installCompactRibbon } from "../../lib/compact/ribbon";
import { summarizeTodos } from "../../lib/todo/summary";

const compactTodoPresenter: typeof todoPresenter = {
  ...todoPresenter,
  result(result, state, args) {
    const stock = todoPresenter.result?.(result, state, args);
    if (state.expanded || result.isError) return stock;
    const phases = result.details?.phases;
    if (!phases?.some((phase) => phase.tasks.length > 0)) return stock;
    const descriptions = getLiveHudTodoDescriptions();
    const summary = summarizeTodos(phases, (task) =>
      todoMatchesAnyDescription(task.content, descriptions),
    );
    const progress = `${summary.closed}/${summary.total}`;
    return {
      ...stock,
      open: false,
      term: {
        compactSummary: `${progress} done${summary.current ? ` · ${summary.current}` : ""}`,
        margin: false,
      },
    };
  },
};

const compactEvalRenderer = createEvalRenderer(
  compactEvalHistory,
  compactEvalPresentation,
);

export default function compact(_api: ExtensionAPI) {
  // Host registries are process-wide, just like the replaced policy
  setStatusLinePresentation(compactStatusLine);
  setLiveHudRenderer(compactLiveHudRenderer);
  installCompactRibbon();
  installCompactRendererPolicies();
  registerToolPresenter("todo", compactTodoPresenter);
  registerToolPresenter("eval", compactEvalRenderer);
  registerToolPresenter("tool-command:queued", queuedScriptRenderer);
}
