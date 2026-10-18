import { randomUUID } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import type { Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { attempt, Lifetime, run } from "@ai/core/effect/effect";
import { connectSocket } from "@ai/core/effect/socket/socket";
import { isEexist } from "@oh-my-pi/pi-utils/fs-error";
import { ConcatSink } from "@oh-my-pi/pi-utils/stream";
import { toError } from "@oh-my-pi/pi-utils/type-guards";
import { Deferred, Effect, type Fiber, Schedule, Scope } from "effect";
import {
  type JobCompletionNotification,
  type JobOperation,
  type JobRpcResult,
  parseJobRpcResult,
  parseJobWireMessage,
} from "farstep/protocol/jobs/protocol";
import { privateDirectory, privateRead } from "../../state";

const BROKER_REQUEST_TIMEOUT_MS = 30_000;
const BROKER_START_TIMEOUT_MS = 10_000;
const BROKER_REQUEST_GRACE_MS = 5_000;
const BROKER_LAUNCH_TIMEOUT_MS = 10_000;

function operationTimeout(operation: JobOperation): number {
  if (operation.op === "start")
    return (
      (operation.spec.ready?.timeoutMs ?? BROKER_START_TIMEOUT_MS) +
      BROKER_REQUEST_GRACE_MS
    );
  return "timeoutMs" in operation
    ? operation.timeoutMs + BROKER_REQUEST_GRACE_MS
    : BROKER_REQUEST_TIMEOUT_MS;
}

export interface JobBrokerClient {
  readonly projectDir: string;
  request<Operation extends JobOperation>(
    operation: Operation,
    signal?: AbortSignal,
  ): Promise<JobRpcResult<Operation["op"]>>;

  onCompletion(
    owner: string,
    sink: (notification: JobCompletionNotification) => Promise<void> | void,
  ): (options?: { preservePending?: boolean }) => void;
  close(): void;
}

export class JobBrokerRejectedError extends Error {}

interface Pending {
  succeed: (value: unknown) => void;
  fail: (error: Error) => void;
}

async function token(directory: string): Promise<string> {
  const path = join(directory, "broker.token");
  try {
    await using file = await open(path, "wx", 0o600);
    await file.writeFile(randomUUID() + randomUUID());
    await file.sync();
  } catch (error) {
    if (!isEexist(error)) throw error;
  }
  return run(
    attempt(() => privateRead(path)).pipe(
      Effect.map((value) => value.trim()),
      Effect.repeat({
        until: (value) => value.length > 0,
        schedule: Schedule.max([Schedule.spaced(10), Schedule.recurs(99)]),
      }),
      Effect.flatMap((value) =>
        value
          ? Effect.succeed(value)
          : Effect.fail(new Error("Job broker token initialization timed out")),
      ),
    ),
  );
}

function connect(endpoint: string) {
  return connectSocket({ path: endpoint }).pipe(
    Effect.timeoutOrElse({
      duration: 250,
      orElse: () => Effect.fail(new Error("Broker connect timed out")),
    }),
  );
}

class BrokerConnection implements JobBrokerClient {
  readonly #pending = new Map<string, Pending>();
  readonly #sinks = new Map<
    string,
    (event: JobCompletionNotification) => Promise<void> | void
  >();
  readonly #preserved = new Set<string>();
  readonly #unsubscribed = new Set<string>();
  readonly #replays = new Set<string>();
  readonly #seen = new Set<string>();
  readonly #delivering = new Set<string>();
  readonly #subscription = randomUUID();
  readonly #lifetime = new Lifetime();
  #socket: Socket | undefined;
  #connecting: Effect.Effect<void, unknown> | undefined;
  #closed = false;
  #retry: Fiber.Fiber<void, unknown> | undefined;

  constructor(
    readonly projectDir: string,
    readonly directory: string,
    readonly secret: string,
    readonly idleGraceMs: number,
  ) {}

  async request<Operation extends JobOperation>(
    operation: Operation,
    signal?: AbortSignal,
  ): Promise<JobRpcResult<Operation["op"]>> {
    if (this.#closed) throw new Error("Job broker connection is closed");
    signal?.throwIfAborted();
    if (!this.#socket || this.#socket.destroyed) {
      if (!this.#connecting) {
        const connecting = Effect.runSync(
          Effect.cached(
            this.#openEffect().pipe(
              Scope.provide(this.#lifetime.scope),
              Effect.ensuring(
                Effect.sync(() => {
                  if (this.#connecting === connecting) this.#connecting = undefined;
                }),
              ),
            ),
          ),
        );
        this.#connecting = connecting;
      }
      await this.#lifetime.run(this.#connecting, signal);
    }
    signal?.throwIfAborted();
    if (this.#closed || !this.#socket || this.#socket.destroyed)
      throw new Error("Job broker connection is unavailable");
    const id = randomUUID();
    const timeout = operationTimeout(operation);
    const result = Deferred.makeUnsafe<JobRpcResult<Operation["op"]>, Error>();
    const removed = [...this.#unsubscribed];
    const replays = [...this.#replays];
    return this.#lifetime.run(
      Effect.sync(() => {
        // Capture the operation with its typed decoder before storing pending work
        this.#pending.set(id, {
          succeed: (value) =>
            Effect.runSync(
              Deferred.complete(
                result,
                Effect.try({
                  try: () => parseJobRpcResult(operation, value),
                  catch: toError,
                }),
              ),
            ),
          fail: (error) => Effect.runSync(Deferred.fail(result, error)),
        });
        this.#send({ id, operation, completionUnsubscribes: removed });
      }).pipe(
        Effect.andThen(Deferred.await(result)),
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.fail(new Error(`Job ${operation.op} request timed out`)),
        }),
        Effect.tap(() =>
          Effect.sync(() => {
            for (const owner of removed) this.#unsubscribed.delete(owner);
            for (const owner of replays) this.#replays.delete(owner);
          }),
        ),
        Effect.ensuring(Effect.sync(() => this.#pending.delete(id))),
      ),
      signal,
    );
  }

  #send(fields: Record<string, unknown>): void {
    this.#socket?.write(
      `${JSON.stringify({
        token: this.secret,
        owners: [...this.#sinks.keys()],
        detachedOwners: [...this.#preserved],
        completionEvents: true,
        completionSubscriptionId: this.#subscription,
        completionReplays: [...this.#replays],
        ...fields,
      })}\n`,
    );
  }

  #openEffect() {
    return Effect.gen({ self: this }, function* () {
      const endpoint = join(this.directory, "broker.sock");
      const socket = yield* Effect.acquireRelease(
        Effect.interruptible(
          connect(endpoint).pipe(
            Effect.catch(() =>
              Effect.gen({ self: this }, function* () {
                if (this.#closed)
                  return yield* Effect.fail(
                    new Error("Job broker connection is closed"),
                  );
                yield* Effect.try({
                  try: () => {
                    const child = Bun.spawn(
                      [
                        process.execPath,
                        fileURLToPath(
                          new URL(
                            `./main.${import.meta.url.endsWith(".js") ? "js" : "ts"}`,
                            import.meta.url,
                          ),
                        ),
                        this.projectDir,
                        this.directory,
                        String(this.idleGraceMs),
                      ],
                      {
                        stdin: "ignore",
                        stdout: "ignore",
                        stderr: "ignore",
                        detached: true,
                      },
                    );
                    child.unref();
                  },
                  catch: (error) => error,
                });
                return yield* connect(endpoint).pipe(
                  Effect.retry(
                    Schedule.max([
                      Schedule.spaced(50),
                      Schedule.during(BROKER_LAUNCH_TIMEOUT_MS),
                    ]),
                  ),
                );
              }),
            ),
          ),
        ),
        (socket) => Effect.sync(() => socket.destroy()),
      );
      if (this.#closed) {
        socket.destroy();
        return;
      }
      this.#socket = socket;
      const buffer = new ConcatSink();
      socket.on("data", (chunk: Buffer) => {
        if ((buffer.flush()?.byteLength ?? 0) + chunk.byteLength > 8 * 1024 * 1024) {
          socket.destroy();
          return;
        }
        for (const line of buffer.appendAndFlushLines(chunk)) {
          try {
            const message = parseJobWireMessage(
              JSON.parse(Buffer.from(line).toString("utf8")),
            );
            if ("event" in message) {
              void this.#deliver(message);
              continue;
            }
            const pending = this.#pending.get(message.id);
            if (!pending) continue;
            this.#pending.delete(message.id);
            if (!message.ok) pending.fail(new JobBrokerRejectedError(message.error));
            else pending.succeed(message.result);
          } catch {
            socket.destroy();
            return;
          }
        }
      });
      socket.on("error", () => {});
      socket.on("close", () => {
        if (this.#socket === socket) this.#socket = undefined;
        for (const pending of this.#pending.values()) {
          pending.fail(new Error("Job broker connection closed"));
        }
        this.#pending.clear();
        this.#publish();
      });
    });
  }

  onCompletion(
    owner: string,
    sink: (event: JobCompletionNotification) => Promise<void> | void,
  ) {
    this.#preserved.delete(owner);
    this.#replays.add(owner);
    this.#unsubscribed.delete(owner);
    this.#sinks.set(owner, sink);
    this.#publish();
    return (options?: { preservePending?: boolean }) => {
      if (this.#sinks.get(owner) !== sink) return;
      this.#sinks.delete(owner);
      if (options?.preservePending) this.#preserved.add(owner);
      else this.#unsubscribed.add(owner);
      this.#publish();
    };
  }

  #publish(): void {
    if (this.#closed || this.#retry) return;
    this.#retry = this.#lifetime.fork(
      // Subscription retries must not keep an otherwise idle client process alive
      attempt((signal) => delay(50, undefined, { signal, ref: false })).pipe(
        Effect.andThen(() => attempt(() => this.request({ op: "ping" }))),
        Effect.retry({ while: () => this.#sinks.size > 0 }),
        Effect.asVoid,
        Effect.ignore,
        Effect.ensuring(
          Effect.sync(() => {
            this.#retry = undefined;
          }),
        ),
      ),
    );
  }

  async #deliver(event: JobCompletionNotification): Promise<void> {
    if (this.#delivering.has(event.completionId)) return;
    const sink = this.#sinks.get(event.owner);
    if (!sink) return;
    this.#delivering.add(event.completionId);
    try {
      if (!this.#seen.has(event.completionId)) await sink(event);
      this.#seen.add(event.completionId);
      if (this.#seen.size > 512) {
        const oldest = this.#seen.values().next().value;
        if (oldest) this.#seen.delete(oldest);
      }
      this.#send({
        id: randomUUID(),
        operation: { op: "ping" },
        completionAcks: [event.completionId],
      });
    } catch {
      this.#socket?.destroy();
    } finally {
      this.#delivering.delete(event.completionId);
    }
  }

  close(): void {
    this.#closed = true;
    this.#socket?.destroy();
    void this.#lifetime.close();
  }
}

export async function createJobBrokerClient(
  projectDir: string,
  options: { runtimeDir: string; idleGraceMs?: number },
): Promise<JobBrokerClient> {
  await privateDirectory(options.runtimeDir);
  return new BrokerConnection(
    await realpath(projectDir),
    options.runtimeDir,
    await token(options.runtimeDir),
    options.idleGraceMs ?? 3000,
  );
}
