import { dirname, join } from "node:path";
import { attempt, Lifetime, operation, run } from "@ai/core/effect/effect";
import { postmortem } from "@oh-my-pi/pi-utils";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { Deferred, Effect, Fiber, FiberMap, FiberSet, Schedule, Scope } from "effect";
import * as v from "valibot";
import type { WorkflowStepResult } from "#farstep/protocol/workflow/workflow";
import { privateDirectory, privateRead } from "../../state";
import type { RunningChild, StopKind } from "./child";
import { WorkflowLedger } from "./ledger";
import { readWorkflowManifest } from "./manifest";
import { type WorkflowManifest, workflowCancellationSchema } from "./records";
import { STEP_POLICY } from "./states";
import { type StepContext, type WorkflowState, WorkflowStep } from "./step";

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
  private rootTimer: Fiber.Fiber<void> | undefined;
  private ledger: WorkflowLedger | undefined;
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

  private get activeLedger(): WorkflowLedger {
    if (!this.ledger) throw new Error("Workflow execution has not been claimed");
    return this.ledger;
  }

  get manifest(): WorkflowManifest {
    return this.activeLedger.manifest;
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
    await this.ledger?.recover();
  }

  async save(): Promise<void> {
    try {
      await this.activeLedger.save();
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

  private async finishWorkflow(): Promise<void> {
    const ledger = this.activeLedger;
    const exitCode = ledger.complete({
      cancelled: this.state.cancelled,
      timedOut: this.timedOut,
      persistenceFailed: this.state.persistenceFailed,
    });
    await this.save();
    await run(
      Effect.logInfo("Workflow finished").pipe(
        Effect.annotateLogs({
          component: "workflow",
          state: ledger.journal.result.state,
          phase: ledger.journal.phase,
          elapsedMs: Math.round(performance.now() - this.workflowStarted),
        }),
      ),
    );
    process.exitCode = exitCode;
  }

  private async blockQueuedSteps(): Promise<void> {
    let changed = false;
    for (const task of this.manifest.input.tasks) {
      const step = this.activeLedger.steps.get(task.id);
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
          const dependency = this.activeLedger.steps.get(id);
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
      const step = this.activeLedger.steps.get(task.id);
      if (
        step?.state !== "queued" ||
        FiberMap.hasUnsafe(this.pending, task.id) ||
        !task.dependsOn.every((id) => {
          const dependency = this.activeLedger.steps.get(id);
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
            this.activeLedger.journal.result.steps.every(
              (step) => STEP_POLICY[step.state].terminal,
            ))
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

  private startDeadline(timeoutSeconds: number): void {
    if (timeoutSeconds > 0) {
      this.rootTimer = this.lifetime.fork(
        Effect.sleep(timeoutSeconds * 1000).pipe(
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
      const manifest = await readWorkflowManifest(this.record);
      this.startDeadline(manifest.input.timeoutSeconds);
      await privateDirectory(this.artifacts);
      this.ledger = await WorkflowLedger.claim(this.directory, manifest);
      await this.drainWorkflow();
      await this.finishWorkflow();
    } catch (error) {
      await this.recoverWorkflow();
      throw error;
    } finally {
      if (this.rootTimer) await run(Fiber.interrupt(this.rootTimer));
      for (const [signal, handler] of signals) process.off(signal, handler);
      cancelCleanup();
      Deferred.doneUnsafe(this.completed, Effect.void);
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
