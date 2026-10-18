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
  workflowCancelSchema,
  workflowInspectSchema,
  workflowStartSchema,
} from "#farstep/protocol/workflow/workflow";
import { exists, paths, privateRead, withMaintenanceLock } from "../../state";
import type { JobBrokerClient } from "../broker/client";
import { assertWorkflowSpec, readWorkflowManifest } from "./manifest";
import { WorkflowPreparation } from "./preparation";
import { presentResult } from "./presentation";
import {
  cancellationRequest,
  markWorkflowUnknown,
  readJournal,
  reservationSchema,
  type WorkflowManifest,
  workflowCancellationSchema,
  workflowJournalSchema,
} from "./records";
import { durableWorkflowWrite, withWorkflowLock, workflowDirectory } from "./storage";

export { readWorkflowManifest } from "./manifest";
export {
  initialWorkflowResult,
  markWorkflowUnknown,
  type WorkflowJournal,
  type WorkflowManifest,
  workflowCancellationSchema,
  workflowJournalSchema,
} from "./records";
export {
  durableWorkflowWrite,
  immutableWorkflowWrite,
  withWorkflowLock,
} from "./storage";

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
    const directory = await workflowDirectory(this.directory, name);
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

  private async existing(manifest: WorkflowManifest): Promise<JobSnapshot | undefined> {
    let described: JobRpcResult<"describe">;
    try {
      // list omits older terminal jobs; describe addresses the full registry
      described = await this.broker.request({
        op: "describe",
        name: manifest.prepared.name,
      });
    } catch (error) {
      const missing = `Unknown snapshot ${manifest.prepared.name}`;
      const unknownJob = `Unknown job ${manifest.prepared.name}`;
      if (
        error instanceof Error &&
        (error.message === unknownJob ||
          error.message === missing ||
          error.message.startsWith(`${missing}. Available: `))
      )
        return undefined;
      throw error;
    }
    if (described.snapshot.owner !== this.owner)
      throw new Error("Workflow native job belongs to another owner");
    assertWorkflowSpec(described.spec, manifest.prepared.spec);
    return described.snapshot;
  }

  async start(
    value: unknown,
    beforeStart: (spec: JobSpec) => Promise<void>,
  ): Promise<JobRpcResult<"start">> {
    const request = v.parse(workflowStartSchema, value);
    const { directory, manifest } = await this.load(request.name);
    if (manifest.prepared.fingerprint !== request.fingerprint)
      throw new Error("Workflow start fingerprint mismatch");
    return withWorkflowLock(directory, "mutation", async () => {
      await beforeStart(manifest.prepared.spec);
      const path = join(directory, "start.json");
      const reservation = (await exists(path))
        ? v.parse(reservationSchema, JSON.parse(await privateRead(path)))
        : undefined;
      const existing = await this.existing(manifest);
      if (existing) {
        if (reservation?.nativeId && reservation.nativeId !== existing.id)
          throw new Error(
            "Workflow native generation changed; launch cannot be replayed",
          );
        await durableWorkflowWrite(path, {
          attemptedAt: reservation?.attemptedAt ?? Date.now(),
          nativeId: existing.id,
        });
        return { op: "start", snapshot: existing, readyTimedOut: false };
      }
      if (reservation || (await exists(join(directory, "execution.json"))))
        throw new Error("Workflow start outcome is unknown; no work was replayed");
      if (await exists(join(directory, "cancel.json"))) {
        const cancel = v.parse(
          workflowCancellationSchema,
          JSON.parse(await privateRead(join(directory, "cancel.json"))),
        );
        if (cancel.all) throw new Error("Workflow was cancelled before launch");
      }
      return withMaintenanceLock(async () => {
        if (!(await exists(join(paths().state, "installer.json"))))
          throw new Error("Helper is not activated; workflow launches are disabled");
        // This fence precedes the irreversible native request, including its reply
        const attemptedAt = Date.now();
        await durableWorkflowWrite(path, { attemptedAt });
        const response = await this.broker.request({
          op: "start",
          spec: manifest.prepared.spec,
          owner: this.owner,
        });
        await durableWorkflowWrite(path, {
          attemptedAt,
          nativeId: response.snapshot.id,
        });
        return response;
      });
    });
  }

  async inspect(value: unknown): Promise<WorkflowResult> {
    const { name, step: selectedStep } = v.parse(workflowInspectSchema, value);
    const { directory, manifest } = await this.load(name);
    if (selectedStep && !manifest.input.tasks.some((task) => task.id === selectedStep))
      throw new Error("Unknown workflow step to inspect");
    return withWorkflowLock(directory, "mutation", async () => {
      const path = join(directory, "journal.json");
      const journal = await readJournal(path, manifest);
      if (
        journal.result.fingerprint !== manifest.prepared.fingerprint ||
        journal.result.name !== name
      )
        throw new Error("Workflow journal identity mismatch");
      if (journal.phase === "complete" || journal.phase === "unknown")
        return presentResult(journal.result, selectedStep);
      const native = await this.existing(manifest);
      const attempted = await exists(join(directory, "start.json"));
      if ((!native && attempted) || (native && isJobTerminal(native.state))) {
        markWorkflowUnknown(
          journal,
          "Workflow worker exited without a durable completion; child outcomes are unknown",
        );
        await durableWorkflowWrite(path, journal);
      } else if (native && journal.phase === "prepared") {
        // A started native root is not evidence that any child completed
        return presentResult({ ...journal.result, state: "running" }, selectedStep);
      }
      return presentResult(journal.result, selectedStep);
    });
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
      await durableWorkflowWrite(path, cancellationRequest(previous, request.step));
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
        await durableWorkflowWrite(journalPath, journal);
      }
    });
    return this.inspect({ name: request.name });
  }
}
