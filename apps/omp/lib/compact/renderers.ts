import { code, keyed } from "@oh-my-pi/pi-tui/native/describe";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { renderStatusLine } from "@oh-my-pi/pi-tui/render";
import { formatExpandHint } from "@oh-my-pi/pi-tui/render/render-utils";
import type { StatusLineOptions } from "@oh-my-pi/pi-tui/render/status-line";
import type { ToolCardSnapshot } from "@oh-my-pi/pi-tui/render/tool-card";
import {
  type ShellRendererPolicy,
  setShellRendererPolicy,
} from "@oh-my-pi/pi-tui/tools/bash";
import type { EvalRendererOptions } from "@oh-my-pi/pi-tui/tools/eval";
import {
  type JsonTreePresentation,
  setJsonTreePresentation,
} from "@oh-my-pi/pi-tui/tools/json-tree";

/** Source previews share the same wrapped two-row disclosure in both tools */
function describeInput(source: string, language: string, role: string): NativeNode {
  return keyed(
    code(source.trimEnd(), {
      role,
      lang: language,
      wrap: true,
      preview: { lines: 2 },
    }),
    "input",
  );
}

export const compactEvalPresentation: EvalRendererOptions = {
  previewLines: 6,
  codeMaxLines: 2,
  codeTail: false,
  expandErrors: true,
  structuredHead: true,
  hiddenRootKeys: [],
  describeInput,
  outputDisclosure: (_hidden, theme) =>
    theme.fg("dim", `More output ${formatExpandHint(theme, false, true)}`),
};

const shellStateLabels = {
  queued: "Queued",
  running: "Running",
  background: "Background",
  "timed-out": "Timed out",
  failed: "Failed",
  cancelled: "Cancelled",
  done: "Done",
} as const;

export const compactShellPresentation: ShellRendererPolicy = {
  previewLines: 6,
  codeMaxLines: 2,
  shellPreviewLines: false,
  describeInput,
  showTimeout: (expanded) => expanded,
  serviceFacts(service, expanded) {
    if (!expanded)
      return [
        service.timedOut ? `${service.state} (readiness timed out)` : service.state,
      ];
    const parts = [
      `Service: ${service.name}`,
      `State: ${service.state}`,
      `Ready: ${service.ready ? "yes" : service.timedOut ? "timed out" : "no"}`,
    ];
    if (service.pid !== undefined) parts.push(`PID: ${service.pid}`);
    return parts;
  },
  presentState(state, title, options, theme, showHeader, intent) {
    const label = shellStateLabels[state];
    const running = state === "running" || state === "background";
    const failed = state === "failed" || state === "cancelled";
    const icon = running
      ? "running"
      : state === "timed-out"
        ? "warning"
        : failed
          ? "error"
          : state === "queued"
            ? "pending"
            : "done";
    const presentation: Pick<
      ToolCardSnapshot,
      "header" | "headerMeta" | "phase" | "borderColor"
    > = {
      phase: running
        ? "running"
        : state === "timed-out"
          ? "warning"
          : failed
            ? "error"
            : state === "queued"
              ? "pending"
              : "success",
    };
    if (showHeader) {
      const status: StatusLineOptions = {
        icon,
        title: `${label}${theme.sep.dot}${title}`,
      };
      if (intent !== undefined) status.description = intent;
      if (options.spinnerFrame !== undefined)
        status.spinnerFrame = options.spinnerFrame;
      presentation.header = renderStatusLine(status, theme);
    } else {
      presentation.headerMeta = theme.fg("toolOutput", label);
    }
    if (state === "done") presentation.borderColor = "dim";
    return presentation;
  },
};

const compactJsonTreePresentation: JsonTreePresentation = {
  keyColor(depth, color, native) {
    if (color === "dim" || depth > 1) return color;
    return native ? (color === "muted" ? undefined : color) : "toolOutput";
  },
};

/** Factories created before extension startup read the shared policies on use */
export function installCompactRendererPolicies(): void {
  setShellRendererPolicy(compactShellPresentation);
  setJsonTreePresentation(compactJsonTreePresentation);
}
