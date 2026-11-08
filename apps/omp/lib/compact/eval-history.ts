import { code, keyed, node, span, text } from "@oh-my-pi/pi-tui/native/describe";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import {
  expandKeyHint,
  previewLine,
  sanitizeDisplayLines,
  truncateToWidth,
} from "@oh-my-pi/pi-tui/render/render-utils";
import {
  agentEventStatus,
  type EvalStatusEvent,
  type EvalStatusRenderer,
  formatStatusEvent,
  formatStatusEventExpanded,
  renderAgentProgressEvents,
} from "@oh-my-pi/pi-tui/tools/eval";
import { formatMCPProgress, parseMCPProgress } from "@oh-my-pi/pi-tui/tools/mcp";
import { splitPathAndSel } from "@oh-my-pi/pi-tui/tools/read";
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

function historyLabel(earlier: number, elided: number, expanded: boolean) {
  return `History${earlier > 0 ? ` · ${earlier} earlier` : ""}${elided > 0 ? ` · ${elided} omitted` : ""}${expanded ? "" : ` · ${expandKeyHint()}`}`;
}

/** Routine scalars fold to one line, notices and expanded history stay whole */
function describeEvent(event: EvalStatusEvent, expanded: boolean): NativeNode {
  const attention = needsAttention(event);
  const full = expanded || attention;
  const spans: TspSpan[] = [span(event.op, attention ? "warning" : "muted")];
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
      spans.push(
        span(` ${key}=`, "muted"),
        span(
          full ? valueText : previewLine(valueText, 200),
          full ? undefined : "muted",
        ),
      );
    }
  }
  if (progress)
    spans.push(
      span(` ${formatMCPProgress(progress, 200)}`, full ? undefined : "muted"),
    );
  const line = text(spans, {
    ...(full ? {} : { lines: 1, truncate: "end" as const }),
    wrap: "word",
    role: "omp.tool.eval.status",
  });
  const preview =
    expanded && typeof event.preview === "string" ? event.preview.trimEnd() : undefined;
  if (!preview) return line;
  const path = typeof event.path === "string" && event.path ? event.path : undefined;
  return node("col", { role: "omp.tool.eval.status.event", gap: "none" }, [
    keyed(line, "line"),
    keyed(
      code(sanitizeDisplayLines(preview).join("\n"), {
        role: "omp.tool.eval.status.preview",
        ...(path ? { path: splitPathAndSel(path).path } : {}),
        wrap: false,
      }),
      "preview",
    ),
  ]);
}

/** Shared selection keeps terminal rows and native history disclosures aligned */
export const compactEvalHistory: EvalStatusRenderer = {
  render(events, theme, expanded, elided = 0, width, spinnerFrame) {
    if (events.length === 0 && elided === 0) return [];
    const indices = visibleIndices(events, expanded);
    const label = historyLabel(events.length - indices.length, elided, expanded);
    const lines = [theme.fg("dim", width ? truncateToWidth(label, width) : label)];
    for (const index of indices) {
      const event = events[index];
      if (!event) continue;
      const isLast = index === indices.at(-1);
      const branch = isLast ? theme.tree.last : theme.tree.branch;
      if (event.op === "agent" && width) {
        lines.push(...renderAgentProgressEvents([event], theme, width, spinnerFrame));
        continue;
      }
      if (expanded) {
        const eventLines = formatStatusEventExpanded(event, theme);
        lines.push(`${theme.fg("dim", branch)} ${eventLines[0]}`);
        const continuation = isLast ? "   " : `${theme.tree.vertical}  `;
        for (let j = 1; j < eventLines.length; j++)
          lines.push(`${theme.fg("dim", continuation)}${eventLines[j]}`);
      } else {
        const line = `${theme.fg("dim", branch)} ${formatStatusEvent(event, theme)}`;
        lines.push(
          width && !needsAttention(event) ? truncateToWidth(line, width) : line,
        );
      }
    }
    return lines;
  },
  describe(log, expanded) {
    const events = log.statusEvents ?? [];
    const elided = log.statusEventsElided ?? 0;
    if (events.length === 0 && elided === 0) return undefined;
    const indices = visibleIndices(events, expanded);
    const label = historyLabel(events.length - indices.length, elided, expanded);
    const children = [
      keyed(text([span(label, "muted")], { lines: 1, truncate: "end" }), "history"),
    ];
    for (const index of indices) {
      const event = events[index];
      if (event)
        children.push(keyed(describeEvent(event, expanded), `s${elided + index}`));
    }
    return node("col", { role: "omp.run.status", gap: "none" }, children, "status");
  },
};
