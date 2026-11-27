import type { ObservableSession } from "@oh-my-pi/pi-coding-agent/task/session-observer-registry";
import { todoMatchesAnyDescription } from "@oh-my-pi/pi-coding-agent/tools/details/todo";
import type { LiveHudRenderer } from "@oh-my-pi/pi-coding-agent/ui/dock/live-hud";
import { jsx } from "@oh-my-pi/pi-tui/jsx-runtime";
import { defineRolePainter, EMPTY_BLOCK } from "@oh-my-pi/pi-tui/term/paint";
import { styledText } from "@oh-my-pi/pi-tui/term/painters/layout";
import { truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { TspChecklistPhase, TspSpan } from "@oh-my-pi/pi-wire";
import { checklistWithNotes, summarizeTodos, type TodoSummary } from "../todo/summary";

interface CompactHudLook {
  readonly heads: readonly (readonly TspSpan[])[];
  readonly detail?: string;
  readonly hints: readonly string[];
}

const ROLE = "omp.hud.compact-overview";
const DOT = { t: " · ", s: "dim" };

/** A shared overview node; the ANSI painter measures its responsive variants */
function compactHud({ heads, detail, hints }: CompactHudLook) {
  const spans = [...(heads[0] ?? [])];
  if (detail) spans.push(DOT, { t: detail });
  const hint = hints[0];
  if (hint) spans.push(DOT, { t: hint, s: "dim" });
  return jsx("text", {
    spans,
    wrap: "none",
    truncate: "end",
    lines: 1,
    term: { role: ROLE, heads, detail, hints },
  });
}

defineRolePainter("text", ROLE, (node, cx) => {
  if (cx.width <= 1) return EMPTY_BLOCK;
  const props = node.props() as { term?: CompactHudLook };
  if (!props.term) return EMPTY_BLOCK;
  const { heads, detail, hints } = props.term;
  const available = cx.width - 2;
  const narrowHint = hints.at(-1) ?? "";
  const headBudget = Math.max(
    0,
    available - (narrowHint ? visibleWidth(narrowHint) + 3 : 0),
  );
  const selected =
    heads.find(
      (spans) =>
        spans.reduce((width, span) => width + visibleWidth(span.t), 0) <= headBudget,
    ) ?? heads.at(-1);
  const selectedHead = styledText(cx.theme, selected);
  const detailReserve = detail ? Math.min(16, visibleWidth(detail)) + 3 : 0;
  const headWidth = visibleWidth(selectedHead);
  const fits = (hint: string, reserve: number) =>
    headWidth + visibleWidth(hint) + (hint ? 3 : 0) + reserve <= available;
  const hint =
    hints.find((hint) => fits(hint, detailReserve)) ??
    hints.find((hint) => fits(hint, 0)) ??
    narrowHint;
  const tail = hint ? truncate(cx.theme.fg("dim", ` · ${hint}`), available) : "";
  const tailWidth = visibleWidth(tail);
  const head = truncate(selectedHead, Math.max(0, available - tailWidth));
  const detailBudget = Math.max(0, available - visibleWidth(head) - tailWidth - 3);
  const current =
    detail && detailBudget > 3 ? ` · ${truncate(detail, detailBudget)}` : "";
  return { rows: [` ${head}${current}${tail}`] };
});

/** A collapsed plan has a responsive fallback and a native checklist pill */
function compactTodoHud(
  summary: TodoSummary,
  phases: TspChecklistPhase[],
  agents: CompactSubagentState | undefined,
  hubKey: string,
) {
  const progress = { t: `${summary.closed}/${summary.total}` };
  const head = [{ t: "TODO ", s: "accent strong" }, progress];
  const agentHint = agents && hubKey ? `${hubKey} agents` : "";
  const hints = [
    ["/todo expand", agentHint].filter(Boolean).join(" · "),
    ["/todo", agents ? hubKey : ""].filter(Boolean).join(" · "),
    agents && hubKey ? hubKey : "/todo",
  ];
  const heads = agents
    ? [
        [...head, DOT, ...agents.full],
        [...head, DOT, ...agents.compact],
        [{ t: `${progress.t} ` }, ...agents.essential],
        agents.essential,
      ]
    : [head, [progress]];
  return {
    todo: compactHud({
      heads,
      ...(summary.current === undefined ? {} : { detail: summary.current }),
      hints,
    }),
    checklist: jsx("checklist", { phases, mode: "hud", role: "omp.hud.todo" }, "todo"),
  };
}

interface CompactSubagentState {
  full: TspSpan[];
  compact: TspSpan[];
  essential: TspSpan[];
}

/** Keep lifecycle failures and interactive waits visible without listing agents */
function compactSubagentState(
  sessions: readonly ObservableSession[],
): CompactSubagentState | undefined {
  let running = 0;
  let completed = 0;
  let failed = 0;
  let stopped = 0;
  let input = 0;
  let waiting = 0;
  for (const session of sessions) {
    if (session.kind !== "subagent") continue;
    if (session.status === "failed") failed++;
    else if (session.status === "aborted") stopped++;
    else if (session.status === "completed") completed++;
    else {
      running++;
      if (session.progress?.currentTool === "ask") input++;
      if (session.progress?.retryState) waiting++;
    }
  }
  if (running + completed + failed + stopped === 0) return undefined;
  // Alerts outlive optional lifecycle counters when the row runs out of room
  const full: TspSpan[] = [{ t: "Agents", s: "accent" }, { t: ` ${running} running` }];
  const compact: TspSpan[] = [{ t: "Agents", s: "accent" }, { t: ` ${running}` }];
  const essential: TspSpan[] = [];
  if (failed) {
    full.push(DOT, { t: `${failed} failed`, s: "error" });
    essential.push({ t: `${failed}fail`, s: "error" });
  }
  if (input) {
    full.push(DOT, { t: `${input} input`, s: "warning" });
    if (essential.length > 0) essential.push({ t: " " });
    essential.push({ t: `${input}input`, s: "warning" });
  }
  if (waiting) full.push(DOT, { t: `${waiting} retrying`, s: "warning" });
  if (stopped) full.push(DOT, { t: `${stopped} stopped` });
  if (completed) full.push(DOT, { t: `${completed} done` });
  if (essential.length > 0) compact.push({ t: " " }, ...essential);
  else
    essential.push({
      t:
        running > 0
          ? `${running} active`
          : stopped > 0
            ? `${stopped} stopped`
            : `${completed} done`,
    });
  return { full, compact, essential };
}

/** Compact policy installed by the extension, with host-owned state and lifetime */
export const compactLiveHudRenderer: LiveHudRenderer = {
  showWorkingTitle: false,
  compactTodoInStatus: false,
  render(state) {
    const summarizeAgents = state.agentsMode !== "off" && !state.agentsExpanded;
    const agents = summarizeAgents ? compactSubagentState(state.sessions) : undefined;
    const hubKey = state.agentsHubKey;
    const phases =
      state.todoHidden || state.todoExpanded
        ? []
        : state.phases.filter((phase) => phase.tasks.length > 0);
    if (phases.length > 0) {
      const isMatched = (todo: { content: string }) =>
        state.activeDescriptions.length > 0 &&
        todoMatchesAnyDescription(todo.content, state.activeDescriptions);
      return {
        ...compactTodoHud(
          summarizeTodos(phases, isMatched),
          checklistWithNotes(phases, isMatched),
          agents,
          hubKey,
        ),
        ...(summarizeAgents && { subagents: null }),
      };
    }
    if (!summarizeAgents) return undefined;
    return {
      subagents: agents
        ? (compactHud({
            heads: [agents.full, agents.compact, agents.essential],
            hints: [hubKey ? `${hubKey} agents` : "", hubKey],
          }) ?? null)
        : null,
    };
  },
};
