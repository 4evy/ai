import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { attempt, type Lifetime, run } from "@ai/runtime/effect/effect";
import { errorMessage } from "@ai/values/error/error";
import { Process } from "@oh-my-pi/pi-natives";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { Deferred, Effect, Fiber } from "effect";
import type {
  WorkflowOutput,
  WorkflowStepResult,
  WorkflowTask,
} from "#farstep/protocol/workflow/workflow";
import { subreaperScript } from "#farstep/runtime/platform/processes";
import { privateDirectory } from "../../state";
import { type RunningChild, WorkflowChild } from "./child";
import { startCapture, type WorkflowCapture } from "./output";
import { evaluateGuards, waitForReady } from "./policy";
import type { WorkflowManifest } from "./records";
import { withWorkflowLock } from "./storage";

export interface WorkflowState {
  frozen: boolean;
  cancelled: boolean;
  rootReason: string;
  persistenceFailed: boolean;
}

export interface StepContext {
  manifest: WorkflowManifest;
  directory: string;
  artifacts: string;
  lifetime: Lifetime;
  children: Map<string, RunningChild>;
  cancelledSteps: Set<string>;
  readonly state: WorkflowState;
  save(): Promise<void>;
  refreshCancellation(): Promise<void>;
  failQueue(step: WorkflowStepResult): void;
}

function outputFailed(
  output: WorkflowOutput | undefined,
  format: WorkflowTask["output"]["format"],
): boolean {
  return (
    output?.state === "invalid" ||
    (format !== "text" && output?.state !== "complete" && output?.state !== "oversized")
  );
}

async function nativeReadinessLog(directory: string, name: string) {
  const scope = dirname(dirname(directory));
  const logDirectory = join(scope, "broker", "jobs", name);
  await privateDirectory(logDirectory);
  const buffer = Buffer.alloc(64 * 1024);
  // Reading the native log must not lease a session job past disconnect
  return async () => {
    try {
      await using file = await open(
        join(logDirectory, "output.log"),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const info = await file.stat();
      if (!info.isFile() || info.uid !== process.getuid?.())
        throw new Error("Unsafe native workflow readiness log");
      const count = Math.min(info.size, buffer.byteLength);
      const { bytesRead } = await file.read(buffer, 0, count, info.size - count);
      return buffer.toString("utf8", 0, bytesRead);
    } catch (error) {
      if (isEnoent(error)) return "";
      throw error;
    }
  };
}

export class WorkflowStep {
  private child: Bun.Subprocess | undefined;
  private output: Promise<WorkflowOutput> | undefined;
  private capture: WorkflowCapture | undefined;
  private childControl: RunningChild | undefined;
  private deadline: Fiber.Fiber<void> | undefined;
  private readonly control: WorkflowChild;
  private log: () => string | Promise<string> = () => "";

  constructor(
    private readonly task: WorkflowTask,
    private readonly step: WorkflowStepResult,
    private readonly context: StepContext,
  ) {
    this.control = new WorkflowChild(!context.manifest.input.root.pty);
  }

  private async finishChild(): Promise<void> {
    if (this.control.stopping) await this.control.stopping;
    if (this.deadline) await run(Fiber.interrupt(this.deadline));
  }

  private async recoverStep(): Promise<void> {
    if (this.child) {
      try {
        if (this.childControl)
          await this.childControl.stop("failed", "Workflow step controller failed");
        else {
          const reference = Process.fromPid(this.child.pid);
          reference?.killTree(9);
          if (!this.control.exitObserved) this.child.kill("SIGKILL");
          await this.child.exited;
          this.control.cleanupConfirmed = false;
        }
      } catch {
        this.control.cleanupConfirmed = false;
      }
    }
    if (this.output) {
      try {
        this.step.output = await this.output;
      } catch {
        this.control.cleanupConfirmed = false;
      }
    }
    if (this.child) {
      try {
        this.step.exitCode = await this.child.exited;
      } catch {
        this.control.cleanupConfirmed = false;
      }
    }
  }

  private async observeReadiness(
    spawned: Bun.Subprocess,
    log: () => string | Promise<string>,
  ): Promise<void> {
    if (this.task.ready) {
      this.step.readiness = await waitForReady(this.task.ready, {
        cwd: this.task.spec.cwd,
        signal: this.control.readinessStop.signal,
        exited: spawned.exited,
        log,
      });
      await this.context.save();
      if (this.step.readiness.state !== "ready" && !this.control.stopKind)
        await this.childControl?.stop(
          "failed",
          this.step.readiness.reason ?? "Workflow readiness failed",
        );
    }
  }

  private finishStep(exitCode: number | undefined): void {
    if (this.control.stopKind) {
      this.step.state = this.control.cleanupConfirmed
        ? this.control.stopKind
        : "unknown";
      this.step.reason = this.control.cleanupConfirmed
        ? this.control.stopReason
        : `${this.control.stopReason ?? "Stopped"}; process-tree termination was not fully observed`;
    } else if (exitCode !== 0) {
      this.step.state = "failed";
      this.step.reason = `Command exited with code ${exitCode}`;
    } else if (outputFailed(this.step.output, this.task.output.format)) {
      this.step.state = "failed";
      this.step.reason =
        this.step.output?.error ?? `Structured output is ${this.step.output?.state}`;
    } else {
      this.step.state = "succeeded";
    }
  }

  private spawnTask(): void {
    const command = [this.task.spec.application, ...this.task.spec.args];
    if (this.context.manifest.input.root.pty) {
      // Keep the broker's foreground PTY group for interactive reads
      this.child = Bun.spawn(command, {
        cwd: this.task.spec.cwd,
        env: this.task.spec.env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      this.output = Promise.resolve({ format: "text", state: "inherited" });
    } else {
      const piped = Bun.spawn(
        subreaperScript ? [process.execPath, "-e", subreaperScript] : command,
        {
          cwd: this.task.spec.cwd,
          env: subreaperScript
            ? {
                ...this.task.spec.env,
                BUN_BE_BUN: "1",
                OMP_PTREE_SUBREAPER_COMMAND: JSON.stringify(command),
                OMP_PTREE_SUBREAPER_BUN_BE_BUN: this.task.spec.env.BUN_BE_BUN,
              }
            : this.task.spec.env,
          detached: true,
          stdin: this.context.manifest.input.kind === "job" ? "inherit" : "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      this.child = piped;
      this.capture = startCapture(piped, {
        directory: this.context.artifacts,
        id: this.task.id,
        policy: this.task.output,
        echo:
          this.context.manifest.input.kind === "job" &&
          this.task.output.format === "text"
            ? (text) => {
                process.stdout.write(text);
              }
            : undefined,
      });
      this.output = this.capture.done;
      this.log = this.capture.log;
    }
  }

  private async skipLaunch(
    guard: Awaited<ReturnType<typeof evaluateGuards>>,
  ): Promise<boolean> {
    if (this.context.state.cancelled || this.context.cancelledSteps.has(this.task.id)) {
      this.step.state = "cancelled";
      this.step.reason =
        this.context.state.rootReason || "Workflow step cancelled before launch";
      this.step.finishedAt = Date.now();
      await this.context.save();
      return true;
    }
    if (this.context.state.frozen) {
      this.step.state = "blocked";
      this.step.reason = this.context.state.rootReason;
      this.step.finishedAt = Date.now();
      await this.context.save();
      return true;
    }
    if (!guard.run) {
      this.step.state = "skipped";
      this.step.reason = guard.reason ?? "Execution guard did not match";
      this.step.finishedAt = Date.now();
      await this.context.save();
      return true;
    }
    return false;
  }

  private async launch(guard: Awaited<ReturnType<typeof evaluateGuards>>) {
    await this.context.refreshCancellation();
    if (await this.skipLaunch(guard)) return;
    this.step.state = "starting";
    this.step.startedAt = Date.now();
    if (this.task.ready)
      this.step.readiness = { state: "pending", observedAt: Date.now() };
    await this.context.save();
    // Signals can arrive while the starting reservation is syncing
    if (this.context.state.frozen || this.context.cancelledSteps.has(this.task.id)) {
      this.step.state =
        this.context.state.cancelled || this.context.cancelledSteps.has(this.task.id)
          ? "cancelled"
          : "blocked";
      this.step.reason =
        this.context.state.rootReason || "Workflow step cancelled before launch";
      this.step.finishedAt = Date.now();
      await this.context.save();
      return;
    }
    this.spawnTask();
    const spawned = this.child;
    if (!spawned) throw new Error("Workflow child was not spawned");
    this.control.start(spawned, this.output, this.capture);
    this.childControl = this.control;
    this.context.children.set(this.task.id, this.control);
    this.step.pid = spawned.pid;
    this.step.state = "running";
    if (this.task.timeoutSeconds > 0) {
      this.deadline = this.context.lifetime.fork(
        Effect.sleep(this.task.timeoutSeconds * 1000).pipe(
          Effect.andThen(
            Effect.uninterruptible(
              attempt(() =>
                this.control.stop("failed", "Workflow step deadline exceeded"),
              ),
            ),
          ),
          Effect.catch(() =>
            Effect.sync(() => {
              this.control.cleanupConfirmed = false;
            }),
          ),
        ),
      );
    }
    await this.context.save();
    return {
      spawned,
      output: this.output,
      log: this.log,
      control: this.control,
      stopped: this.control.stopped,
    };
  }

  async run(): Promise<void> {
    try {
      const guard = await evaluateGuards(this.task.guards, this.task.spec.cwd);
      const started = await withWorkflowLock(this.context.directory, "mutation", () =>
        this.launch(guard),
      );
      if (!started) return;
      this.child = started.spawned;
      this.output = started.output;
      this.childControl = started.control;
      let log = started.log;
      const spawned = started.spawned;
      if (this.task.ready?.kind === "log" && this.context.manifest.input.root.pty)
        log = await nativeReadinessLog(
          this.context.directory,
          this.context.manifest.prepared.name,
        );
      await this.observeReadiness(spawned, log);
      const exitCode = await run(
        Effect.raceFirst(
          attempt(() => spawned.exited),
          Deferred.await(started.stopped).pipe(
            Effect.map(() => spawned.exitCode ?? undefined),
          ),
        ),
      );
      this.step.output = await this.output;
      await this.finishChild();
      this.step.exitCode = exitCode;
      this.step.finishedAt = Date.now();
      this.finishStep(exitCode);
      this.context.failQueue(this.step);
      await this.context.save();
    } catch (error) {
      await this.recoverStep();
      this.step.state =
        this.context.state.persistenceFailed || !this.control.cleanupConfirmed
          ? "unknown"
          : "failed";
      this.step.reason = errorMessage(error);
      this.step.finishedAt = Date.now();
      this.context.failQueue(this.step);
      if (!this.context.state.persistenceFailed) await this.context.save();
    } finally {
      this.control.readinessStop.abort();
      if (this.deadline) await run(Fiber.interrupt(this.deadline));
      this.context.children.delete(this.task.id);
    }
  }
}
