import { attempt, run } from "@ai/core/effect/effect";
import { Queue } from "@ai/core/effect/queue/queue";
import { Cause, Deferred, Effect, Exit } from "effect";
import { Gateway } from "farstep/client/jobs/gateway";
import type { CoordinationOpen } from "farstep/protocol/coordination";
import type { JobCompletionNotification } from "farstep/protocol/jobs/protocol";
import type { ExecutionTarget } from "../../connections/types";
import { gatewayTransportEffect } from "../gateway/connection";
import type { Scope } from "../types";
import type { SessionState } from "./state";

type Route = { effect: Effect.Effect<Gateway, unknown>; client?: Gateway };

export class SessionRoutes {
  readonly #clients = new Map<string, Gateway>();
  readonly #routes = new Map<string, Route>();
  readonly #cleanup = new Queue();
  constructor(
    private readonly state: SessionState,
    private readonly completion: (
      scope: Scope,
      client: Gateway,
      notification: JobCompletionNotification,
    ) => Promise<void>,
  ) {}

  #registration(scope: Scope, connection: ExecutionTarget): CoordinationOpen {
    const header = scope.ctx.sessionManager.getHeader();
    const title = scope.ctx.sessionManager.getSessionName()?.trim();
    const purpose =
      header?.titleSource === "user" &&
      title &&
      title.length <= 1024 &&
      !/\p{Cc}/u.test(title)
        ? title
        : undefined;
    const parentSession =
      header?.parentSession && /^[A-Za-z0-9._:-]{1,128}$/u.test(header.parentSession)
        ? header.parentSession
        : undefined;
    return {
      project: connection.cwd,
      sessionId: scope.ctx.sessionManager.getSessionId(),
      agentId: scope.ctx.agent.id,
      ...(parentSession ? { parentSession } : {}),
      ...(purpose ? { purpose } : {}),
    };
  }

  async client(
    scope: Scope,
    connection: ExecutionTarget,
    expectedInstallation?: string,
  ): Promise<Gateway> {
    this.state.assertCurrent(scope);
    const route = JSON.stringify([
      ...(connection.backend === "local"
        ? ["local", connection.home]
        : ["ssh", connection.target]),
      scope.scopeId,
      scope.owner,
      connection.cwd,
    ]);
    const pending = this.#routes.getOrInsertComputed(route, () => {
      const pending: Route = {
        effect: Effect.runSync(
          Effect.cached(
            Effect.gen({ self: this }, function* () {
              const client = yield* Gateway.connectEffect(
                yield* gatewayTransportEffect(connection, scope.scopeId, scope.owner),
                scope.scopeId,
                scope.owner,
                (client, notification) => this.completion(scope, client, notification),
                (closedClient) => {
                  if (closedClient) {
                    const key = JSON.stringify([
                      closedClient.installationId,
                      scope.scopeId,
                      scope.owner,
                      connection.cwd,
                    ]);
                    if (this.#clients.get(key) === closedClient) {
                      this.#clients.delete(key);
                      for (const [knownRoute, value] of this.#routes) {
                        if (
                          value.client === closedClient &&
                          this.#routes.get(knownRoute) === value
                        )
                          this.#routes.delete(knownRoute);
                      }
                    }
                  } else if (this.#routes.get(route) === pending)
                    this.#routes.delete(route);
                },
              );
              if (!this.state.isCurrent(scope)) {
                yield* attempt(() => client.close(), { awaitOnInterrupt: true });
                return yield* Effect.fail(
                  new Error("Session changed during connection"),
                );
              }
              const key = JSON.stringify([
                client.installationId,
                scope.scopeId,
                scope.owner,
                connection.cwd,
              ]);
              const selected = this.#clients.getOrInsert(key, client);
              if (selected !== client)
                yield* attempt(() => client.close(), { awaitOnInterrupt: true });
              pending.client = selected;
              return yield* Effect.gen({ self: this }, function* () {
                yield* selected.openCoordinationEffect(
                  this.#registration(scope, connection),
                  (error) => {
                    if (this.state.isCurrent(scope))
                      this.state.notice(
                        `Coordination presence is unavailable for ${connection.id}: ${this.state.error(error)}. No operations were replayed`,
                      );
                  },
                );
                yield* Effect.try({
                  try: () => this.state.assertCurrent(scope),
                  catch: (error) => error,
                });
                return selected;
              }).pipe(
                Effect.onExit((exit) =>
                  Exit.isFailure(exit)
                    ? attempt(() => selected.close()).pipe(
                        Effect.catch((closeError) =>
                          Effect.sync(() => {
                            this.state.notice(
                              `Coordination close failed: ${this.state.error(closeError)}`,
                            );
                          }),
                        ),
                      )
                    : Effect.void,
                ),
              );
            }).pipe(
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  if (Exit.isFailure(exit) && this.#routes.get(route) === pending)
                    this.#routes.delete(route);
                }),
              ),
            ),
          ),
        ),
      };
      return pending;
    });
    const client = await run(pending.effect);
    this.state.assertCurrent(scope);
    if (
      expectedInstallation !== undefined &&
      client.installationId !== expectedInstallation
    )
      throw new Error(
        "Connection now names a different helper installation; refusing job control",
      );
    return client;
  }

  async disconnect(
    scope: Scope | undefined,
    connection: ExecutionTarget,
  ): Promise<void> {
    if (!scope) return;
    const route = JSON.stringify([
      ...(connection.backend === "local"
        ? ["local", connection.home]
        : ["ssh", connection.target]),
      scope.scopeId,
      scope.owner,
      connection.cwd,
    ]);
    const pending = this.#routes.get(route);
    if (!pending) return;
    this.#routes.delete(route);
    const client = await run(pending.effect);
    await client.close();
  }

  release(scope: Scope | undefined): Promise<void> {
    const pendingRoutes = [...this.#routes.values()];
    this.#routes.clear();
    this.#clients.clear();
    for (const foreground of scope?.foreground.values() ?? [])
      Effect.runSync(Deferred.succeed(foreground.done, undefined));
    // Final shutdown drains cleanup from earlier session switches too
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
                  this.state.notice(
                    `Coordination close failed: ${this.state.error(Cause.squash(cause))}`,
                  );
                }),
              ),
            ),
          { concurrency: "unbounded", discard: true },
        ),
      ),
    );
  }
}
