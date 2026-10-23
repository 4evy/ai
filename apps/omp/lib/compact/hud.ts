import { type Component, Text, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { ObservableSession } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { theme } from "@oh-my-pi/pi-tui/theme";

/** One responsive overview row, with details yielding space to counts and hints */
export class CompactHudComponent implements Component {
  readonly #text: Text;

  constructor(
    heads: readonly string[],
    detail: string | undefined,
    hints: readonly string[],
  ) {
    const narrowHint = hints.at(-1) ?? "";
    this.#text = new Text(heads[0] ?? "", 0, 0).setWrapLine((_line, width) => {
      const available = Math.max(0, width - 2);
      const headBudget = Math.max(
        0,
        available - (narrowHint ? visibleWidth(narrowHint) + 3 : 0),
      );
      const selectedHead =
        heads.find((head) => visibleWidth(head) <= headBudget) ?? heads.at(-1) ?? "";
      const hint =
        hints.find(
          (hint) =>
            visibleWidth(selectedHead) + visibleWidth(hint) + (hint ? 3 : 0) <=
            available,
        ) ?? narrowHint;
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

  render(width: number): readonly string[] {
    return width > 0 ? this.#text.render(width) : [""];
  }

  invalidate(): void {
    this.#text.invalidate();
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
