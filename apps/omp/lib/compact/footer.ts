import { sanitizeStatusText } from "@oh-my-pi/pi-coding-agent/modes/view-model/chrome/shared";
import type { StatusFacts } from "@oh-my-pi/pi-coding-agent/ui/status/facts";
import {
  contextColor,
  contextLevel,
  contextTone,
} from "@oh-my-pi/pi-coding-agent/ui/status/format";
import type { StatusLinePresentation } from "@oh-my-pi/pi-coding-agent/ui/status/presentation";
import type { SegView } from "@oh-my-pi/pi-coding-agent/ui/status/segments";
import { TRUNCATE_LENGTHS } from "@oh-my-pi/pi-coding-agent/utils/render-utils";
import { truncate } from "@oh-my-pi/pi-tui/text/width";
import type { SymbolSet } from "@oh-my-pi/pi-tui/theme/contract";
import type { TspSpan } from "@oh-my-pi/pi-wire";

function resetCountdown(value: number, unit: "m" | "h"): string {
  const boundary = unit === "m" ? 60 : 24;
  if (value < boundary) return `${value}${unit}`;
  const whole = Math.floor(value / boundary);
  const remainder = value % boundary;
  const text = `${whole}${unit === "m" ? "h" : "d"}`;
  return remainder > 0 ? `${text} ${remainder}${unit}` : text;
}

function quotaView(facts: StatusFacts, symbols: SymbolSet): SegView | null {
  const usage = facts.quota;
  if (!usage) return null;
  const spans: TspSpan[] = [];
  const separate = () => {
    if (spans.length > 0) spans.push({ t: "   " });
  };
  const window = (
    label: string,
    percent: number,
    reset: number | undefined,
    unit: "m" | "h",
    floor = false,
  ) => {
    separate();
    // Provider values are used capacity, but this footer shows remaining capacity
    const remaining = floor ? Math.floor(100 - percent) : Math.round(100 - percent);
    spans.push(
      { t: `${label} `, s: "muted" },
      {
        t: `${remaining}%`,
        s: percent >= 80 ? "error" : percent >= 50 ? "warning" : "text",
      },
    );
    if (reset !== undefined) {
      spans.push({
        t: `${symbols.symbol("sep.dot")}${resetCountdown(reset, unit)}`,
        s: "muted",
      });
    }
  };
  if (usage.fiveHour)
    window("5h", usage.fiveHour.percent, usage.fiveHour.resetMinutes, "m");
  if (usage.daily) window("1d", usage.daily.percent, usage.daily.resetMinutes, "m");
  if (usage.sevenDay)
    window("Wk", usage.sevenDay.percent, usage.sevenDay.resetHours, "h");
  if (usage.monthly)
    window("mo", usage.monthly.percent, usage.monthly.resetHours, "h", true);
  if (usage.resetCredits) {
    separate();
    const resets = usage.resetCredits;
    spans.push({ t: "Rs ", s: "muted" }, { t: `${resets.bankedCount}`, s: "text" });
    if (resets.redeemableCount !== resets.bankedCount) {
      spans.push({ t: ` (${resets.redeemableCount} usable)`, s: "muted" });
    }
    if (resets.expiryHours !== undefined) {
      const expiring = resets.expiring ? `${resets.expiring.count} ` : "";
      const color = resets.expiring
        ? resets.expiring.tier === "imminent"
          ? "error"
          : "warning"
        : resets.redeemableCount > 0
          ? "text"
          : "warning";
      spans.push({
        t: `${symbols.symbol("sep.dot")}${expiring}exp ${resetCountdown(resets.expiryHours, "h")}`,
        s: color,
      });
    } else if (resets.expired) {
      spans.push({ t: " expired", s: "error" });
    }
    if (resets.redeemableCount === 0 && resets.unavailableReason) {
      const reason = truncate(
        sanitizeStatusText(resets.unavailableReason),
        TRUNCATE_LENGTHS.SHORT,
      );
      if (reason) spans.push({ t: ` ${reason}`, s: "warning" });
    }
  }
  return spans.length > 0 ? { spans, look: { pieces: spans } } : null;
}

function contextView(facts: StatusFacts, symbols: SymbolSet, accent?: string): SegView {
  const { percent, window } = facts.context;
  const level = contextLevel(percent ?? 0, window);
  const spans: TspSpan[] = [
    { t: "Ctx ", s: "muted" },
    { t: percent === null ? "?" : `${Math.round(percent)}%`, s: contextColor(level) },
  ];
  const auto = symbols.icon("auto");
  if (
    facts.autoCompact &&
    auto &&
    (facts.speculation === "running" || facts.speculation === "armed")
  ) {
    spans.push({
      t: ` ${auto}`,
      s: "accent",
      ...(facts.speculation === "running" ? { fx: "pulse" as const } : {}),
    });
  }
  const tone = contextTone(level);
  return {
    spans,
    ...(tone === undefined ? {} : { tone }),
    look: {
      pieces: spans.map(({ t, s, fx }) => ({
        t,
        ...(s === undefined
          ? {}
          : { s: s === "accent" && accent ? "sessionAccent" : s }),
        ...(fx === "pulse" ? { fx } : {}),
      })),
      ...(accent === undefined ? {} : { title: accent }),
    },
  };
}

export const compactFooterSegments: Pick<
  StatusLinePresentation,
  "usage" | "context" | "subagents"
> = {
  usage: quotaView,
  context: contextView,
  subagents(count) {
    if (!count) return null;
    const spans = [{ t: `Agt ${count}`, s: "statusLineSubagents" }];
    return { spans, look: { pieces: spans } };
  },
};
