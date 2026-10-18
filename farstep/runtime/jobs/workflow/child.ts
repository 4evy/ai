import { attempt, run } from "@ai/core/effect/effect";
import { Process } from "@oh-my-pi/pi-natives";
import { Deferred, Effect, Option } from "effect";
import type { WorkflowOutput } from "#farstep/protocol/workflow/workflow";
import { signalGroup, subreaperScript } from "#farstep/runtime/platform/processes";
import type { WorkflowCapture } from "./output";

export type StopKind = "cancelled" | "failed";
export interface RunningChild {
  stop(kind: StopKind, reason: string): Promise<void>;
  sample(): void;
}

// Track native process references as well as the isolated process group: neither
// alone proves that every descendant has exited after a cancellation
export class WorkflowChild implements RunningChild {
  readonly stopped = Deferred.makeUnsafe<void>();
  readonly readinessStop = new AbortController();
  readonly #tracked: Process[] = [];
  #root: Process | null = null;
  #spawned?: Bun.Subprocess;
  #output: Promise<WorkflowOutput> | undefined;
  #capture: WorkflowCapture | undefined;
  #nativeTracking = true;
  exitObserved = false;
  cleanupConfirmed = true;
  stopKind?: StopKind;
  stopReason?: string;
  stopping?: Promise<void>;

  constructor(private readonly isolated: boolean) {}

  private get subreaped(): boolean {
    return this.isolated && subreaperScript !== undefined;
  }

  start(
    spawned: Bun.Subprocess,
    output: Promise<WorkflowOutput> | undefined,
    capture: WorkflowCapture | undefined,
  ): void {
    this.#spawned = spawned;
    this.#output = output;
    this.#capture = capture;
    void spawned.exited.then(() => {
      this.exitObserved = true;
    });
    try {
      this.#root = Process.fromPid(spawned.pid);
      if (this.#root) this.#tracked.push(this.#root);
      else this.#nativeTracking = false;
    } catch {
      this.#nativeTracking = false;
    }
  }

  sample(): void {
    for (const current of this.#tracked) {
      try {
        if (current.status() === "exited") continue;
        for (const descendant of current.children()) {
          if (
            !this.#tracked.some(
              (reference) =>
                reference.pid === descendant.pid && reference.status() !== "exited",
            )
          )
            this.#tracked.push(descendant);
        }
      } catch {
        this.#nativeTracking = false;
      }
    }
  }

  private signalFallback(spawned: Bun.Subprocess, signalled: boolean): void {
    if (!signalled && !this.exitObserved && !this.subreaped) {
      try {
        spawned.kill("SIGTERM");
      } catch {
        this.cleanupConfirmed = false;
      }
    }
  }

  private signalChild(spawned: Bun.Subprocess): void {
    let signalled = false;
    const root = this.#root;
    try {
      if (this.subreaped && root && root.status() !== "exited") {
        for (const descendant of root.children())
          signalled = descendant.killTree(15) > 0 || signalled;
      } else if (this.isolated) {
        signalled = signalGroup(spawned.pid, "SIGTERM");
      } else {
        signalled = (root?.killTree(15) ?? 0) > 0;
      }
    } catch {
      this.#nativeTracking = false;
    }
    this.signalFallback(spawned, signalled);
  }

  private sweepSubreaper(root: Process) {
    return Effect.gen({ self: this }, function* () {
      // Keep the subreaper alive until adopted descendants are swept
      const until = Date.now() + 250;
      let empty = 0;
      yield* Effect.gen({ self: this }, function* () {
        while (root.status() !== "exited" && empty < 2 && Date.now() < until) {
          this.sample();
          const descendants = root.children();
          empty = descendants.length === 0 ? empty + 1 : 0;
          for (const descendant of descendants) descendant.killTree(9);
          if (empty < 2) yield* Effect.sleep(5);
        }
        if (root.status() !== "exited" && empty < 2) this.cleanupConfirmed = false;
      }).pipe(
        Effect.catchCause(() =>
          Effect.sync(() => {
            this.#nativeTracking = false;
          }),
        ),
      );
    });
  }

  private sweepChild(spawned: Bun.Subprocess) {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.sleep(1000);
      if (this.subreaped && this.#root) {
        yield* this.sweepSubreaper(this.#root);
      } else if (this.isolated) {
        try {
          signalGroup(spawned.pid, "SIGKILL");
        } catch {
          this.cleanupConfirmed = false;
        }
      }
    });
  }

  private forceChild(spawned: Bun.Subprocess): void {
    this.sample();
    for (const reference of this.#tracked) {
      try {
        if (reference.status() !== "exited") reference.killTree(9);
      } catch {
        this.#nativeTracking = false;
      }
    }
    if (!this.exitObserved) {
      try {
        spawned.kill("SIGKILL");
      } catch {
        this.cleanupConfirmed = false;
      }
    }
  }

  private observeCleanup(spawned: Bun.Subprocess) {
    return Effect.gen({ self: this }, function* () {
      const leaderGone = Option.isSome(
        yield* attempt(() => spawned.exited).pipe(Effect.timeoutOption(5000)),
      );
      const observed = yield* Effect.forEach(
        this.#tracked,
        (reference) =>
          attempt(() => reference.waitForExit({ timeoutMs: 5000 })).pipe(
            Effect.catch(() => Effect.succeed(false)),
          ),
        { concurrency: "unbounded" },
      );
      let groupGone = false;
      if (this.isolated) {
        try {
          groupGone = !signalGroup(spawned.pid, 0);
        } catch {
          this.cleanupConfirmed = false;
        }
      }
      this.cleanupConfirmed =
        this.cleanupConfirmed &&
        leaderGone &&
        (this.#nativeTracking || groupGone) &&
        observed.every(Boolean);
      return leaderGone;
    });
  }

  private closeOutput() {
    return Effect.gen({ self: this }, function* () {
      const output = this.#output;
      if (
        output &&
        Option.isNone(
          yield* attempt(() => output).pipe(Effect.exit, Effect.timeoutOption(1000)),
        )
      ) {
        this.cleanupConfirmed = false;
        const capture = this.#capture;
        if (capture)
          yield* attempt(
            () =>
              capture.abort(
                "Output pipes did not close after bounded process-tree termination; artifacts contain observed prefixes only",
              ),
            { awaitOnInterrupt: true },
          );
      }
    });
  }

  private terminate(spawned: Bun.Subprocess) {
    return Effect.gen({ self: this }, function* () {
      this.sample();
      this.signalChild(spawned);
      yield* this.sweepChild(spawned);
      this.forceChild(spawned);
      const leaderGone = yield* this.observeCleanup(spawned);
      yield* this.closeOutput();
      if (!leaderGone) spawned.unref();
    });
  }

  stop(kind: StopKind, reason: string): Promise<void> {
    this.stopKind ??= kind;
    this.stopReason ??= reason;
    this.readinessStop.abort();
    if (this.stopping) return this.stopping;
    const spawned = this.#spawned;
    if (!spawned) throw new Error("Workflow child was not spawned");
    this.stopping = run(
      this.terminate(spawned).pipe(
        // Once stopping begins, finish observing native descendants and output
        Effect.uninterruptible,
        Effect.ensuring(Deferred.succeed(this.stopped, undefined)),
      ),
    );
    return this.stopping;
  }
}
