import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { uuidSchema } from "farstep/protocol/identity";
import { MAX_WORKFLOW_STEPS } from "farstep/protocol/workflow/schemas";
import * as v from "valibot";
import {
  type WorkflowResult,
  workflowPreparedSchema,
  workflowPrepareSchema,
  workflowResultSchema,
} from "#farstep/protocol/workflow/workflow";
import { privateRead } from "../../state";
import { STEP_POLICY } from "./states";

export const identityShape = {
  scopeId: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
  owner: v.pipe(v.string(), v.minLength(1)),
  installationId: uuidSchema,
};
export const workflowManifestSchema = v.strictObject({
  ...identityShape,
  input: workflowPrepareSchema,
  prepared: workflowPreparedSchema,
});
export type WorkflowManifest = v.InferOutput<typeof workflowManifestSchema>;
export const workflowJournalSchema = v.pipe(
  v.strictObject({
    phase: v.picklist(["prepared", "active", "complete", "unknown"]),
    workerPid: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
    result: workflowResultSchema,
  }),
  v.check(({ phase, result }) => {
    switch (phase) {
      case "prepared":
        return result.state === "prepared";
      case "active":
        return result.state === "running";
      case "unknown":
        return result.state === "unknown";
      case "complete":
        return (
          result.state !== "prepared" &&
          result.state !== "running" &&
          result.state !== "unknown"
        );
    }
  }, "Workflow journal phase and result state disagree"),
);
export type WorkflowJournal = v.InferOutput<typeof workflowJournalSchema>;

export function markWorkflowUnknown(
  journal: WorkflowJournal,
  reason: string,
  finishedAt: number | null = Date.now(),
): void {
  journal.phase = "unknown";
  journal.result.state = "unknown";
  journal.result.finishedAt = finishedAt ?? undefined;
  for (const step of journal.result.steps) {
    const interrupted = STEP_POLICY[step.state].interrupted;
    if (!interrupted) continue;
    step.state = interrupted;
    step.finishedAt = journal.result.finishedAt;
    step.reason = reason;
  }
}
export const workflowCancellationSchema = v.strictObject({
  all: v.boolean(),
  steps: v.pipe(v.array(v.string()), v.maxLength(MAX_WORKFLOW_STEPS)),
  requestedAt: v.pipe(v.number(), v.finite(), v.minValue(0)),
});
export const reservationSchema = v.strictObject({
  attemptedAt: v.pipe(v.number(), v.finite(), v.minValue(0)),
  nativeId: v.optional(v.string()),
});
export const executionSchema = v.strictObject({
  workerPid: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  startedAt: v.pipe(v.number(), v.finite(), v.minValue(0)),
  fingerprint: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
});
export const requestIndexSchema = v.strictObject({
  name: v.string(),
  fingerprint: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
});

export function initialWorkflowResult(manifest: WorkflowManifest): WorkflowResult {
  return {
    name: manifest.prepared.name,
    kind: manifest.input.kind,
    requestId: manifest.input.requestId,
    fingerprint: manifest.prepared.fingerprint,
    state: "prepared",
    createdAt: manifest.prepared.createdAt,
    steps: manifest.input.tasks.map(({ id, dependsOn }) => ({
      id,
      dependsOn,
      state: "queued",
    })),
  };
}

export function cancellationRequest(
  previous: v.InferOutput<typeof workflowCancellationSchema> | undefined,
  step: string | undefined,
) {
  return {
    all: previous?.all === true || step === undefined,
    steps: [...new Set([...(previous?.steps ?? []), ...(step ? [step] : [])])],
    requestedAt: previous?.requestedAt ?? Date.now(),
  };
}

export async function readJournal(
  path: string,
  manifest: WorkflowManifest,
): Promise<WorkflowJournal> {
  return (
    (await readWorkflowRecord(path, workflowJournalSchema)) ?? {
      phase: "prepared",
      result: initialWorkflowResult(manifest),
    }
  );
}

export async function readWorkflowRecord<S extends v.GenericSchema>(
  path: string,
  schema: S,
): Promise<v.InferOutput<S> | undefined> {
  try {
    return v.parse(schema, JSON.parse(await privateRead(path)));
  } catch (error) {
    if (!isEnoent(error)) throw error;
    return undefined;
  }
}
