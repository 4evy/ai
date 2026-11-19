import { join } from "node:path";
import type {
  JobRpcResult,
  JobSnapshot,
  JobSpec,
} from "farstep/protocol/jobs/protocol";
import { isJobTerminal } from "farstep/protocol/jobs/states";
import * as v from "valibot";
import {
  type WorkflowResult,
  type WorkflowStartFailure,
  workflowCancelSchema,
  workflowInspectSchema,
  workflowStartSchema,
} from "#farstep/protocol/workflow/workflow";
import { exists, paths, privateRead, withMaintenanceLock } from "../../state";
import { type JobBrokerClient, JobBrokerUnavailableError } from "../broker/client";
import { assertWorkflowSpec, readWorkflowManifest } from "./manifest";
import { WorkflowPreparation } from "./preparation";
import { presentResult } from "./presentation";
import {
  cancellationRequest,
  executionSchema,
  initialWorkflowResult,
  markWorkflowUnknown,
  readWorkflowRecord,
  reservationSchema,
  type WorkflowManifest,
  workflowCancellationSchema,
  workflowJournalSchema,
} from "./records";
import { withWorkflowLock, workflowDirectory, writeWorkflowRecord } from "./storage";

export class WorkflowService {
  private readonly preparation: WorkflowPreparation;

  constructor(
    private readonly broker: JobBrokerClient,
    private readonly directory: string,
    private readonly scopeId: string,
    private readonly owner: string,
    private readonly installationId: string,
    baselineEnv: Record<string, string>,
  ) {
    this.preparation = new WorkflowPreparation(
      directory,
      scopeId,
      owner,
      installationId,
      baselineEnv,
      (name) => this.load(name),
    );
  }

  prepare(value: unknown) {
    return this.preparation.prepare(value);
  }

  private async load(
    name: string,
  ): Promise<{ directory: string; manifest: WorkflowManifest }> {
    const directory = await workflowDirectory(this.directory, name, false);
    const manifest = await readWorkflowManifest(join(directory, "manifest.json"));
    if (
      manifest.scopeId !== this.scopeId ||
      manifest.owner !== this.owner ||
      manifest.installationId !== this.installationId ||
      manifest.prepared.name !== name
    )
      throw new Error("Workflow identity or remote owner mismatch");
    return { directory, manifest };
  }

  private async existing(
    manifest: WorkflowManifest,
    signal?: AbortSignal,
    readOnly = false,
  ): Promise<JobSnapshot> {
    // list omits older terminal jobs; describe addresses the full registry
    const described = await this.broker.request(
      { op: "describe", name: manifest.prepared.name },
      signal,
      { readOnly },
    );
    if (described.snapshot.owner !== this.owner)
      throw new Error("Workflow native job belongs to another owner");
    assertWorkflowSpec(described.spec, manifest.prepared.spec);
    return described.snapshot;
  }

  async start(
    value: unknown,
    beforeStart: (spec: JobSpec) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<JobRpcResult<"start"> | WorkflowStartFailure> {
    let outcome: WorkflowStartFailure["outcome"] = "definitely-not-started";
    try {
      signal?.throwIfAborted();
      const request = v.parse(workflowStartSchema, value);
      const deadline = Date.now() + request.lockTimeoutMs;
      const prestart = AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(request.lockTimeoutMs),
      ]);
      const { directory, manifest } = await this.load(request.name);
      if (manifest.prepared.fingerprint !== request.fingerprint)
        throw new Error("Workflow start fingerprint mismatch");
      return await withWorkflowLock(
        directory,
        "mutation",
        async () => {
          prestart.throwIfAborted();
          const path = join(directory, "start.json");
          const reservation = await readWorkflowRecord(path, reservationSchema);
          const execution = await readWorkflowRecord(
            join(directory, "execution.json"),
            executionSchema,
          );
          if (execution && execution.fingerprint !== manifest.prepared.fingerprint)
            throw new Error("Workflow execution identity mismatch");
          if (reservation || execution) {
            outcome = "unknown";
            const existing = await this.existing(manifest, prestart, true);
            if (reservation?.nativeId && reservation.nativeId !== existing.id)
              throw new Error(
                "Workflow native generation changed; launch cannot be replayed",
              );
            return { op: "start", snapshot: existing, readyTimedOut: false };
          }
          const cancel = await readWorkflowRecord(
            join(directory, "cancel.json"),
            workflowCancellationSchema,
          );
          if (cancel?.all) throw new Error("Workflow was cancelled before launch");
          return withMaintenanceLock(
            async () => {
              prestart.throwIfAborted();
              if (!(await exists(join(paths().state, "installer.json"))))
                throw new Error(
                  "Helper is not activated; workflow launches are disabled",
                );
              await beforeStart(manifest.prepared.spec);
              prestart.throwIfAborted();
              // Fence publication can fail after becoming visible or durable
              // Never retry automatically once publication begins
              outcome = "unknown";
              const attemptedAt = Date.now();
              await writeWorkflowRecord(path, { attemptedAt });
              const response = await this.broker.request({
                op: "start",
                spec: manifest.prepared.spec,
                owner: this.owner,
              });
              await writeWorkflowRecord(path, {
                attemptedAt,
                nativeId: response.snapshot.id,
              });
              return response;
            },
            { signal: prestart, timeoutMs: Math.max(1, deadline - Date.now()) },
          );
        },
        { signal: prestart, timeoutMs: request.lockTimeoutMs },
      );
    } catch (error) {
      return {
        op: "start",
        outcome,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async inspect(value: unknown): Promise<WorkflowResult> {
    const { name, step: selectedStep } = v.parse(workflowInspectSchema, value);
    const { directory, manifest } = await this.load(name);
    if (selectedStep && !manifest.input.tasks.some((task) => task.id === selectedStep))
      throw new Error("Unknown workflow step to inspect");
    // Atomic records can be read without creating directories, locks or receipts
    const persisted = await readWorkflowRecord(
      join(directory, "journal.json"),
      workflowJournalSchema,
    );
    const journal = persisted ?? {
      phase: "prepared" as const,
      result: initialWorkflowResult(manifest),
    };
    if (
      journal.result.fingerprint !== manifest.prepared.fingerprint ||
      journal.result.name !== name ||
      journal.result.kind !== manifest.input.kind ||
      journal.result.requestId !== manifest.input.requestId ||
      journal.result.createdAt !== manifest.prepared.createdAt ||
      journal.result.steps.length !== manifest.input.tasks.length ||
      journal.result.steps.some((step, index) => {
        const task = manifest.input.tasks[index];
        return (
          !task ||
          step.id !== task.id ||
          step.dependsOn.length !== task.dependsOn.length ||
          step.dependsOn.some((id, dependency) => id !== task.dependsOn[dependency])
        );
      })
    )
      throw new Error("Workflow journal identity mismatch");
    const reservation = await readWorkflowRecord(
      join(directory, "start.json"),
      reservationSchema,
    );
    const execution = await readWorkflowRecord(
      join(directory, "execution.json"),
      executionSchema,
    );
    await readWorkflowRecord(
      join(directory, "cancel.json"),
      workflowCancellationSchema,
    );
    if (execution && execution.fingerprint !== manifest.prepared.fingerprint)
      throw new Error("Workflow execution identity mismatch");
    let native: JobSnapshot | undefined;
    let unavailable: JobBrokerUnavailableError | undefined;
    const attempted =
      !!reservation ||
      !!execution ||
      journal.phase === "active" ||
      journal.phase === "unknown";
    if (attempted) {
      try {
        native = await this.existing(manifest, undefined, true);
      } catch (error) {
        if (!(error instanceof JobBrokerUnavailableError)) throw error;
        unavailable = error;
      }
    }
    if (reservation?.nativeId && native && reservation.nativeId !== native.id)
      throw new Error("Workflow native generation changed; launch cannot be replayed");
    const durableState = persisted?.result.state;
    let source: NonNullable<WorkflowResult["observation"]>["source"] = persisted
      ? "journal"
      : "preparation";
    if (journal.phase !== "complete" && journal.phase !== "unknown") {
      if (
        (!native && (reservation || execution || journal.phase === "active")) ||
        (native && isJobTerminal(native.state))
      ) {
        markWorkflowUnknown(
          journal,
          unavailable
            ? "Workflow broker is unavailable; child execution cannot be confirmed"
            : "Workflow worker exited without a durable completion; child outcomes are unknown",
          // Inspection establishes uncertainty, not a child completion time
          null,
        );
        source = native || unavailable ? "broker" : "fence";
      } else if (native && journal.phase === "prepared") {
        // A started native root is not evidence that any child completed
        journal.result.state = "running";
        source = "broker";
      }
    }
    return presentResult(
      {
        ...journal.result,
        observation: {
          source,
          durableState,
          broker: !attempted
            ? "not-queried"
            : unavailable
              ? "unavailable"
              : "available",
          reason: unavailable?.message,
          observedAt: Date.now(),
        },
      },
      selectedStep,
    );
  }

  async cancel(value: unknown): Promise<WorkflowResult> {
    const request = v.parse(workflowCancelSchema, value);
    const { directory, manifest } = await this.load(request.name);
    if (request.step && !manifest.input.tasks.some((task) => task.id === request.step))
      throw new Error("Unknown workflow step to cancel");
    await withWorkflowLock(directory, "mutation", async () => {
      const path = join(directory, "cancel.json");
      const previous = (await exists(path))
        ? v.parse(workflowCancellationSchema, JSON.parse(await privateRead(path)))
        : undefined;
      await writeWorkflowRecord(path, cancellationRequest(previous, request.step));
      if (
        !(await exists(join(directory, "start.json"))) &&
        !(await exists(join(directory, "execution.json")))
      ) {
        const journalPath = join(directory, "journal.json");
        const journal = v.parse(
          workflowJournalSchema,
          JSON.parse(await privateRead(journalPath)),
        );
        for (const step of journal.result.steps) {
          if (step.state === "queued" && (!request.step || request.step === step.id)) {
            step.state = "cancelled";
            step.reason = "Cancelled before launch";
            step.finishedAt = Date.now();
          }
        }
        if (!request.step) {
          journal.phase = "complete";
          journal.result.state = "cancelled";
          journal.result.finishedAt = Date.now();
        }
        await writeWorkflowRecord(journalPath, journal);
      }
    });
    return this.inspect({ name: request.name });
  }
}
