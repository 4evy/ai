import { join } from "node:path";
import { attempt, operationEffect, run } from "@ai/core/effect/effect";
import { Semaphore } from "effect";
import * as v from "valibot";
import {
  type WorkflowResult,
  type WorkflowStepResult,
  workflowResultSchema,
} from "#farstep/protocol/workflow/workflow";
import { exists } from "../../state";
import {
  markWorkflowUnknown,
  readJournal,
  type WorkflowJournal,
  type WorkflowManifest,
} from "./records";
import {
  immutableWorkflowWrite,
  withWorkflowLock,
  writeWorkflowRecord,
} from "./storage";

interface WorkflowCompletion {
  cancelled: boolean;
  timedOut: boolean;
  persistenceFailed: boolean;
}

const WORKFLOW_EXIT_CODES: Readonly<Partial<Record<WorkflowResult["state"], number>>> =
  {
    succeeded: 0,
    skipped: 0,
    cancelled: 130,
  };

export class WorkflowLedger {
  private readonly writes = Semaphore.makeUnsafe(1);
  readonly steps: Map<string, WorkflowStepResult>;

  private constructor(
    private readonly path: string,
    readonly manifest: WorkflowManifest,
    readonly journal: WorkflowJournal,
  ) {
    this.steps = new Map(journal.result.steps.map((step) => [step.id, step]));
  }

  static async claim(
    directory: string,
    manifest: WorkflowManifest,
  ): Promise<WorkflowLedger> {
    return withWorkflowLock(directory, "mutation", async () => {
      if (await exists(join(directory, "execution.json")))
        throw new Error(
          "Workflow execution was already attempted; no steps were replayed",
        );
      const path = join(directory, "journal.json");
      const previous = await readJournal(path, manifest);
      if (
        previous.phase !== "prepared" ||
        previous.result.fingerprint !== manifest.prepared.fingerprint
      )
        throw new Error("Workflow ledger is not an unexecuted matching preparation");
      await immutableWorkflowWrite(join(directory, "execution.json"), {
        workerPid: process.pid,
        startedAt: Date.now(),
        fingerprint: manifest.prepared.fingerprint,
      });
      const journal: WorkflowJournal = {
        phase: "active",
        workerPid: process.pid,
        result: previous.result,
      };
      journal.result.state = "running";
      await writeWorkflowRecord(path, journal);
      // Recovery ownership begins only after the active journal is durable
      return new WorkflowLedger(path, manifest, journal);
    });
  }

  async save(): Promise<void> {
    await run(
      operationEffect(
        "workflow.persist",
        { component: "workflow", phase: this.journal.phase },
        this.writes.withPermits(1)(
          attempt(() => writeWorkflowRecord(this.path, this.journal)),
        ),
      ),
    );
  }

  async recover(): Promise<void> {
    markWorkflowUnknown(
      this.journal,
      "Workflow controller failed without a durable step completion",
    );
    try {
      await writeWorkflowRecord(this.path, this.journal);
    } catch {
      /* Inspection reconciles an interrupted ledger as unknown */
    }
  }

  private completedState({
    cancelled,
    timedOut,
  }: WorkflowCompletion): WorkflowResult["state"] {
    const steps = this.journal.result.steps;
    if (cancelled) return "cancelled";
    if (timedOut || steps.some((step) => step.state === "failed")) return "failed";
    if (steps.some((step) => step.state === "cancelled")) return "cancelled";
    if (steps.some((step) => step.state === "blocked")) return "failed";
    return steps.every((step) => step.state === "skipped") ? "skipped" : "succeeded";
  }

  complete(completion: WorkflowCompletion): number {
    const { result } = this.journal;
    result.finishedAt = Date.now();
    if (
      completion.persistenceFailed ||
      result.steps.some((step) => step.state === "unknown")
    ) {
      this.journal.phase = "unknown";
      result.state = "unknown";
    } else {
      this.journal.phase = "complete";
      result.state = this.completedState(completion);
    }
    v.parse(workflowResultSchema, result);
    return WORKFLOW_EXIT_CODES[result.state] ?? (completion.timedOut ? 124 : 1);
  }
}
