import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { WorkflowResult } from "farstep/protocol/workflow/workflow";

const MAX_INLINE_REASON_BYTES = 120;
const MAX_WORKFLOW_TEXT_BYTES = 64 * 1024;
const PREVIEW_NOTICE_RESERVE_BYTES = 256;

function inlineReason(
  reason: string | undefined,
): { text: string; limited: boolean } | undefined {
  if (reason === undefined) return undefined;
  const text = sanitizeText(reason);
  if (Buffer.byteLength(text) <= MAX_INLINE_REASON_BYTES)
    return { text, limited: false };
  const bytes = new Uint8Array(MAX_INLINE_REASON_BYTES);
  const { written } = new TextEncoder().encodeInto(text, bytes);
  return {
    text: `${new TextDecoder().decode(bytes.subarray(0, written))}…`,
    limited: true,
  };
}

export function workflowText(workflow: WorkflowResult): string {
  const steps = workflow.steps.map((step) => {
    const reason = inlineReason(step.reason);
    const readinessReason = inlineReason(step.readiness?.reason);
    return {
      id: step.id,
      dependsOn: step.dependsOn.length ? step.dependsOn : undefined,
      state: step.state,
      exitCode: step.exitCode,
      pid: step.pid,
      startedAt: step.startedAt,
      finishedAt: step.finishedAt,
      reason: reason?.text,
      reasonTruncated: reason?.limited || undefined,
      readiness: step.readiness
        ? {
            ...step.readiness,
            reason: readinessReason?.text,
            reasonTruncated: readinessReason?.limited || undefined,
          }
        : undefined,
      output: step.output
        ? { format: step.output.format, state: step.output.state }
        : undefined,
    };
  });
  const metadata = { ...workflow, steps };
  let header = JSON.stringify({ workflow: metadata });
  if (Buffer.byteLength(header) > MAX_WORKFLOW_TEXT_BYTES / 2)
    header = JSON.stringify({
      workflow: {
        ...metadata,
        stepDetailsOmitted: true,
        steps: steps.map((step) => ({
          id: step.id,
          state: step.state,
          exitCode: step.exitCode,
          readiness: step.readiness?.state,
          output: step.output,
        })),
      },
    });
  const lines = [header];
  let remaining =
    MAX_WORKFLOW_TEXT_BYTES - Buffer.byteLength(header) - PREVIEW_NOTICE_RESERVE_BYTES;
  let omittedOutputs = 0;
  for (const step of workflow.steps) {
    if (!step.output) continue;
    // Parsed stdout is authoritative, but failed parsing must retain its raw preview
    const output =
      step.output.value !== undefined || step.output.records !== undefined
        ? { ...step.output, stdoutText: undefined }
        : step.output;
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
          error: inlineReason(output.error)?.text,
          inlineOmitted: true,
        },
      });
      omittedOutputs++;
    }
    const bytes = Buffer.byteLength(text) + 1;
    if (bytes > remaining) {
      continue;
    }
    lines.push(text);
    remaining -= bytes;
  }
  if (omittedOutputs)
    lines.push(
      JSON.stringify({
        workflowPreview: {
          inlineOmitted: true,
          omittedOutputs,
          maxBytes: MAX_WORKFLOW_TEXT_BYTES,
        },
      }),
    );
  return lines.join("\n");
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
