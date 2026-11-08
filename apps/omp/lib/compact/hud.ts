import { Text, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { node, text } from "@oh-my-pi/pi-tui/native/describe";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { styledSpans } from "@oh-my-pi/pi-tui/native/spans";
import type { ObservableSession } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { theme } from "@oh-my-pi/pi-tui/theme";
import type { TspChecklistPhase } from "@oh-my-pi/pi-wire";
import type { TodoSummary } from "../todo/summary";

/** One responsive overview row, with details yielding space to counts and hints */
export class CompactHudComponent extends Text {
  readonly #native: NativeNode;

  constructor(
    heads: readonly string[],
    detail: string | undefined,
    hints: readonly string[],
  ) {
    super(heads[0] ?? "", 0, 0);
    const narrowHint = hints.at(-1) ?? "";
    this.#native = text(
      styledSpans([heads[0], detail, hints[0]].filter(Boolean).join(" · ")),
      { wrap: "none", truncate: "end", lines: 1 },
    );
    this.setWrapLine((_line, width) => {
      const available = Math.max(0, width - 2);
      const headBudget = Math.max(
        0,
        available - (narrowHint ? visibleWidth(narrowHint) + 3 : 0),
      );
      const selectedHead =
        heads.find((head) => visibleWidth(head) <= headBudget) ?? heads.at(-1) ?? "";
      // Prefer readable current work over a verbose shortcut label
      const detailReserve = detail ? Math.min(16, visibleWidth(detail)) + 3 : 0;
      const fits = (hint: string, reserve: number) =>
        visibleWidth(selectedHead) + visibleWidth(hint) + (hint ? 3 : 0) + reserve <=
        available;
      const hint =
        hints.find((hint) => fits(hint, detailReserve)) ??
        hints.find((hint) => fits(hint, 0)) ??
        narrowHint;
      const tail = hint
        ? truncateToWidth(theme.fg("dim", ` · ${hint}`), available)
        : "";
      const head = truncateToWidth(
        selectedHead,
        Math.max(0, available - visibleWidth(tail)),
      );
      const detailBudget = Math.max(
        0,
        available - visibleWidth(head) - visibleWidth(tail) - 3,
      );
      const current =
        detail && detailBudget > 3 ? ` · ${truncateToWidth(detail, detailBudget)}` : "";
      return [` ${head}${current}${tail}`];
    });
  }

  override describe(): NativeNode {
    return this.#native;
  }

  override render(width: number): readonly string[] {
    return width > 1 ? super.render(width) : [""];
  }
}

/** Share one compact todo presentation between ANSI and native terminals */
export function compactTodoHud(
  summary: TodoSummary,
  phases: TspChecklistPhase[],
  agents: CompactSubagentState | undefined,
  hubKey: string,
) {
  const progress = `${summary.closed}/${summary.total}`;
  const head = [
    `${theme.bold(theme.fg("accent", "TODO"))} ${progress}`,
    ...(summary.blocked > 0 ? [theme.fg("warning", `${summary.blocked} blocked`)] : []),
  ].join(" · ");
  const smallHead = `${progress}${summary.blocked > 0 ? ` ${summary.blocked}blocked` : ""}`;
  const agentHint = agents && hubKey ? `${hubKey} agents` : "";
  const hints = [
    ["/todo expand", agentHint].filter(Boolean).join(" · "),
    ["/todo", agents ? hubKey : ""].filter(Boolean).join(" · "),
    agents && hubKey ? hubKey : "/todo",
  ];
  const heads = agents
    ? [
        `${head} · ${agents.full}`,
        `${head} · ${agents.compact}`,
        `${smallHead} ${agents.essential}`,
        agents.essential,
      ]
    : [head, smallHead];
  const component = new CompactHudComponent(heads, summary.current, hints);
  return {
    component,
    native: {
      checklist: node(
        "checklist",
        { phases, mode: "hud", role: "omp.hud.todo" },
        undefined,
        "todo",
      ),
      fallback: component.describe(),
    },
  };
}

export interface CompactSubagentState {
  full: string;
  compact: string;
  essential: string;
}

/** Keep lifecycle failures and interactive waits visible without listing agents */
export function compactSubagentState(
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
  const alerts: string[] = [];
  const essential: string[] = [];
  if (failed) {
    alerts.push(theme.fg("error", `${failed} failed`));
    essential.push(theme.fg("error", `${failed}fail`));
  }
  if (input) {
    alerts.push(theme.fg("warning", `${input} input`));
    essential.push(theme.fg("warning", `${input}input`));
  }
  const optional: string[] = [];
  if (waiting) optional.push(theme.fg("warning", `${waiting} retrying`));
  if (stopped) optional.push(`${stopped} stopped`);
  if (completed) optional.push(`${completed} done`);
  const label = theme.fg("accent", "Agents");
  return {
    full: [`${label} ${running} running`, ...alerts, ...optional].join(" · "),
    compact: [`${label} ${running}`, ...essential].join(" "),
    essential:
      essential.length > 0
        ? essential.join(" ")
        : running > 0
          ? `${running} active`
          : stopped > 0
            ? `${stopped} stopped`
            : `${completed} done`,
  };
}

export function compactSubagentHud(
  sessions: readonly ObservableSession[],
  key: string,
): CompactHudComponent | undefined {
  const state = compactSubagentState(sessions);
  return state
    ? new CompactHudComponent([state.full, state.compact, state.essential], undefined, [
        key ? `${key} agents` : "",
        key,
      ])
    : undefined;
}
