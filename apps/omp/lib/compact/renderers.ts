import { expandHint } from "@oh-my-pi/pi-coding-agent/ui/styles/tools/frame";
import {
  type JsonTreePresentation,
  setJsonTreePresentation,
} from "@oh-my-pi/pi-coding-agent/ui/styles/tools/json-tree";
import {
  type ShellRendererPolicy,
  setShellRendererPolicy,
} from "@oh-my-pi/pi-coding-agent/ui/tools/bash";
import type { EvalRendererOptions } from "@oh-my-pi/pi-coding-agent/ui/tools/eval";
import type { JSXNode } from "@oh-my-pi/pi-tui";
import { jsx } from "@oh-my-pi/pi-tui/jsx-runtime";

/** Source previews share the same wrapped two-row disclosure in both tools */
function describeInput(source: string, language: string, role: string): JSXNode {
  return jsx(
    "code",
    { text: source.trimEnd(), role, lang: language, wrap: true, preview: { lines: 2 } },
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
    `${theme.fg("dim", "More output")} ${expandHint(theme)}`,
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
  stateLabel: (state) => shellStateLabels[state],
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
