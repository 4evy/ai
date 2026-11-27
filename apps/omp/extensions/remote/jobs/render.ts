import {
  outputLine,
  sourcePreview,
} from "@oh-my-pi/pi-coding-agent/ui/styles/tools/code-cell";
import {
  frameInner,
  frameRows,
  statusIcon,
  statusLine,
  tailRows,
} from "@oh-my-pi/pi-coding-agent/ui/styles/tools/frame";
import {
  defineToolLook,
  isExpanded,
  toolProps,
} from "@oh-my-pi/pi-coding-agent/ui/styles/tools/look";
import {
  type ShellConfig,
  shellPresenter,
} from "@oh-my-pi/pi-coding-agent/ui/tools/bash";
import type {
  ToolPresenter,
  ToolResult,
  ToolView,
  ToolViewState,
} from "@oh-my-pi/pi-coding-agent/ui/tools/contract";
import { resultText } from "@oh-my-pi/pi-coding-agent/ui/tools/default";
import { type JSXNode, jsx, type UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { ansiLines } from "@oh-my-pi/pi-tui/term/painters/ansi";
import { highlightCode } from "@oh-my-pi/pi-tui/text/highlight";
import { formatDuration, sanitizeText } from "@oh-my-pi/pi-utils";
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
  phase: "error" | "warning" | "running" | "success";
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
  result: ToolResult<RemoteJobDetails>,
  options: ToolViewState,
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
  const phase: JobView["phase"] = failed
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
    screen || details.rawOutput !== undefined || details.replay
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

interface JobTerm extends JobView {
  readonly look: "remote-job";
  readonly elapsedMs?: number;
}

function sectionLimit(section: Section): number {
  return section.label === "Steps" ? 8 : 10;
}

function paintJob(node: UiNode, cx: PaintContext): Block {
  const props = toolProps(node);
  const job = props.term as unknown as JobTerm;
  const theme = cx.theme;
  const expanded = isExpanded(props);
  const width = frameInner(cx.width);
  const sections = job.sections.map((section) => {
    const limit = sectionLimit(section);
    const lines = section.language
      ? highlightCode(sanitizeText(section.output), section.language, theme)
      : ansiLines(section.output).map((line) => outputLine(theme, line));
    return {
      label: theme.fg("toolTitle", section.label),
      lines: expanded
        ? lines
        : section.tail
          ? tailRows(theme, lines, limit, width)
          : sourcePreview(theme, lines, limit, width, false),
    };
  });
  return {
    rows: frameRows(theme, cx.width, {
      head: statusLine(theme, {
        glyph: statusIcon(cx, job.phase),
        title: job.title,
        description: job.state,
        meta: job.meta,
      }),
      sections,
      border:
        job.phase === "success"
          ? "dim"
          : job.phase === "running"
            ? "accent"
            : job.phase,
      ...(job.elapsedMs === undefined
        ? {}
        : { foot: theme.fg("dim", `elapsed ${formatDuration(job.elapsedMs)}`) }),
    }),
  };
}

defineToolLook("remote-job", { paint: paintJob, margin: true, animated: true });

function sectionNode(section: Section, index: number): JSXNode {
  const preview = { lines: sectionLimit(section) };
  const child =
    section.language || section.label === "Steps"
      ? jsx("code", {
          text: sanitizeText(section.output),
          lang: section.language,
          preview,
          wrap: true,
        })
      : section.tail
        ? jsx("ansi", { text: section.output, follow: true, preview })
        : jsx("text", { spans: [{ t: sanitizeText(section.output) }], wrap: "word" });
  return jsx(
    "section",
    { head: sanitizeText(section.label), children: child },
    String(index),
  );
}

export function createJobPresenter(
  config: ShellConfig<unknown>,
): ToolPresenter<unknown, RemoteJobDetails> {
  const shell = shellPresenter(config);
  const { presenter: fallback } = farstepPresentation("Job");
  return {
    ...shell,
    result(result, state, args): ToolView | undefined {
      if (!result.details?.job) return fallback.result?.(result, state, args);
      const view = jobView(result, state, config.title(args));
      const command = config.command(args);
      if (command)
        view.sections.unshift({
          label: "Script",
          output: command,
          language: "typescript",
        });
      const exit = result.details.exitCode;
      const term: JobTerm = {
        ...view,
        look: "remote-job",
        sections: [{ label: "Job", output: view.target }, ...view.sections],
        ...(state.isPartial && state.elapsedMs !== undefined
          ? { elapsedMs: state.elapsedMs }
          : {}),
      };
      return {
        head: {
          title: view.title,
          target: view.target,
          meta: view.meta,
          note: view.state,
          ...(command ? { command } : {}),
          ...(exit ? { exit } : {}),
        },
        tone: view.phase === "running" ? "pending" : view.phase,
        body: view.sections.map(sectionNode),
        preview: "children",
        term: { ...term },
      };
    },
  };
}
