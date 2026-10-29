import { readText } from "@ai/toolkit/text/text";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { WorkflowResult } from "farstep/protocol/workflow/workflow";

const MAX_INLINE_REASON_BYTES = 120;
const MAX_WORKFLOW_TEXT_BYTES = 64 * 1024;
const PREVIEW_NOTICE_RESERVE_BYTES = 256;

export function workflowText(workflow: WorkflowResult): string {
  const lines = [
    `Workflow ${workflow.name} · ${workflow.state}${workflow.requestId ? ` · requestId ${workflow.requestId}` : ""}`,
    ...workflow.steps.map((step) => {
      const fields = [`${step.id}: ${step.state}`];
      if (step.exitCode !== undefined) fields.push(`exit ${step.exitCode}`);
      if (step.readiness) fields.push(`readiness ${step.readiness.state}`);
      if (step.reason)
        fields.push(
          Buffer.byteLength(step.reason) <= MAX_INLINE_REASON_BYTES
            ? sanitizeText(step.reason)
            : "reason available in step details",
        );
      return fields.join(" · ");
    }),
  ];
  let remaining =
    MAX_WORKFLOW_TEXT_BYTES -
    Buffer.byteLength(lines.join("\n")) -
    PREVIEW_NOTICE_RESERVE_BYTES;
  let omitted = false;
  for (const step of workflow.steps) {
    if (!step.output) continue;
    const output =
      step.output.format === "text"
        ? step.output
        : { ...step.output, stdoutText: undefined };
    let text = JSON.stringify({ step: step.id, output });
    if (Buffer.byteLength(text) + 1 > remaining) {
      text = JSON.stringify({
        step: step.id,
        output: {
          ...output,
          stdoutText: undefined,
          stderrText: undefined,
          value: undefined,
          records: undefined,
          error:
            output.error && Buffer.byteLength(output.error) <= MAX_INLINE_REASON_BYTES
              ? output.error
              : undefined,
          inlineOmitted: true,
        },
      });
      omitted = true;
    }
    const bytes = Buffer.byteLength(text) + 1;
    if (bytes > remaining) {
      omitted = true;
      continue;
    }
    lines.push(text);
    remaining -= bytes;
  }
  if (omitted) lines.push(readText(new URL("./output.md", import.meta.url), "preview"));
  return lines.join("\n");
}

export function showWorkflow(
  workflow: WorkflowResult | undefined,
): workflow is WorkflowResult {
  return Boolean(
    workflow &&
      (workflow.kind === "batch" ||
        workflow.steps.some(
          (step) =>
            (step.output &&
              (step.output.format !== "text" ||
                (step.output.state !== "complete" &&
                  step.output.state !== "inherited"))) ||
            step.readiness?.state === "failed" ||
            step.readiness?.state === "timed_out",
        ) ||
        !["prepared", "running", "succeeded"].includes(workflow.state)),
  );
}

export function workflowFailed(workflow: WorkflowResult | undefined): boolean {
  return (
    workflow?.state === "failed" ||
    workflow?.state === "unknown" ||
    workflow?.steps.some(
      (step) =>
        step.state === "failed" ||
        step.state === "unknown" ||
        step.readiness?.state === "failed" ||
        step.readiness?.state === "timed_out",
    ) === true
  );
}
