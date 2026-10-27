import { ansi, code, node, text } from "@oh-my-pi/pi-tui/native/describe";
import { plainText } from "@oh-my-pi/pi-tui/native/spans";
import {
  framedToolCard,
  OutputPane,
  type ToolCardPhase,
} from "@oh-my-pi/pi-tui/render";
import { formatDuration } from "@oh-my-pi/pi-tui/render/render-utils";
import { highlightCode } from "@oh-my-pi/pi-tui/theme";
import {
  createShellRenderer,
  type ShellRendererConfig,
} from "@oh-my-pi/pi-tui/tools/bash";
import { resultText } from "@oh-my-pi/pi-tui/tools/native-view";
import type {
  NativeToolView,
  RenderResultContextOptions,
  ToolRenderer,
  ToolRenderResult,
} from "@oh-my-pi/pi-tui/tools/renderer";
import type {
  WorkflowOutput,
  WorkflowStepResult,
} from "farstep/protocol/workflow/workflow";
import { farstepPresentation } from "../tools/presentation";
import { workflowFailed } from "./output/workflow";
import type { RemoteJobDetails } from "./types";

interface Section {
  label: string;
  output: string;
  language?: string;
  tail?: boolean;
}
interface JobView {
  title: string;
  target: string;
  state: string;
  phase: ToolCardPhase;
  meta: string[];
  sections: Section[];
}

function outputSections(
  output: WorkflowOutput,
  prefix: string,
  expanded: boolean,
): Section[] {
  const sections: Section[] = [];
  if (output.format === "text") {
    if (output.stdoutText)
      sections.push({
        label: `${prefix}stdout`,
        output: output.stdoutText.trimEnd(),
        tail: true,
      });
  } else if (output.value !== undefined || output.records !== undefined) {
    sections.push({
      label: `${prefix}${output.format === "jsonl" ? "Records" : "Result"}`,
      output: JSON.stringify(
        output.value !== undefined ? output.value : output.records,
        null,
        2,
      ),
      language: "json",
    });
  } else if (output.stdoutText) {
    sections.push({
      label: `${prefix}stdout (${output.format})`,
      output: output.stdoutText.trimEnd(),
      tail: true,
    });
  }
  if (output.stderrText)
    sections.push({
      label: `${prefix}stderr`,
      output: output.stderrText.trimEnd(),
      tail: true,
    });
  const notices: string[] = [];
  if (output.state !== "complete" && output.state !== "inherited")
    notices.push(`Output ${output.state}`);
  if (output.error) notices.push(output.error);
  if (output.inlineOmitted)
    notices.push("Inline preview omitted, inspect retained output");
  for (const stream of ["stdout", "stderr"] as const) {
    const artifact = output[stream];
    if (artifact && (expanded || artifact.truncated))
      notices.push(
        `${stream}: ${artifact.path} · ${artifact.retainedBytes}/${artifact.bytes} bytes retained${artifact.truncated ? " · truncated" : ""}`,
      );
  }
  if (notices.length)
    sections.push({ label: `${prefix}Output details`, output: notices.join("\n") });
  return sections;
}

function stepSummary(step: WorkflowStepResult): string {
  const parts = [`${step.id}: ${step.state}`];
  if (step.exitCode !== undefined) parts.push(`exit ${step.exitCode}`);
  if (step.startedAt !== undefined && step.finishedAt !== undefined)
    parts.push(formatDuration(Math.max(0, step.finishedAt - step.startedAt)));
  if (step.readiness) parts.push(`readiness ${step.readiness.state}`);
  if (step.dependsOn.length) parts.push(`after ${step.dependsOn.join(", ")}`);
  if (step.reason) parts.push(step.reason);
  return parts.join(" · ");
}

function jobView(
  result: ToolRenderResult<RemoteJobDetails>,
  options: RenderResultContextOptions,
  title: string,
): JobView {
  const details = result.details ?? {};
  const workflow = details.workflow;
  const running = details.remoteState === "running";
  const failed =
    result.isError === true ||
    (details.exitCode !== undefined && details.exitCode !== 0) ||
    workflowFailed(workflow);
  const unknown = details.remoteState === "unknown";
  const state =
    details.deadline?.deadlineTriggeredAt !== undefined
      ? "timed out"
      : unknown
        ? "state unknown"
        : workflow?.state === "cancelled"
          ? "cancelled"
          : failed
            ? "failed"
            : running
              ? options.isPartial
                ? "running"
                : "in background"
              : (workflow?.state ?? details.state ?? "completed");
  const phase: ToolCardPhase = failed
    ? "error"
    : unknown || state === "timed out" || state === "cancelled"
      ? "warning"
      : running
        ? "running"
        : "success";
  const meta: string[] = [];
  if (details.exitCode !== undefined) meta.push(`exit ${details.exitCode}`);
  const duration = options.isPartial ? undefined : details.wallTimeMs;
  if (duration !== undefined) meta.push(formatDuration(duration));
  if (details.connectionId) {
    const target =
      details.connectionId === "local" ? "Local" : `SSH ${details.connectionId}`;
    if (!title.endsWith(target)) meta.push(target);
  }
  if (details.lifetime === "persist") meta.push("persistent");
  const readiness = workflow?.steps[0]?.readiness;
  if (workflow?.kind === "job" && readiness) meta.push(`readiness ${readiness.state}`);
  const sections: Section[] = [];
  if (workflow?.kind === "batch") {
    const done = workflow.steps.filter(
      (step) => !["queued", "starting", "running"].includes(step.state),
    ).length;
    meta.push(`${done}/${workflow.steps.length} steps finished`);
    sections.push({
      label: "Steps",
      output: workflow.steps.map(stepSummary).join("\n"),
    });
  }
  const screen =
    details.rawOutput === undefined
      ? (details.terminalStyleRows ?? details.terminalRows)
      : undefined;
  if (screen)
    sections.push({
      label: `Terminal${details.terminalColumns ? ` · ${details.terminalColumns}×${details.terminalHeight}` : ""}`,
      output: screen.join("\n") || "(empty screen)",
      tail: true,
    });
  // Completed workflow streams are authoritative and separated from their envelopes
  // PTY snapshots remain authoritative for interactive jobs
  const outputs =
    screen || details.rawOutput !== undefined
      ? []
      : (workflow?.steps.flatMap((step) =>
          step.output
            ? outputSections(
                step.output,
                workflow.kind === "batch" ? `${step.id} · ` : "",
                options.expanded,
              )
            : [],
        ) ?? []);
  sections.push(...outputs);
  if (
    !screen &&
    !outputs.some((section) => !section.label.endsWith("Output details"))
  ) {
    const output =
      details.rawOutput?.replaceAll("\u001b", "\\x1b") ?? details.newOutput;
    if (output)
      sections.push({ label: "Output", output: output.trimEnd(), tail: true });
    else if (!workflow && details.newOutput === undefined)
      sections.push({ label: "Output", output: resultText(result), tail: true });
  }
  const notices = details.notices ?? [];
  if (notices.length) sections.push({ label: "Notices", output: notices.join("\n") });
  if (unknown && !workflow && !notices.length && !details.receipt)
    sections.push({ label: "Unavailable output", output: resultText(result) });
  if (details.receipt && !notices.length)
    sections.push({
      label: "Historical receipt",
      output: `${details.receipt.actionId}: ${details.receipt.state}\nBroker receipt only, not an application acknowledgement${details.receipt.error ? `\n${details.receipt.error}` : ""}`,
    });
  if (details.sequence)
    sections.push({
      label: "Input sequence",
      output: `${details.sequence.completedSteps} steps completed${details.sequence.error ? `\n${details.sequence.error}` : ""}`,
    });
  if (options.expanded) {
    const facts = [
      details.cwd,
      details.interpreter,
      details.cursor === undefined ? undefined : `cursor ${details.cursor}`,
      details.screenVersion ? `screen ${details.screenVersion}` : undefined,
    ].filter((part): part is string => part !== undefined);
    if (facts.length)
      sections.push({ label: "Job details", output: facts.join(" · ") });
  }
  if (!sections.length)
    sections.push({
      label: "Output",
      output: running ? "Waiting for output…" : "(no new output)",
    });
  return { title, target: details.job ?? "", state, phase, meta, sections };
}

export function createJobRenderer(config: ShellRendererConfig<unknown>) {
  const shell = createShellRenderer(config);
  const fallback = farstepPresentation("Job");
  return {
    ...shell,
    renderResult(result, options, theme, args) {
      if (!result.details?.job)
        return fallback.renderResult(result, options, theme, args);
      const view = jobView(result, options, config.resolveTitle(args, options));
      const command = config.resolveCommand?.(args);
      if (command)
        view.sections.unshift({
          label: "Script",
          output: command,
          language: "typescript",
        });
      view.sections.unshift({ label: "Job", output: view.target });
      const sections = view.sections.map((section) => ({
        label: theme.fg("toolTitle", section.label),
        content: new OutputPane(
          theme,
          {
            expanded: options.expanded,
            collapsedMaxLines: section.label === "Steps" ? 8 : 10,
            edge: section.tail ? "tail" : "head",
            visual: true,
            styleLine: (line) => theme.fg("toolOutput", line),
          },
          section.language
            ? highlightCode(section.output, section.language).join("\n")
            : section.output,
        ),
      }));
      return framedToolCard(theme, () => ({
        status: {
          icon:
            view.phase === "running"
              ? "running"
              : view.phase === "error"
                ? "error"
                : view.phase === "warning"
                  ? "warning"
                  : "success",
          ...(options.spinnerFrame === undefined
            ? {}
            : { spinnerFrame: options.spinnerFrame }),
          title: view.title,
          description: view.state,
        },
        phase: view.phase,
        headerMeta: view.meta.join(" · "),
        ...(options.isPartial && options.elapsedMs !== undefined
          ? { footerMeta: `elapsed ${formatDuration(options.elapsedMs)}` }
          : {}),
        sections,
      }));
    },
    describeResult(result, options, args): NativeToolView | undefined {
      if (!result.details?.job) return fallback.describeResult(result, options, args);
      const view = jobView(result, options, config.resolveTitle(args, options));
      const command = config.resolveCommand?.(args);
      if (command)
        view.sections.unshift({
          label: "Script",
          output: command,
          language: "typescript",
        });
      return {
        tool: {
          title: view.title,
          target: view.target,
          meta: view.meta,
          note: view.state,
          ...(command ? { command } : {}),
          ...(result.details.exitCode !== undefined && result.details.exitCode !== 0
            ? { exit: result.details.exitCode }
            : {}),
        },
        tone:
          view.phase === "error"
            ? "error"
            : view.phase === "warning"
              ? "warning"
              : view.phase === "running"
                ? "pending"
                : "success",
        body: view.sections.map((section, index) =>
          node(
            "section",
            { head: plainText(section.label) },
            [
              section.language || section.label === "Steps"
                ? code(plainText(section.output), {
                    ...(section.language ? { lang: section.language } : {}),
                    ...(options.expanded
                      ? {}
                      : { preview: { lines: section.label === "Steps" ? 8 : 10 } }),
                  })
                : section.tail
                  ? ansi(section.output, {
                      follow: true,
                      ...(options.expanded ? {} : { preview: { lines: 10 } }),
                    })
                  : text(plainText(section.output), { wrap: "word" }),
            ],
            String(index),
          ),
        ),
        preview: "children",
      };
    },
  } satisfies ToolRenderer<unknown, RemoteJobDetails>;
}
