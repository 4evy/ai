import { Deferred, Effect } from "effect";
import type { Gateway } from "farstep/client/jobs/gateway";
import { JobRoutes } from "farstep/client/jobs/recovery";
import type { CoordinationOpen } from "farstep/protocol/coordination";
import type { JobCompletionNotification } from "farstep/protocol/jobs/protocol";
import type { ExecutionTarget } from "../../connections/types";
import { gatewayTransportEffect } from "../gateway/connection";
import type { LaunchRecord, Scope } from "../types";
import type { SessionState } from "./state";

export class SessionRoutes {
  readonly #routes: JobRoutes<Scope, ExecutionTarget>;

  constructor(
    state: SessionState,
    completion: (
      scope: Scope,
      client: Gateway,
      notification: JobCompletionNotification,
    ) => Promise<boolean>,
  ) {
    this.#routes = new JobRoutes({
      isCurrent: (scope) => state.isCurrent(scope),
      assertCurrent: (scope) => state.assertCurrent(scope),
      address: (connection) =>
        connection.backend === "local"
          ? ["local", connection.home]
          : ["ssh", connection.target],
      project: (connection) => connection.cwd,
      transport: (connection, scope) =>
        gatewayTransportEffect(connection, scope.scopeId, scope.owner),
      registration: (scope, connection) => this.#registration(scope, connection),
      completion,
      failure: (_scope, connection, error) =>
        state.notice(
          `Coordination presence is unavailable for ${connection.id}: ${state.error(error)}. No operations were replayed`,
        ),
      closeFailure: (error) =>
        state.notice(`Coordination close failed: ${state.error(error)}`),
    });
  }

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

  client(
    scope: Scope,
    connection: ExecutionTarget,
    expectedInstallation?: string,
  ): Promise<Gateway> {
    return this.#routes.client(scope, connection, expectedInstallation);
  }

  recover(
    scope: Scope,
    record: LaunchRecord,
    resolve: (connectionId: string, projectDir: string) => Promise<ExecutionTarget>,
  ): Promise<Gateway> {
    return this.#routes.recover(scope, record, resolve);
  }

  disconnect(scope: Scope | undefined, connection: ExecutionTarget): Promise<void> {
    return scope ? this.#routes.disconnect(scope, connection) : Promise.resolve();
  }

  release(scope: Scope | undefined): Promise<void> {
    for (const foreground of scope?.foreground.values() ?? [])
      Effect.runSync(Deferred.succeed(foreground.done, undefined));
    return this.#routes.release();
  }
}
