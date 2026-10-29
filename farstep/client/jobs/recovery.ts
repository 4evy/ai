import { isDeepStrictEqual } from "node:util";
import { attempt, run } from "@ai/runtime/effect/effect";
import { Queue } from "@ai/runtime/effect/queue/queue";
import { Cause, Effect, Exit } from "effect";
import type { CoordinationOpen } from "../../protocol/coordination";
import type {
  JobCompletionNotification,
  JobSnapshot,
  JobSpec,
} from "../../protocol/jobs/protocol";
import { parseJobSpec } from "../../protocol/jobs/protocol";
import { Gateway, type GatewayConnection } from "./gateway";

export interface JobScope {
  readonly scopeId: string;
  readonly owner: string;
  readonly projectDir: string;
}

export interface JobRoute extends JobScope {
  readonly connectionId: string;
  readonly installationId: string;
}

export interface JobIdentity {
  readonly name: string;
  readonly owner: string;
  readonly nativeId: string;
  readonly startedAt: number;
  readonly nativeCreatedAt: number;
}

export interface JobLaunchIdentity extends JobRoute {
  readonly name: string;
  readonly spec: JobSpec;
  readonly nativeId?: string | undefined;
  readonly startedAt?: number | undefined;
  readonly nativeCreatedAt?: number | undefined;
}

/** Reconstruct only a route, never a launch or a completion acknowledgment */
export function reconstructJobRoute(scope: JobScope, record: JobRoute): JobRoute {
  if (
    record.scopeId !== scope.scopeId ||
    record.owner !== scope.owner ||
    record.projectDir !== scope.projectDir
  )
    throw new Error("Job belongs to a different immutable execution scope");
  return {
    scopeId: record.scopeId,
    owner: record.owner,
    projectDir: record.projectDir,
    connectionId: record.connectionId,
    installationId: record.installationId,
  };
}

export function assertIdentity(job: JobIdentity, snapshot: JobSnapshot): void {
  if (
    snapshot.name !== job.name ||
    snapshot.owner !== job.owner ||
    snapshot.id !== job.nativeId ||
    snapshot.startedAt !== job.startedAt ||
    snapshot.createdAt !== job.nativeCreatedAt
  )
    throw new Error(
      `Native identity for ${job.name} changed; refusing to control a replaced or restarted process`,
    );
}

/** Describe an existing launch without replaying it or mutating harness storage */
export async function recoverJob(
  scope: JobScope,
  client: Gateway,
  record: JobLaunchIdentity,
  assertCurrent: () => void,
  signal?: AbortSignal,
): Promise<{ identity: JobIdentity; snapshot: JobSnapshot }> {
  assertCurrent();
  reconstructJobRoute(scope, record);
  if (
    client.installationId !== record.installationId ||
    client.scopeId !== record.scopeId ||
    client.owner !== record.owner
  )
    throw new Error(
      `Job ${record.name} belongs to a different helper installation or scope`,
    );
  const described = await client.request({ op: "describe", name: record.name }, signal);
  assertCurrent();
  const snapshot = described.snapshot;
  const expected = parseJobSpec(record.spec);
  // Lifetime and geometry may change without restarting the command
  const actual = {
    ...described.spec,
    persist: expected.persist,
    ...(expected.terminalSize ? { terminalSize: expected.terminalSize } : {}),
  };
  if (
    snapshot.owner !== record.owner ||
    snapshot.name !== record.name ||
    !isDeepStrictEqual(actual, expected) ||
    (record.nativeId !== undefined && record.nativeId !== snapshot.id) ||
    (record.startedAt !== undefined && record.startedAt !== snapshot.startedAt) ||
    (record.nativeCreatedAt !== undefined &&
      record.nativeCreatedAt !== snapshot.createdAt)
  )
    throw new Error(
      `Native identity or launch specification for ${record.name} changed; refusing control`,
    );
  const identity: JobIdentity = {
    name: record.name,
    owner: record.owner,
    nativeId: snapshot.id,
    startedAt: snapshot.startedAt,
    nativeCreatedAt: snapshot.createdAt,
  };
  assertIdentity(identity, snapshot);
  return { identity, snapshot };
}

export interface JobRoutesOptions<Scope extends JobScope, Connection> {
  isCurrent(scope: Scope): boolean;
  assertCurrent(scope: Scope): void;
  address(connection: Connection): readonly unknown[];
  project(connection: Connection): string;
  transport(
    connection: Connection,
    scope: Scope,
  ): Effect.Effect<GatewayConnection, unknown>;
  /** Presence registration also enables completion delivery */
  registration?(scope: Scope, connection: Connection): CoordinationOpen;
  /** Return true only after accepting delivery or explicitly discarding it */
  completion?(
    scope: Scope,
    client: Gateway,
    notification: JobCompletionNotification,
  ): Promise<boolean>;
  failure(scope: Scope, connection: Connection, error: unknown): void;
  closeFailure(error: unknown): void;
}

type PendingRoute = {
  connectionKey: string;
  effect: Effect.Effect<Gateway, unknown>;
  active: boolean;
  client?: Gateway;
};

/** Shared connection lifetime and reattachment, with no operation replay */
export class JobRoutes<Scope extends JobScope, Connection> {
  readonly #clients = new Map<string, Gateway>();
  readonly #routes = new Map<string, PendingRoute>();
  readonly #cleanup = new Queue();
  #generation = 0;

  constructor(private readonly options: JobRoutesOptions<Scope, Connection>) {}

  #key(scope: Scope, connection: Connection): string {
    return JSON.stringify([
      ...this.options.address(connection),
      scope.scopeId,
      scope.owner,
      scope.projectDir,
      this.options.project(connection),
    ]);
  }

  #forget(client: Gateway): void {
    for (const [key, known] of this.#clients)
      if (known === client) this.#clients.delete(key);
    for (const [key, pending] of this.#routes)
      if (pending.client === client) {
        pending.active = false;
        this.#routes.delete(key);
      }
  }

  #assert(scope: Scope, pending: PendingRoute): void {
    this.options.assertCurrent(scope);
    if (!pending.active)
      throw new Error("Job route was disconnected; no operations were replayed");
  }

  async client(
    scope: Scope,
    connection: Connection,
    expectedInstallation?: string,
  ): Promise<Gateway> {
    this.options.assertCurrent(scope);
    const connectionKey = this.#key(scope, connection);
    const route = JSON.stringify([connectionKey, expectedInstallation]);
    const pending = this.#routes.getOrInsertComputed(route, () => {
      const pending: PendingRoute = {
        connectionKey,
        active: true,
        effect: Effect.runSync(
          Effect.cached(
            Effect.gen({ self: this }, function* () {
              const client = yield* Gateway.connectEffect(
                yield* this.options.transport(connection, scope),
                scope.scopeId,
                scope.owner,
                this.options.registration && this.options.completion
                  ? async (client, notification) => {
                      this.#assert(scope, pending);
                      const accepted = await this.options.completion?.(
                        scope,
                        client,
                        notification,
                      );
                      this.#assert(scope, pending);
                      return accepted === true;
                    }
                  : undefined,
                (closedClient) => {
                  if (closedClient) this.#forget(closedClient);
                  if (
                    this.#routes.get(route) === pending &&
                    (!closedClient ||
                      !pending.client ||
                      pending.client === closedClient)
                  ) {
                    pending.active = false;
                    this.#routes.delete(route);
                  }
                },
              );
              return yield* Effect.gen({ self: this }, function* () {
                yield* Effect.try({
                  try: () => {
                    this.#assert(scope, pending);
                    // Check before registration can release queued completions
                    if (
                      expectedInstallation !== undefined &&
                      client.installationId !== expectedInstallation
                    )
                      throw new Error(
                        "Connection now names a different helper installation; refusing job control",
                      );
                  },
                  catch: (error) => error,
                });
                const key = JSON.stringify([
                  client.installationId,
                  scope.scopeId,
                  scope.owner,
                  scope.projectDir,
                  this.options.project(connection),
                ]);
                const selected = this.#clients.getOrInsert(key, client);
                pending.client = selected;
                if (selected !== client)
                  yield* attempt(() => client.close(), { awaitOnInterrupt: true });
                if (this.options.registration)
                  yield* selected.openCoordinationEffect(
                    this.options.registration(scope, connection),
                    (error) => {
                      if (this.options.isCurrent(scope) && pending.active)
                        this.options.failure(scope, connection, error);
                    },
                  );
                yield* Effect.try({
                  try: () => this.#assert(scope, pending),
                  catch: (error) => error,
                });
                return selected;
              }).pipe(
                Effect.onExit((exit) =>
                  Exit.isFailure(exit)
                    ? attempt(
                        () => {
                          const closing = pending.client ?? client;
                          this.#forget(closing);
                          return closing.close();
                        },
                        { awaitOnInterrupt: true },
                      ).pipe(
                        Effect.catch((error) =>
                          Effect.sync(() => this.options.closeFailure(error)),
                        ),
                      )
                    : Effect.void,
                ),
              );
            }).pipe(
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  if (Exit.isFailure(exit) && this.#routes.get(route) === pending) {
                    pending.active = false;
                    this.#routes.delete(route);
                  }
                }),
              ),
            ),
          ),
        ),
      };
      return pending;
    });
    const client = await run(pending.effect);
    this.#assert(scope, pending);
    return client;
  }

  async recover(
    scope: Scope,
    record: JobRoute,
    resolve: (connectionId: string, projectDir: string) => Promise<Connection>,
  ): Promise<Gateway> {
    this.options.assertCurrent(scope);
    const generation = this.#generation;
    const route = reconstructJobRoute(scope, record);
    const connection = await resolve(route.connectionId, route.projectDir);
    this.options.assertCurrent(scope);
    if (generation !== this.#generation)
      throw new Error(
        "Job routes were released during recovery; no operations were replayed",
      );
    return this.client(scope, connection, route.installationId);
  }

  async disconnect(scope: Scope, connection: Connection): Promise<void> {
    const prefix = this.#key(scope, connection);
    const pendingRoutes = this.#routes
      .entries()
      .filter(([, pending]) => pending.connectionKey === prefix)
      .toArray();
    for (const [key, pending] of pendingRoutes) {
      pending.active = false;
      this.#routes.delete(key);
      if (pending.client) this.#forget(pending.client);
    }
    await Promise.all(
      pendingRoutes.map(async ([, pending]) => {
        const client = await run(
          pending.effect.pipe(Effect.catchCause(() => Effect.succeed(undefined))),
        );
        if (client) await client.close();
      }),
    );
  }

  release(): Promise<void> {
    this.#generation++;
    const pendingRoutes = [...this.#routes.values()];
    for (const pending of pendingRoutes) pending.active = false;
    this.#routes.clear();
    this.#clients.clear();
    return run(
      this.#cleanup.runEffect(
        Effect.forEach(
          pendingRoutes,
          (pending) =>
            Effect.gen(function* () {
              const client = yield* pending.effect.pipe(
                Effect.catchCause(() => Effect.succeed(undefined)),
              );
              if (client)
                yield* attempt(() => client.close(), { awaitOnInterrupt: true });
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() => {
                  this.options.closeFailure(Cause.squash(cause));
                }),
              ),
            ),
          { concurrency: "unbounded", discard: true },
        ),
      ),
    );
  }
}
