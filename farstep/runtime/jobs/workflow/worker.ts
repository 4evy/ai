import { dirname, join } from "node:path";
import {
  attempt,
  Lifetime,
  operation,
  operationEffect,
  run,
} from "@ai/core/effect/effect";
import { postmortem } from "@oh-my-pi/pi-utils";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import {
  Deferred,
  Effect,
  Fiber,
  FiberMap,
  FiberSet,
  Schedule,
  Scope,
  Semaphore,
} from "effect";
import * as v from "valibot";
import {
  type WorkflowResult,
  type WorkflowStepResult,
  workflowResultSchema,
} from "#farstep/protocol/workflow/workflow";
import { exists, privateDirectory, privateRead } from "../../state";
import type { RunningChild, StopKind } from "./child";
import { STEP_POLICY } from "./states";
import { type StepContext, type WorkflowState, WorkflowStep } from "./step";
import {
  durableWorkflowWrite,
  immutableWorkflowWrite,
  initialWorkflowResult,
  markWorkflowUnknown,
  readWorkflowManifest,
  type WorkflowJournal,
  type WorkflowManifest,
  withWorkflowLock,
  workflowCancellationSchema,
  workflowJournalSchema,
} from "./workflow";

const WORKFLOW_EXIT_CODES: Readonly<Partial<Record<WorkflowResult["state"], number>>> =
  {
    succeeded: 0,
    skipped: 0,
    cancelled: 130,
  };

class WorkflowWorker implements StepContext {
  readonly state: WorkflowState = {
    frozen: false,
    cancelled: false,
    rootReason: "",
    persistenceFailed: false,
  };
  private timedOut = false;
  readonly children = new Map<string, RunningChild>();
  private readonly pending: FiberMap.FiberMap<string, void, unknown>;
  readonly cancelledSteps = new Set<string>();
  private readonly stopping: FiberSet.FiberSet<void, unknown>;
  private readonly completed = Deferred.makeUnsafe<void>();
  private readonly writes = Semaphore.makeUnsafe(1);
  private rootTimer: Fiber.Fiber<void> | undefined;
  private journal: WorkflowJournal | undefined;
  private journalPath: string | undefined;
  manifest!: WorkflowManifest;
  private ledger!: WorkflowJournal;
  private steps = new Map<string, WorkflowStepResult>();
  readonly directory: string;
  readonly artifacts: string;

  constructor(
    private readonly record: string,
    readonly lifetime: Lifetime,
    private readonly workflowStarted: number,
  ) {
    this.pending = Effect.runSync(
      FiberMap.make<string, void, unknown>().pipe(Scope.provide(lifetime.scope)),
    );
    this.stopping = Effect.runSync(
      FiberSet.make<void, unknown>().pipe(Scope.provide(lifetime.scope)),
    );
    this.directory = dirname(record);
    this.artifacts = join(this.directory, "artifacts");
  }

  requestStop(kind: StopKind, reason: string, cancelRoot = kind === "cancelled"): void {
    this.state.frozen = true;
    this.state.rootReason = reason;
    if (cancelRoot) this.state.cancelled = true;
    for (const child of this.children.values()) {
      FiberSet.addUnsafe(
        this.stopping,
        this.lifetime.fork(
          Effect.uninterruptible(attempt(() => child.stop(kind, reason))),
        ),
      );
    }
  }

  private async recoverWorkflow(): Promise<void> {
    this.requestStop("failed", "Workflow controller failed; completion is unknown");
    await run(
      Effect.all(
        [
          Effect.forEach(this.pending, ([, fiber]) => Fiber.await(fiber), {
            discard: true,
            concurrency: "unbounded",
          }),
          FiberSet.awaitEmpty(this.stopping),
        ],
        { concurrency: "unbounded", discard: true },
      ),
    );
    if (this.journal && this.journalPath) {
      markWorkflowUnknown(
        this.journal,
        "Workflow controller failed without a durable step completion",
      );
      try {
        await durableWorkflowWrite(this.journalPath, this.journal);
      } catch {
        /* Inspection reconciles an interrupted ledger as unknown */
      }
    }
  }

  async save(): Promise<void> {
    try {
      await run(
        operationEffect(
          "workflow.persist",
          { component: "workflow", phase: this.ledger.phase },
          this.writes.withPermits(1)(
            attempt(() =>
              durableWorkflowWrite(join(this.directory, "journal.json"), this.ledger),
            ),
          ),
        ),
      );
    } catch (error) {
      this.state.persistenceFailed = true;
      this.requestStop(
        "failed",
        "Workflow result persistence failed; outcomes may be unknown",
      );
      throw error;
    }
  }

  async refreshCancellation(): Promise<void> {
    try {
      const cancellation = v.parse(
        workflowCancellationSchema,
        JSON.parse(await privateRead(join(this.directory, "cancel.json"))),
      );
      for (const id of cancellation.steps) this.cancelledSteps.add(id);
      if (cancellation.all)
        this.requestStop("cancelled", "Workflow cancelled by request");
      for (const [id, child] of this.children) {
        if (this.cancelledSteps.has(id))
          await child.stop("cancelled", "Workflow step cancelled by request");
      }
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }

  failQueue(step: WorkflowStepResult): void {
    if (!STEP_POLICY[step.state].stopsQueue) return;
    if (this.manifest.input.onFailure === "continue") return;
    this.state.frozen = true;
    this.state.rootReason = `Workflow stopped scheduling after step ${step.id} ${step.state}`;
    if (this.manifest.input.onFailure === "cancel")
      this.requestStop("cancelled", this.state.rootReason, false);
  }

  private completedState(): WorkflowJournal["result"]["state"] {
    if (this.state.cancelled) return "cancelled";
    if (
      this.timedOut ||
      this.ledger.result.steps.some((step) => step.state === "failed")
    )
      return "failed";
    if (this.ledger.result.steps.some((step) => step.state === "cancelled"))
      return "cancelled";
    if (this.ledger.result.steps.some((step) => step.state === "blocked"))
      return "failed";
    return this.ledger.result.steps.every((step) => step.state === "skipped")
      ? "skipped"
      : "succeeded";
  }

  private completeLedger(): void {
    this.ledger.result.finishedAt = Date.now();
    if (
      this.state.persistenceFailed ||
      this.ledger.result.steps.some((step) => step.state === "unknown")
    ) {
      this.ledger.phase = "unknown";
      this.ledger.result.state = "unknown";
    } else {
      this.ledger.phase = "complete";
      this.ledger.result.state = this.completedState();
    }
  }

  private async finishWorkflow(): Promise<void> {
    v.parse(workflowResultSchema, this.ledger.result);
    await this.save();
    await run(
      Effect.logInfo("Workflow finished").pipe(
        Effect.annotateLogs({
          component: "workflow",
          state: this.ledger.result.state,
          phase: this.ledger.phase,
          elapsedMs: Math.round(performance.now() - this.workflowStarted),
        }),
      ),
    );
    process.exitCode =
      WORKFLOW_EXIT_CODES[this.ledger.result.state] ?? (this.timedOut ? 124 : 1);
  }

  private async blockQueuedSteps(): Promise<void> {
    let changed = false;
    for (const task of this.manifest.input.tasks) {
      const step = this.steps.get(task.id);
      if (step?.state !== "queued" || FiberMap.hasUnsafe(this.pending, task.id))
        continue;
      if (this.state.cancelled || this.cancelledSteps.has(task.id)) {
        step.state = "cancelled";
        step.reason = this.state.rootReason || "Workflow step cancelled before launch";
      } else if (this.state.frozen) {
        step.state = "blocked";
        step.reason = this.state.rootReason;
      } else if (
        task.dependsOn.some((id) => {
          const dependency = this.steps.get(id);
          return (
            dependency &&
            STEP_POLICY[dependency.state].terminal &&
            !STEP_POLICY[dependency.state].satisfiesDependency
          );
        })
      ) {
        step.state = "blocked";
        step.reason = "A workflow dependency did not succeed or skip";
      } else continue;
      step.finishedAt = Date.now();
      changed = true;
    }
    if (changed) await this.save();
  }

  private scheduleSteps(): void {
    for (const task of this.manifest.input.tasks) {
      if (
        Effect.runSync(FiberMap.size(this.pending)) >=
          this.manifest.input.concurrency ||
        this.state.frozen
      )
        break;
      const step = this.steps.get(task.id);
      if (
        step?.state !== "queued" ||
        FiberMap.hasUnsafe(this.pending, task.id) ||
        !task.dependsOn.every((id) => {
          const dependency = this.steps.get(id);
          return dependency && STEP_POLICY[dependency.state].satisfiesDependency;
        })
      )
        continue;
      // Interruption requests native cleanup, then waits for the durable outcome
      const work = this.lifetime.fork(
        Effect.uninterruptible(
          attempt(() =>
            operation("workflow.step", { component: "workflow", stepId: task.id }, () =>
              new WorkflowStep(task, step, this).run(),
            ),
          ),
        ),
      );
      FiberMap.setUnsafe(this.pending, task.id, work);
    }
  }

  private async drainWorkflow(): Promise<void> {
    await run(
      attempt(async () => {
        await this.refreshCancellation();
        for (const child of this.children.values()) child.sample();
        await this.blockQueuedSteps();
        this.scheduleSteps();
        return (
          this.state.persistenceFailed ||
          (Effect.runSync(FiberMap.size(this.pending)) === 0 &&
            this.ledger.result.steps.every((step) => STEP_POLICY[step.state].terminal))
        );
      }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced(50),
          until: (done) => done,
        }),
      ),
    );
    await run(
      Effect.forEach(this.pending, ([, fiber]) => Fiber.await(fiber), {
        concurrency: "unbounded",
        discard: true,
      }),
    );
    await run(FiberSet.awaitEmpty(this.stopping));
    if (this.rootTimer) await run(Fiber.interrupt(this.rootTimer));
  }

  private async claim(): Promise<WorkflowJournal> {
    return withWorkflowLock(this.directory, "mutation", async () => {
      if (await exists(join(this.directory, "execution.json")))
        throw new Error(
          "Workflow execution was already attempted; no steps were replayed",
        );
      let previous: WorkflowJournal;
      try {
        previous = v.parse(
          workflowJournalSchema,
          JSON.parse(await privateRead(join(this.directory, "journal.json"))),
        );
      } catch (error) {
        if (!isEnoent(error)) throw error;
        previous = { phase: "prepared", result: initialWorkflowResult(this.manifest) };
      }
      if (
        previous.phase !== "prepared" ||
        previous.result.fingerprint !== this.manifest.prepared.fingerprint
      )
        throw new Error("Workflow ledger is not an unexecuted matching preparation");
      await immutableWorkflowWrite(join(this.directory, "execution.json"), {
        workerPid: process.pid,
        startedAt: Date.now(),
        fingerprint: this.manifest.prepared.fingerprint,
      });
      const claimed: WorkflowJournal = {
        phase: "active",
        workerPid: process.pid,
        result: previous.result,
      };
      claimed.result.state = "running";
      await durableWorkflowWrite(join(this.directory, "journal.json"), claimed);
      return claimed;
    });
  }

  private startDeadline(): void {
    if (this.manifest.input.timeoutSeconds > 0) {
      this.rootTimer = this.lifetime.fork(
        Effect.sleep(this.manifest.input.timeoutSeconds * 1000).pipe(
          Effect.andThen(
            Effect.sync(() => {
              this.timedOut = true;
              this.requestStop("failed", "Workflow deadline exceeded");
            }),
          ),
        ),
      );
    }
  }

  async run(): Promise<void> {
    const signals = (["SIGTERM", "SIGHUP", "SIGINT"] as const).map(
      (signal) =>
        [
          signal,
          () => this.requestStop("cancelled", `Workflow interrupted by ${signal}`),
        ] as const,
    );
    for (const [signal, handler] of signals) process.on(signal, handler);
    // SDK signal handlers must await our isolated child groups before exiting
    const cancelCleanup = postmortem.register("workflow-worker", async (reason) => {
      this.requestStop("cancelled", `Workflow cleanup requested by ${reason}`);
      await run(Deferred.await(this.completed));
    });
    try {
      this.manifest = await readWorkflowManifest(this.record);
      this.startDeadline();
      await privateDirectory(this.artifacts);
      this.journalPath = join(this.directory, "journal.json");
      this.ledger = await this.claim();
      this.journal = this.ledger;
      this.steps = new Map(this.ledger.result.steps.map((step) => [step.id, step]));
      await this.drainWorkflow();
      this.completeLedger();
      await this.finishWorkflow();
    } catch (error) {
      await this.recoverWorkflow();
      throw error;
    } finally {
      if (this.rootTimer) await run(Fiber.interrupt(this.rootTimer));
      for (const [signal, handler] of signals) process.off(signal, handler);
      cancelCleanup();
      Effect.runSync(Deferred.succeed(this.completed, undefined));
    }
  }
}

export async function runWorkflow(args: string[]): Promise<void> {
  const started = performance.now();
  if (args.length !== 2 || args[0] !== "--record" || !args[1])
    throw new Error("Invalid managed workflow invocation");
  await using lifetime = new Lifetime();
  await new WorkflowWorker(args[1], lifetime, started).run();
}
