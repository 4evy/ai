import {
  getContextUsageLevel,
  getContextUsageThemeColor,
  getContextUsageTone,
} from "@oh-my-pi/pi-tui/chrome/context-thresholds";
import { sanitizeStatusText } from "@oh-my-pi/pi-tui/chrome/shared";
import {
  TRUNCATE_LENGTHS,
  truncateToWidth,
} from "@oh-my-pi/pi-tui/render/render-utils";
import { SEGMENTS } from "@oh-my-pi/pi-tui/status-line/segments";
import type {
  SegmentContext,
  SegmentView,
  StatusLineSegment,
} from "@oh-my-pi/pi-tui/status-line/types";
import { type ThemeColor, theme } from "@oh-my-pi/pi-tui/theme";
import {
  getSessionAccentAnsi,
  getSessionAccentHex,
} from "@oh-my-pi/pi-tui/theme/session-color";

type FooterSpan = {
  t: string;
  s?: ThemeColor;
  fx?: "pulse";
};
type FooterView = Pick<SegmentView, "tone"> & { spans: FooterSpan[] };

/** One presentation policy feeds both terminal renderers */
function footerSegment(
  id: StatusLineSegment["id"],
  describe: (ctx: SegmentContext) => FooterView | null,
): StatusLineSegment {
  return {
    id,
    describe,
    render(ctx) {
      const view = describe(ctx);
      if (!view) return { content: "", visible: false };
      let content = "";
      for (const part of view.spans) {
        const color = part.fx === "pulse" && !ctx.speculationBlinkOn ? "muted" : part.s;
        if (color === "accent" && ctx.sessionAccent !== false) {
          const title =
            ctx.session.sessionManager?.getSessionName() || ctx.previewTitle;
          if (title) {
            content += `${getSessionAccentAnsi(getSessionAccentHex(title, theme.sessionAccentInputs))}${part.t}\x1b[39m`;
            continue;
          }
        }
        content += color ? theme.fg(color, part.t) : part.t;
      }
      return { content, visible: true };
    },
  };
}

function resetCountdown(value: number, unit: "m" | "h"): string {
  const boundary = unit === "m" ? 60 : 24;
  if (value < boundary) return `${value}${unit}`;
  const whole = Math.floor(value / boundary);
  const remainder = value % boundary;
  const text = `${whole}${unit === "m" ? "h" : "d"}`;
  return remainder > 0 ? `${text} ${remainder}${unit}` : text;
}

function quotaView(ctx: SegmentContext): FooterView | null {
  const usage = ctx.usage;
  if (!usage) return null;
  const spans: FooterSpan[] = [];
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
      spans.push({ t: `${theme.sep.dot}${resetCountdown(reset, unit)}`, s: "muted" });
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
        t: `${theme.sep.dot}${expiring}exp ${resetCountdown(resets.expiryHours, "h")}`,
        s: color,
      });
    } else if (resets.expired) {
      spans.push({ t: " expired", s: "error" });
    }
    if (resets.redeemableCount === 0 && resets.unavailableReason) {
      const reason = truncateToWidth(
        sanitizeStatusText(resets.unavailableReason),
        TRUNCATE_LENGTHS.SHORT,
      );
      if (reason) spans.push({ t: ` ${reason}`, s: "warning" });
    }
  }
  return spans.length > 0 ? { spans } : null;
}

function contextView(ctx: SegmentContext): FooterView {
  const level = getContextUsageLevel(ctx.contextPercent ?? 0, ctx.contextWindow);
  const spans: FooterSpan[] = [
    { t: "Ctx ", s: "muted" },
    {
      t: ctx.contextPercent === null ? "?" : `${Math.round(ctx.contextPercent)}%`,
      s: getContextUsageThemeColor(level),
    },
  ];
  if (
    ctx.autoCompactEnabled &&
    theme.icon.auto &&
    (ctx.compactionSpeculation === "running" || ctx.compactionSpeculation === "armed")
  ) {
    spans.push({
      t: ` ${theme.icon.auto}`,
      s: "accent",
      ...(ctx.compactionSpeculation === "running" ? { fx: "pulse" as const } : {}),
    });
  }
  const tone = getContextUsageTone(level);
  return tone === undefined ? { spans } : { spans, tone };
}

const usageSegment = footerSegment("usage", quotaView);
const contextSegment = footerSegment("context_pct", contextView);
const subagentsSegment = footerSegment("subagents", (ctx) =>
  ctx.subagentCount === 0
    ? null
    : { spans: [{ t: `Agt ${ctx.subagentCount}`, s: "statusLineSubagents" }] },
);

/** Install through the public registry, leaving billing and layout in the core */
export function installCompactFooterSegments(): void {
  SEGMENTS.usage = usageSegment;
  SEGMENTS.context_pct = contextSegment;
  SEGMENTS.subagents = subagentsSegment;
}
