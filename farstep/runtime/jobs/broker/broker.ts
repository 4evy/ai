import { once } from "node:events";
import { chmod, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { Lifetime, run } from "@ai/core/effect/effect";
import { Queue } from "@ai/core/effect/queue/queue";
import { errorMessage } from "@ai/core/error/error";
import { FileLock } from "@oh-my-pi/pi-natives";
import { postmortem } from "@oh-my-pi/pi-utils";
import { ConcatSink } from "@oh-my-pi/pi-utils/stream";
import { Deferred, Effect, Fiber, Schedule } from "effect";
import {
  JOB_PTY_COLUMNS,
  JOB_PTY_ROWS,
  type JobOperation,
  type JobRpcResult,
  parseJobWireRequest,
} from "farstep/protocol/jobs/protocol";
import { privateDirectory, privateRead } from "../../state";
import { JobCompletions } from "./completions";
import { logs, readOutput, send, wait } from "./io";
import { JobLog } from "./log";
import {
  ended,
  type ManagedJob,
  managedJob,
  type Operation,
  validateStart,
} from "./model";
import { JobRecords } from "./records";
import { JobSupervisor } from "./supervisor";
import { until } from "./wait";

type OperationRoutes = {
  [Name in JobOperation["op"]]: (
    operation: Operation<Name>,
  ) => JobRpcResult<Name> | Promise<JobRpcResult<Name>>;
};

export class JobBroker {
  readonly #jobs = new Map<string, ManagedJob>();
  readonly #starting = new Set<string>();
  readonly #sockets = new Set<Socket>();
  readonly #clients = new Set<Socket>();
  readonly #done = Deferred.makeUnsafe<void, unknown>();
  readonly #registrations = new Queue();
  readonly #lifetime = new Lifetime();
  readonly #routes: OperationRoutes = {
    ping: () => ({ op: "ping", projectDir: this.projectDir }),
    start: (operation) => this.#start(operation),
    list: () => this.#list(),
    describe: (operation) => {
      const job = this.#job(operation.name);
      return { op: "describe", snapshot: { ...job.snapshot }, spec: job.spec };
    },
    mode: (operation) => this.#mode(this.#job(operation.name), operation),
    send: (operation) =>
      send(this.#job(operation.name), operation, (job) => this.#records.persist(job)),
    stop: (operation) => this.#stopRequest(operation),
    output: (operation) => readOutput(this.#job(operation.name), operation),
    logs: (operation) => logs(this.#job(operation.name), operation),
    wait: (operation) => wait(this.#job(operation.name), operation),
  };
  readonly #records: JobRecords;
  readonly #completions: JobCompletions;
  readonly #supervisor: JobSupervisor;
  #server?: Server;
  #timer: Fiber.Fiber<void> | undefined;
  #closing?: Promise<void>;

  constructor(
    readonly projectDir: string,
    readonly directory: string,
    readonly secret: string,
    readonly idleGraceMs: number,
  ) {
    this.#records = new JobRecords(join(projectDir, "broker"));
    this.#completions = new JobCompletions(this.#jobs, (job) =>
      this.#records.persist(job),
    );
    this.#supervisor = new JobSupervisor(
      this.#lifetime,
      (job) => this.#records.persist(job),
      (job) => this.#completions.deliver(job),
      () => this.#idle(),
      () => this.#closing !== undefined,
    );
  }

  async run(): Promise<void> {
    await this.#records.recover(this.#jobs, this.directory);
    const endpoint = join(this.directory, "broker.sock");
    await rm(endpoint, { force: true });
    const server = createServer((socket) => this.#accept(socket));
    this.#server = server;
    server.listen(endpoint);
    await once(server, "listening");
    await chmod(endpoint, 0o600);
    this.#idle();
    // Process-wide signal cleanup must await jobs and their durable output
    const cancelCleanup = postmortem.register(
      `farstep-job-broker-${this.directory}`,
      () => this.close(),
      { exitOnly: true },
    );
    try {
      await run(Deferred.await(this.#done));
    } finally {
      cancelCleanup();
    }
  }

  #accept(socket: Socket): void {
    this.#sockets.add(socket);
    const buffer = new ConcatSink();
    socket.on("data", (chunk: Buffer) => {
      if ((buffer.flush()?.byteLength ?? 0) + chunk.byteLength > 1024 * 1024) {
        socket.destroy();
        return;
      }
      for (const line of buffer.appendAndFlushLines(chunk)) {
        void this.#handle(socket, Buffer.from(line).toString("utf8"));
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      this.#sockets.delete(socket);
      this.#clients.delete(socket);
      this.#completions.disconnect(socket);
      this.#idle();
    });
  }

  async #handle(socket: Socket, line: string): Promise<void> {
    let id = "unknown";
    try {
      const raw = JSON.parse(line);
      if (typeof raw?.id === "string") id = raw.id;
      const request = parseJobWireRequest(raw);
      if (request.token !== this.secret)
        throw new Error("Job broker authentication failed");
      if (this.#closing) throw new Error("Job broker is closing");
      this.#clients.add(socket);
      this.#cancelIdle();
      await this.#registrations.run(() => this.#completions.register(socket, request));
      const result = await this.#dispatch(request.operation.op, request.operation);
      socket.write(`${JSON.stringify({ id, ok: true, result })}\n`);
    } catch (error) {
      socket.write(
        `${JSON.stringify({ id, ok: false, error: errorMessage(error) })}\n`,
      );
    }
  }

  async #dispatch<Name extends JobOperation["op"]>(
    name: Name,
    operation: Operation<Name>,
  ): Promise<JobRpcResult<Name>> {
    return this.#routes[name](operation);
  }

  #job(name: string): ManagedJob {
    const job = this.#jobs.get(name);
    if (!job) throw new Error(`Unknown job ${name}`);
    return job;
  }

  async #stopRequest(operation: Operation<"stop">): Promise<JobRpcResult<"stop">> {
    const job = this.#job(operation.name);
    if (!operation.id || operation.id === job.snapshot.id)
      await this.#supervisor.stop(job, operation.timeoutMs);
    return { op: "stop", snapshot: { ...job.snapshot } };
  }

  async #mode(
    job: ManagedJob,
    operation: Operation<"mode">,
  ): Promise<JobRpcResult<"mode">> {
    if (job.snapshot.state === "unknown")
      throw new Error("An unsupervised job cannot change lifetime");
    job.spec.persist = operation.mode === "persist";
    job.snapshot.persist = job.spec.persist;
    await this.#records.persist(job);
    this.#idle();
    return { op: "mode", snapshot: { ...job.snapshot } };
  }

  #list(): JobRpcResult<"list"> {
    const { active = [], completed = [] } = Object.groupBy(
      this.#jobs.values(),
      (job) => (ended(job) ? "completed" : "active"),
    );
    return {
      op: "list",
      snapshots: [
        ...active,
        ...completed
          .sort((a, b) => (b.snapshot.exitedAt ?? 0) - (a.snapshot.exitedAt ?? 0))
          .slice(0, 10),
      ].map((job) => ({ ...job.snapshot })),
    };
  }

  async #start(operation: Operation<"start">): Promise<JobRpcResult<"start">> {
    validateStart(operation);
    const spec = operation.spec;
    const job = await this.#allocateJob(operation);

    try {
      await this.#records.persist(job);
      await this.#supervisor.launch(job);
      this.#supervisor.ready(job);
      if (spec.ready?.port) this.#supervisor.pollPort(job);
    } catch (error) {
      await this.#supervisor.settle(job, undefined, errorMessage(error));
    }
    await until(
      () => job.snapshot.readyAt !== undefined || ended(job),
      spec.ready?.timeoutMs ?? 0,
    );
    return {
      op: "start",
      snapshot: { ...job.snapshot },
      readyTimedOut: !!spec.ready && job.snapshot.readyAt === undefined,
    };
  }

  async #allocateJob(operation: Operation<"start">): Promise<ManagedJob> {
    const spec = operation.spec;
    if (this.#jobs.has(spec.name) || this.#starting.has(spec.name))
      throw new Error("Job name already exists; use a fresh job name");
    const pattern = spec.ready?.log ? new RegExp(spec.ready.log, "u") : undefined;
    const now = Date.now();
    const directory = this.#records.jobDirectory(spec.name);
    const size = spec.pty
      ? (spec.terminalSize ?? { columns: JOB_PTY_COLUMNS, rows: JOB_PTY_ROWS })
      : undefined;
    this.#starting.add(spec.name);
    let log: JobLog;
    try {
      await privateDirectory(directory);
      log = await JobLog.create(directory);
    } catch (error) {
      this.#starting.delete(spec.name);
      throw error;
    }

    const job = managedJob(
      operation,
      log,
      now,
      pattern,
      size,
      operation.owner !== undefined && this.#completions.has(operation.owner),
    );
    this.#jobs.set(spec.name, job);
    this.#starting.delete(spec.name);
    return job;
  }

  #cancelIdle(): void {
    if (this.#timer) void run(Fiber.interrupt(this.#timer));
    this.#timer = undefined;
  }

  #idle(): void {
    this.#cancelIdle();
    if (this.#closing || this.#clients.size) return;
    this.#timer = this.#lifetime.fork(
      Effect.sleep(this.idleGraceMs).pipe(
        Effect.andThen(() =>
          Effect.sync(() => {
            if (
              this.#clients.size ||
              this.#jobs.values().some((job) => !ended(job) && job.spec.persist)
            )
              return;
            void this.close().catch((error) => {
              console.error(error);
              process.exit(1);
            });
          }),
        ),
      ),
    );
  }

  close(): Promise<void> {
    this.#closing ??= this.#close().then(
      () => {
        Deferred.doneUnsafe(this.#done, Effect.void);
      },
      (error: unknown) => {
        Deferred.doneUnsafe(this.#done, Effect.fail(error));
        throw error;
      },
    );
    return this.#closing;
  }

  async #close(): Promise<void> {
    this.#cancelIdle();
    await this.#lifetime.close();
    await this.#registrations.run(async () => undefined);
    await run(
      Effect.sync(() => this.#starting.size === 0).pipe(
        Effect.repeat({ until: (ready) => ready, schedule: Schedule.spaced(10) }),
      ),
    );
    for (const job of this.#jobs.values()) {
      if (job.snapshot.state !== "unknown") await this.#supervisor.stop(job, 2000);
      await job.finished;
      await job.log.flush();
      await this.#records.persisted(job);
    }
    for (const socket of this.#sockets) socket.destroy();
    const server = this.#server;
    if (server)
      await run(
        Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void));
        }),
      );
    await rm(join(this.directory, "broker.sock"), { force: true });
  }
}

export async function runJobBroker(
  projectDir: string,
  directory: string,
  idleGraceMs: number,
): Promise<void> {
  process.umask(0o077);
  await privateDirectory(directory);
  const path = join(directory, "broker.pid");
  const lease = FileLock.tryAcquire(path);
  if (!lease.acquired) return;
  try {
    await writeFile(path, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    const secret = (await privateRead(join(directory, "broker.token"))).trim();
    await new JobBroker(projectDir, directory, secret, idleGraceMs).run();
  } finally {
    lease.release();
  }
}
