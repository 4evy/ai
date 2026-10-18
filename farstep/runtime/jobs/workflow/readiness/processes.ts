import { Process } from "@oh-my-pi/pi-natives";
import { AbortError, type ChildProcess } from "@oh-my-pi/pi-utils/ptree";

const CLEANUP_MS = 500;

export class ProbeProcesses {
  private readonly tracked = new Map<number, Process>();
  private root: Process | null = null;
  private trackingError: unknown;
  constructor(private readonly child: ChildProcess<"ignore">) {
    this.trackRoot();
  }

  collect(): void {
    if (!this.root) return;
    try {
      const pending = [this.root];
      for (const current of pending) {
        const previous = this.tracked.get(current.pid);
        if (!previous || previous.status() === "exited")
          this.tracked.set(current.pid, current);
        if (current.status() !== "exited") pending.push(...current.children());
      }
    } catch (error) {
      this.trackingError = error;
    }
  }

  private trackRoot(): void {
    try {
      this.root = Process.fromPid(this.child.pid);
      this.collect();
    } catch (error) {
      this.trackingError = error;
    }
  }

  stop(): void {
    this.collect();
    try {
      this.child.kill(new AbortError("Readiness probe stopped", ""), -1);
    } catch (error) {
      this.trackingError = error;
      try {
        if (this.child.proc.exitCode === null) this.child.proc.kill("SIGKILL");
      } catch (killError) {
        this.trackingError = killError;
      }
    }
  }

  private async stopLeader(): Promise<void> {
    // Give the utility's hard subreaper sweep time to collect adopted children
    let leaderGone = this.child.proc.exitCode !== null;
    if (this.root) {
      try {
        leaderGone = await this.root.waitForExit({ timeoutMs: CLEANUP_MS });
      } catch (error) {
        this.trackingError = error;
      }
    }
    if (!leaderGone && this.child.proc.exitCode === null) {
      try {
        this.child.proc.kill("SIGKILL");
      } catch (error) {
        this.trackingError = error;
      }
    }
  }

  private forceTracked(): void {
    for (const current of this.tracked.values()) {
      try {
        if (current.status() !== "exited") current.killTree(9);
      } catch (error) {
        this.trackingError = error;
      }
    }
  }

  private async observeTracked(): Promise<boolean[]> {
    const gone = await Promise.all(
      this.tracked.values().map(async (current) => {
        try {
          return await current.waitForExit({ timeoutMs: CLEANUP_MS });
        } catch (error) {
          this.trackingError = error;
          return false;
        }
      }),
    );
    return gone;
  }

  private assertCleanup(gone: boolean[]): void {
    if (
      (!this.root && this.child.proc.exitCode === null) ||
      gone.some((exited) => !exited)
    )
      throw new Error("Readiness probe process-tree cleanup could not be confirmed");
    if (this.trackingError !== undefined) throw this.trackingError;
  }

  async cleanup(): Promise<void> {
    this.stop();
    await this.stopLeader();
    this.forceTracked();
    const gone = await this.observeTracked();
    this.assertCleanup(gone);
  }
}
