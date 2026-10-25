import { Text, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { text } from "@oh-my-pi/pi-tui/native/describe";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { styledSpans } from "@oh-my-pi/pi-tui/native/spans";
import type { ObservableSession } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { theme } from "@oh-my-pi/pi-tui/theme";

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

/** Keep lifecycle failures and interactive waits visible without listing agents */
export function compactSubagentState(
  sessions: readonly ObservableSession[],
): { full: string; compact: string; essential: string } | undefined {
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
