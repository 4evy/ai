import type { EvalStatusEvent } from "@oh-my-pi/pi-coding-agent/tools/details/eval";
import { formatMCPProgress } from "@oh-my-pi/pi-coding-agent/tools/details/mcp";
import { splitPathAndSel } from "@oh-my-pi/pi-coding-agent/tools/details/read";
import { parseMCPProgress } from "@oh-my-pi/pi-coding-agent/tools/mcp-progress";
import { expandKeyLabel } from "@oh-my-pi/pi-coding-agent/ui/keys/hints";
import {
  agentEventStatus,
  formatStatusEvent,
  formatStatusEventExpanded,
  renderAgentProgressEvents,
} from "@oh-my-pi/pi-coding-agent/ui/styles/tools/eval";
import type { EvalStatusRenderer } from "@oh-my-pi/pi-coding-agent/ui/tools/eval";
import type { JSXNode } from "@oh-my-pi/pi-tui";
import { jsx } from "@oh-my-pi/pi-tui/jsx-runtime";
import { replaceTabs, truncate } from "@oh-my-pi/pi-tui/text/width";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { TspSpan } from "@oh-my-pi/pi-wire";

/** Notices stay visible even when newer routine events follow them */
function needsAttention(event: EvalStatusEvent): boolean {
  return Boolean(
    (event.op === "agent" && agentEventStatus(event.status) === "running") ||
      event.op === "error" ||
      event.op === "warning" ||
      event.error ||
      event.warning ||
      event.failed ||
      event.status === "error" ||
      event.status === "warning" ||
      event.status === "failed" ||
      event.status === "aborted" ||
      event.status === "cancelled",
  );
}

function visibleIndices(events: readonly EvalStatusEvent[], expanded: boolean) {
  const indices: number[] = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event && (expanded || i === events.length - 1 || needsAttention(event)))
      indices.push(i);
  }
  return indices;
}

function historyLabel(earlier: number, elided: number, hint?: string) {
  return `History${earlier > 0 ? ` · ${earlier} earlier` : ""}${elided > 0 ? ` · ${elided} omitted` : ""}${hint ? ` · ${hint}` : ""}`;
}

/** Routine scalars fold to one line, notices and expanded history stay whole */
function describeEvent(event: EvalStatusEvent, expanded: boolean): JSXNode {
  const attention = needsAttention(event);
  const full = expanded || attention;
  const spans: TspSpan[] = [{ t: event.op, s: attention ? "warning" : "muted" }];
  const progress = event.op === "mcp_progress" ? parseMCPProgress(event) : undefined;
  for (const key in event) {
    if (key === "op" || key === "preview" || key === "resolvedThinkingLevel") continue;
    if (event.op === "mcp_progress" && key !== "tool") continue;
    const value = event[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      const valueText = sanitizeText(String(value));
      spans.push({ t: ` ${key}=`, s: "muted" });
      spans.push(
        full
          ? { t: valueText }
          : {
              t: truncate(valueText.replace(/\s+/g, " ").trim(), 200),
              s: "muted",
            },
      );
    }
  }
  if (progress)
    spans.push({
      t: ` ${formatMCPProgress(progress, 200)}`,
      ...(full ? {} : { s: "muted" }),
    });
  const line = jsx(
    "text",
    {
      spans,
      ...(full ? {} : { lines: 1, truncate: "end" }),
      wrap: "word",
      role: "omp.tool.eval.status",
    },
    "line",
  );
  const preview =
    expanded && typeof event.preview === "string" ? event.preview.trimEnd() : undefined;
  if (!preview) return line;
  const path = typeof event.path === "string" && event.path ? event.path : undefined;
  return jsx("col", {
    role: "omp.tool.eval.status.event",
    gap: "none",
    children: [
      line,
      jsx(
        "code",
        {
          text: replaceTabs(sanitizeText(preview)),
          role: "omp.tool.eval.status.preview",
          ...(path ? { path: splitPathAndSel(path).path } : {}),
          wrap: false,
        },
        "preview",
      ),
    ],
  });
}

/** Shared selection keeps terminal rows and native history disclosures aligned */
export const compactEvalHistory: EvalStatusRenderer = {
  render(events, theme, expanded, elided = 0, width, spinnerFrame) {
    if (events.length === 0 && elided === 0) return [];
    const indices = visibleIndices(events, expanded);
    const label = historyLabel(
      events.length - indices.length,
      elided,
      expanded ? undefined : expandKeyLabel(theme),
    );
    const lines = [theme.fg("dim", width ? truncate(label, width) : label)];
    for (const index of indices) {
      const event = events[index];
      if (!event) continue;
      const isLast = index === indices.at(-1);
      const branch = theme.symbols.symbol(isLast ? "tree.last" : "tree.branch");
      if (event.op === "agent" && width) {
        lines.push(...renderAgentProgressEvents([event], theme, width, spinnerFrame));
        continue;
      }
      if (expanded) {
        const eventLines = formatStatusEventExpanded(event, theme);
        lines.push(`${theme.fg("dim", branch)} ${eventLines[0]}`);
        const continuation = isLast
          ? "   "
          : `${theme.symbols.symbol("tree.vertical")}  `;
        for (let j = 1; j < eventLines.length; j++)
          lines.push(`${theme.fg("dim", continuation)}${eventLines[j]}`);
      } else {
        const line = `${theme.fg("dim", branch)} ${formatStatusEvent(event, theme)}`;
        lines.push(width && !needsAttention(event) ? truncate(line, width) : line);
      }
    }
    return lines;
  },
  describe(log, expanded) {
    const events = log.statusEvents ?? [];
    const elided = log.statusEventsElided ?? 0;
    if (events.length === 0 && elided === 0) return undefined;
    const indices = visibleIndices(events, expanded);
    const label = historyLabel(events.length - indices.length, elided);
    const children = [
      jsx(
        "text",
        { spans: [{ t: label, s: "muted" }], lines: 1, truncate: "end" },
        "history",
      ),
    ];
    for (const index of indices) {
      const event = events[index];
      if (event)
        children.push(
          jsx(
            "col",
            { children: describeEvent(event, expanded) },
            `s${elided + index}`,
          ),
        );
    }
    return jsx("col", { role: "omp.run.status", gap: "none", children }, "status");
  },
};
