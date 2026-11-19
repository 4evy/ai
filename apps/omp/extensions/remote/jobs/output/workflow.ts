import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { WorkflowResult } from "farstep/protocol/workflow/workflow";
import { REMOTE_TOOLS } from "farstep/remote/tools/names";
import type { JobRecord } from "../types";

const MAX_INLINE_REASON_BYTES = 120;
const MAX_WORKFLOW_TEXT_BYTES = 64 * 1024;
const PREVIEW_NOTICE_RESERVE_BYTES = 512;

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

export function workflowText(
  workflow: WorkflowResult,
  job: Pick<JobRecord, "name" | "connectionId">,
): string {
  const steps = workflow.steps.map((step) => {
    const reason = inlineReason(step.reason);
    const readinessReason = inlineReason(step.readiness?.reason);
    return {
      id: step.id,
      recovery: {
        tool: REMOTE_TOOLS.job,
        arguments: { action: "status", job: job.name, step: step.id },
      },
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
        ? {
            format: step.output.format,
            state: step.output.state,
            previewState: step.output.previewState,
            persistenceState: step.output.persistenceState,
            parsingState: step.output.parsingState,
          }
        : undefined,
    };
  });
  const metadata = {
    ...workflow,
    persistenceState:
      workflow.observation?.source === "journal" ? "durable" : "unknown",
    steps,
  };
  const recovery = (step: (typeof workflow.steps)[number]) => ({
    inspect: {
      tool: REMOTE_TOOLS.job,
      arguments: { action: "status", job: job.name, step: step.id },
    },
    artifacts: (["stdout", "stderr"] as const).flatMap((stream) => {
      const artifact = step.output?.[stream];
      return artifact
        ? [
            {
              stream,
              completeness: artifact.truncated
                ? "truncated"
                : step.output?.persistenceState === "complete"
                  ? "complete"
                  : "unknown",
              retainedBytes: artifact.retainedBytes,
              read: {
                tool: REMOTE_TOOLS.read,
                arguments: { connection: job.connectionId, path: artifact.path },
              },
            },
          ]
        : [];
    }),
  });
  let header = JSON.stringify({ workflow: metadata });
  if (Buffer.byteLength(header) > MAX_WORKFLOW_TEXT_BYTES / 2)
    header = JSON.stringify({
      workflow: {
        ...metadata,
        stepDetailsOmitted: true,
        steps: steps.map((step) => ({
          id: step.id,
          recovery: step.recovery,
          state: step.state,
          exitCode: step.exitCode,
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
    const recover = recovery(step);
    let text = JSON.stringify({ step: step.id, output, recovery: recover });
    let omitted = false;
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
          previewState: "omitted",
        },
        recovery: recover,
      });
      omitted = true;
    }
    const bytes = Buffer.byteLength(text) + 1;
    if (bytes > remaining) {
      omittedOutputs++;
      continue;
    }
    lines.push(text);
    if (omitted) omittedOutputs++;
    remaining -= bytes;
  }
  if (omittedOutputs)
    lines.push(
      JSON.stringify({
        workflowPreview: {
          inlineOmitted: true,
          omittedOutputs,
          maxBytes: MAX_WORKFLOW_TEXT_BYTES,
          recovery: {
            tool: REMOTE_TOOLS.job,
            arguments: { action: "status", job: job.name },
          },
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
