import { randomUUID } from "node:crypto";
import { constants } from "node:os";
import { attempt, type Lifetime, run } from "@ai/runtime/effect/effect";
import { scopedSocket } from "@ai/runtime/effect/socket/socket";
import { Process, PtySession } from "@oh-my-pi/pi-natives";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { TerminalQueryResponder } from "@oh-my-pi/pi-utils/vterm";
import { Deferred, Effect, Schedule, Stream } from "effect";
import { JOB_PTY_COLUMNS, JOB_PTY_ROWS } from "farstep/protocol/jobs/protocol";

import { ended, type ManagedJob } from "./model";
import { until } from "./wait";

export class JobSupervisor {
  constructor(
    private readonly lifetime: Lifetime,
    private readonly persist: (job: ManagedJob) => Promise<void>,
    private readonly deliver: (job: ManagedJob) => void,
    private readonly idle: () => void,
    private readonly isClosing: () => boolean,
  ) {}

  async launch(job: ManagedJob): Promise<void> {
    if (this.isClosing() || job.stopped)
      throw new Error("Job was stopped before its process started");
    if (job.spec.pty) await this.#launchPty(job);
    else this.#launchPipes(job);
    try {
      await this.persist(job);
    } catch (error) {
      this.#failOutput(job, error);
      await job.finished;
      throw error;
    }
  }

  async #launchPty(job: ManagedJob): Promise<void> {
    const terminal = new PtySession();
    job.terminal = terminal;
    const responder = new TerminalQueryResponder();
    const started = Deferred.makeUnsafe<void, unknown>();
    const env = { TERM: "xterm-256color", ...job.spec.env };
    const assignments = Object.entries(env).map(([key, value]) => {
      if (!key || key.includes("=") || key.includes("\0") || value.includes("\0"))
        throw new Error("Invalid job environment");
      return `${key}=${value}`;
    });
    const size = job.snapshot.terminalSize ?? {
      columns: JOB_PTY_COLUMNS,
      rows: JOB_PTY_ROWS,
    };
    // Native PTYs overlay the parent environment; env -i defines the full
    // environment for this job
    const completed = terminal.startArgv(
      {
        application: "/usr/bin/env",
        args: ["-i", "--", ...assignments, job.spec.application, ...job.spec.args],
        cwd: job.spec.cwd,
        env,
        cols: size.columns,
        rows: size.rows,
      },
      (error, chunk) => {
        if (error) {
          this.#failOutput(job, error);
          return;
        }
        if (!chunk) return;
        const reply = responder.feed(chunk);
        if (reply) {
          try {
            terminal.write(reply);
          } catch {}
        }
        if (job.outputFailure) return;
        try {
          void this.#output(job, chunk).catch((error) => this.#failOutput(job, error));
        } catch (error) {
          this.#failOutput(job, error);
        }
      },
      (error, pid) => {
        if (error) {
          Deferred.doneUnsafe(started, Effect.fail(error));
          return;
        }
        if (!ended(job)) {
          job.snapshot.pid = pid;
          job.process = Process.fromPid(pid) ?? undefined;
          if (job.outputFailure) this.#terminateOutput(job);
        }
        Deferred.doneUnsafe(started, Effect.void);
      },
    );
    job.finished = run(
      attempt(() => completed).pipe(
        Effect.matchEffect({
          onSuccess: (result) =>
            attempt(
              () =>
                this.settle(
                  job,
                  result.exitCode ?? (result.cancelled ? 137 : undefined),
                ),
              { awaitOnInterrupt: true },
            ),
          // Native setup can reject without invoking the startup callback
          onFailure: (error) =>
            attempt(() => this.settle(job, undefined, String(error)), {
              awaitOnInterrupt: true,
            }).pipe(Effect.ensuring(Deferred.fail(started, error))),
        }),
        Effect.ensuring(Deferred.succeed(started, undefined)),
      ),
    );
    void job.finished.catch((error) => console.error(error));
    await run(Deferred.await(started));
  }

  #launchPipes(job: ManagedJob): void {
    const child = Bun.spawn([job.spec.application, ...job.spec.args], {
      cwd: job.spec.cwd,
      env: job.spec.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    job.snapshot.pid = child.pid;
    job.process = Process.fromPid(child.pid) ?? undefined;
    job.input = child.stdin;

    job.finished = run(
      Effect.all(
        [
          attempt(() => child.exited),
          this.#drainEffect(job, child.stdout),
          this.#drainEffect(job, child.stderr),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.matchEffect({
          onSuccess: ([code]) =>
            attempt(() => this.settle(job, code), { awaitOnInterrupt: true }),
          onFailure: (error) =>
            attempt(
              async () => {
                this.#failOutput(job, error);
                await this.settle(job, undefined, String(error));
              },
              { awaitOnInterrupt: true },
            ),
        }),
      ),
    );
    void job.finished.catch((error) => console.error(error));
  }

  #drainEffect(job: ManagedJob, stream: ReadableStream<Uint8Array>) {
    return Effect.suspend(() => {
      const decoder = new TextDecoder();
      return Stream.fromReadableStream({
        evaluate: () => stream,
        onError: (error) => error,
      }).pipe(
        Stream.runForEach((chunk) =>
          attempt(
            async () => {
              // Await bounded writes before reading more from either OS pipe
              for (let offset = 0; offset < chunk.length; offset += 65536) {
                const bytes = chunk.subarray(offset, offset + 65536);
                await this.#output(job, bytes, decoder.decode(bytes, { stream: true }));
              }
            },
            { awaitOnInterrupt: true },
          ),
        ),
        Effect.andThen(
          Effect.try({
            try: () => {
              const tail = decoder.decode();
              if (tail) this.#track(job, tail);
            },
            catch: (error) => error,
          }),
        ),
      );
    });
  }

  #output(job: ManagedJob, bytes: string | Uint8Array, text?: string): Promise<void> {
    job.snapshot.outputBytes +=
      typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.length;
    if (job.outputFailure) return Promise.reject(job.outputFailure.error);
    return job.log.append(bytes).then(() => {
      if (!job.outputFailure) this.#track(job, text ?? String(bytes));
    });
  }

  #failOutput(job: ManagedJob, error: unknown, terminate = true): void {
    if (job.outputFailure) return;
    job.outputFailure = { error };
    console.error(error);
    // A PTY callback cannot await storage, overflow fails the job and producer
    if (terminate) this.#terminateOutput(job);
  }

  #terminateOutput(job: ManagedJob): void {
    try {
      job.process?.killTree(constants.signals.SIGKILL);
    } catch (error) {
      console.error(error);
    }
    try {
      job.terminal?.kill();
    } catch (error) {
      console.error(error);
    }
  }

  #track(job: ManagedJob, text: string): void {
    job.buffer = (job.buffer + sanitizeText(text)).slice(-65536);
    if (!job.logReady && job.pattern) {
      const match = job.pattern.exec(job.buffer);
      if (match) {
        job.logReady = true;
        job.snapshot.readyMatch = match[0].slice(0, 500);
      }
    }
    this.ready(job);
  }

  ready(job: ManagedJob): void {
    if (
      ended(job) ||
      job.stopped ||
      job.outputFailure ||
      job.snapshot.readyAt !== undefined
    )
      return;
    const previous = job.snapshot.readyPending?.join(",");
    if (job.logReady && job.portReady) {
      job.snapshot.state = job.spec.ready ? "ready" : "running";
      job.snapshot.readyAt = Date.now();
      job.snapshot.readyPending = undefined;
    } else
      job.snapshot.readyPending = [
        ...(!job.logReady ? ["log" as const] : []),
        ...(!job.portReady ? ["port" as const] : []),
      ];
    if (
      job.snapshot.readyAt !== undefined ||
      previous !== job.snapshot.readyPending?.join(",")
    )
      void this.persist(job).catch((error) => this.#failOutput(job, error));
  }

  pollPort(job: ManagedJob): void {
    this.lifetime.fork(
      Effect.suspend(() => {
        if (ended(job) || job.stopped || job.portReady) return Effect.succeed(true);
        return Effect.scoped(
          scopedSocket({
            port: job.spec.ready?.port ?? 0,
            host: job.spec.ready?.host ?? "127.0.0.1",
          }).pipe(Effect.as(true)),
        ).pipe(
          Effect.catch(() => Effect.succeed(false)),
          Effect.timeoutOrElse({ duration: 250, orElse: () => Effect.succeed(false) }),
          Effect.tap((ready) =>
            Effect.sync(() => {
              job.portReady = ready;
              this.ready(job);
            }),
          ),
        );
      }).pipe(
        Effect.repeat({ until: (ready) => ready, schedule: Schedule.spaced(50) }),
        Effect.asVoid,
      ),
    );
  }

  settle(job: ManagedJob, code?: number, error?: string): Promise<void> {
    if (job.settling) return job.settling;
    if (ended(job)) return Promise.resolve();
    job.settling = this.#settle(job, code, error);
    return job.settling;
  }

  async #settle(job: ManagedJob, code?: number, error?: string): Promise<void> {
    try {
      await job.log.flush();
    } catch (failure) {
      this.#failOutput(job, failure, false);
    }
    const failure = job.outputFailure ? String(job.outputFailure.error) : error;
    job.snapshot.state = failure || (!job.stopped && code !== 0) ? "failed" : "exited";
    job.snapshot.exitCode = code;
    job.snapshot.exitReason = failure;
    job.snapshot.exitedAt = Date.now();
    job.snapshot.pid = undefined;
    job.snapshot.readyPending = undefined;
    job.input = undefined;
    job.process = undefined;
    if (job.capable && job.snapshot.owner && !job.stopped) {
      job.pending.push({
        event: "job-completed",
        completionId: randomUUID(),
        owner: job.snapshot.owner,
        snapshot: { ...job.snapshot },
      });
    }
    // No completion is published until output and the final receipt have settled
    await this.persist(job);
    this.deliver(job);
    this.idle();
  }

  async stop(job: ManagedJob, timeoutMs: number): Promise<void> {
    if (job.snapshot.state === "unknown")
      throw new Error(
        "Previous supervisor exited; this process cannot be safely controlled",
      );
    if (ended(job)) {
      await job.settling;
      return;
    }
    job.stopped = true;
    job.snapshot.state = "stopping";
    await this.persist(job);
    await job.process?.terminate({
      group: true,
      gracefulMs: timeoutMs,
      timeoutMs: timeoutMs + 1000,
    });
    if (!(await until(() => ended(job), 1000))) {
      job.terminal?.kill();
      job.process?.killTree(constants.signals.SIGKILL);
      await until(() => ended(job), 1000);
    }
    await job.settling;
  }
}
