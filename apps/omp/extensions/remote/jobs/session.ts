import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Deferred, Effect } from "effect";
import type { Gateway } from "farstep/client/jobs/gateway";
import type {
  CoordinationRequest,
  CoordinationResult,
} from "farstep/protocol/coordination";
import type { JobObservation, TerminationResult } from "farstep/protocol/jobs/gateway";
import type { JobSnapshot } from "farstep/protocol/jobs/protocol";
import { parseJobSpec } from "farstep/protocol/jobs/protocol";
import type { Connections } from "../connections/state";
import type { ExecutionTarget } from "../connections/types";
import { assertIdentity } from "./broker";
import { deliverCompletion } from "./completion";
import { DEFAULT_TERMINATION_WAIT_MS } from "./limits/limits";
import { noticeError, sendJobNotice } from "./notices/notices";
import { ENTRY_TYPE, nativeKey, owner, recordInto, restoreScope } from "./records";
import { type LogOptions, SessionOutput } from "./session/output";

import { SessionRoutes } from "./session/routes";
import type { SessionState } from "./session/state";
import type {
  DeliveryRecord,
  JobRecord,
  JobView,
  LaunchRecord,
  Result,
  Scope,
} from "./types";

const MAX_SESSION_NOTICE_LENGTH = 768;

export class JobSession {
  readonly #api: ExtensionAPI;
  readonly #connections: Connections;
  readonly #routes: SessionRoutes;
  readonly #output: SessionOutput;
  #scope: Scope | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(api: ExtensionAPI, connections: Connections) {
    this.#api = api;
    this.#connections = connections;
    const state: SessionState = {
      isCurrent: (scope) => this.isCurrent(scope),
      assertCurrent: (scope) => this.assertCurrent(scope),
      notice: (content) => this.#notice(content),
      error: noticeError,
    };
    this.#routes = new SessionRoutes(state, (scope, client, notification) =>
      deliverCompletion(this, this.#api, scope, client, notification),
    );
    this.#output = new SessionOutput(api, state, (scope, client, record, signal) =>
      this.inspect(scope, client, record, signal),
    );
  }

  restore(ctx: ExtensionContext): void {
    void this.#release();
    const scope = restoreScope(ctx);
    this.#scope = scope;
    const targets = [
      "local",
      ...this.#connections.connections
        .values()
        .filter((connection) => connection.helper?.jobsReady === true)
        .map((connection) => connection.id),
    ];
    for (const target of targets) {
      void this.#connections
        .execution(target, scope.projectDir)
        .then((connection) => this.client(scope, connection))
        .catch((error) => {
          if (this.isCurrent(scope))
            this.#notice(
              `Coordination registration is unavailable for ${target}: ${noticeError(error)}. No operations were replayed`,
            );
        });
    }
    const records = new Map<string, LaunchRecord>();
    for (const record of scope.all.values()) {
      if (
        !record.nativeId ||
        !scope.deliveries.get(
          nativeKey(record.installationId, record.scopeId, record.nativeId),
        )?.delivered
      )
        records.set(
          `${record.connectionId}:${record.installationId}:${record.scopeId}`,
          record,
        );
    }
    for (const record of records.values()) {
      void this.forRecord(scope, record).catch((error) => {
        if (!this.isCurrent(scope)) return;
        this.#notice(
          `Job completion subscription is unavailable: ${noticeError(error)}. Commands were not replayed; inspect ${record.name} with job`,
        );
      });
    }
  }

  current(ctx: ExtensionContext): Scope {
    if (this.#closed) throw new Error("Job manager is closed");
    if (
      !this.#scope ||
      this.#scope.owner !== owner(ctx) ||
      this.#scope.ctx.cwd !== ctx.cwd
    )
      this.restore(ctx);
    if (!this.#scope) throw new Error("Job scope was not initialized");
    return this.#scope;
  }

  isCurrent(scope: Scope): boolean {
    return !this.#closed && this.#scope === scope;
  }

  assertCurrent(scope: Scope): void {
    if (!this.isCurrent(scope))
      throw new Error(
        "Session or branch changed; the command was not replayed. Inspect its exact handle with job",
      );
  }

  #notice(content: string): void {
    sendJobNotice(this.#api, content.slice(0, MAX_SESSION_NOTICE_LENGTH));
  }

  async coordination(
    connection: ExecutionTarget,
    input: CoordinationRequest,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<CoordinationResult> {
    signal?.throwIfAborted();
    const scope = this.current(ctx);
    const client = await this.client(scope, connection);
    signal?.throwIfAborted();
    return client.coordination(input, signal);
  }

  async touch(connection: ExecutionTarget, ctx: ExtensionContext): Promise<void> {
    await this.client(this.current(ctx), connection);
  }

  client(
    scope: Scope,
    connection: ExecutionTarget,
    expectedInstallation?: string,
  ): Promise<Gateway> {
    return this.#routes.client(scope, connection, expectedInstallation);
  }

  delivery(scope: Scope, job: JobRecord): DeliveryRecord {
    return this.#output.delivery(scope, job);
  }

  logs(
    scope: Scope,
    client: Gateway,
    job: JobRecord,
    snapshot: JobSnapshot,
    options: LogOptions = {},
    signal?: AbortSignal,
  ): Promise<JobView> {
    return this.#output.logs(scope, client, job, snapshot, options, signal);
  }

  consume(...args: Parameters<SessionOutput["consume"]>): DeliveryRecord {
    return this.#output.consume(...args);
  }

  result(...args: Parameters<SessionOutput["result"]>): Result {
    return this.#output.result(...args);
  }

  disconnect(connection: ExecutionTarget): Promise<void> {
    return this.#routes.disconnect(this.#scope, connection);
  }

  #release(): Promise<void> {
    return this.#routes.release(this.#scope);
  }

  async forRecord(scope: Scope, record: LaunchRecord): Promise<Gateway> {
    if (
      record.scopeId !== scope.scopeId ||
      record.owner !== scope.owner ||
      record.projectDir !== scope.projectDir
    )
      throw new Error("Job belongs to a different immutable execution scope");
    return this.client(
      scope,
      await this.#connections.execution(record.connectionId, record.projectDir),
      record.installationId,
    );
  }

  begin(scope: Scope, name: string): () => void {
    const foreground = scope.foreground.getOrInsertComputed(name, () => ({
      count: 0,
      done: Deferred.makeUnsafe<void>(),
    }));
    foreground.count++;
    const current = foreground;
    return () => {
      if (--current.count === 0) {
        scope.foreground.delete(name);
        Effect.runSync(Deferred.succeed(current.done, undefined));
      }
    };
  }

  saveJob(scope: Scope, record: LaunchRecord): void {
    this.assertCurrent(scope);
    recordInto(scope.all, record);
    recordInto(scope.branch, record);
    this.#api.appendEntry(ENTRY_TYPE, record);
  }

  async inspect(
    scope: Scope,
    client: Gateway,
    record: LaunchRecord,
    signal?: AbortSignal,
  ): Promise<{ job: JobRecord; snapshot: JobSnapshot }> {
    this.assertCurrent(scope);
    if (
      client.installationId !== record.installationId ||
      client.scopeId !== record.scopeId ||
      client.owner !== record.owner
    )
      throw new Error(
        `Job ${record.name} belongs to a different helper installation or scope`,
      );
    const described = await client.request(
      { op: "describe", name: record.name },
      signal,
    );
    this.assertCurrent(scope);
    const snapshot = described.snapshot;
    const expected = parseJobSpec(record.spec);
    // The broker updates lifetime and geometry without restarting the command
    const actual = {
      ...described.spec,
      persist: expected.persist,
      ...(expected.terminalSize ? { terminalSize: expected.terminalSize } : {}),
    };
    if (
      snapshot.owner !== record.owner ||
      snapshot.name !== record.name ||
      !isDeepStrictEqual(actual, expected)
    )
      throw new Error(
        `Native identity or launch specification for ${record.name} changed; refusing control`,
      );
    const job: JobRecord =
      record.kind === "job"
        ? record
        : {
            ...record,
            kind: "job",
            nativeId: snapshot.id,
            startedAt: snapshot.startedAt,
            nativeCreatedAt: snapshot.createdAt,
          };
    assertIdentity(job, snapshot);
    if (record.kind === "launch") {
      recordInto(scope.all, job);
      if (scope.branch.has(job.name)) this.saveJob(scope, job);
    }
    return { job, snapshot };
  }

  async observe(
    scope: Scope,
    client: Gateway,
    job: JobRecord,
    _daemon: JobSnapshot,
    options: {
      settleMs?: number | undefined;
      maxWaitMs?: number | undefined;
      waitForFrame?: boolean | undefined;
    } = {},
    signal?: AbortSignal,
  ): Promise<JobObservation> {
    this.assertCurrent(scope);
    const observation = await client.observe(
      { name: job.name, nativeId: job.nativeId, ...options },
      signal,
    );
    this.assertCurrent(scope);
    assertIdentity(job, observation.snapshot);
    const view = await this.logs(
      scope,
      client,
      job,
      observation.snapshot,
      { screenLogs: observation.logs },
      signal,
    );
    return { ...observation, ...view };
  }

  async stop(
    scope: Scope,
    client: Gateway,
    job: JobRecord,
    snapshot: JobSnapshot,
  ): Promise<{ snapshot: JobSnapshot; notice: string } & TerminationResult> {
    this.assertCurrent(scope);
    const stopped = await client.terminate({
      name: job.name,
      nativeId: job.nativeId,
      actionId: randomUUID(),
      kind: "stop",
      timeoutMs: DEFAULT_TERMINATION_WAIT_MS,
    });
    this.assertCurrent(scope);
    if (stopped.receipt.snapshot) {
      assertIdentity(job, stopped.receipt.snapshot);
      snapshot = stopped.receipt.snapshot;
    } else ({ snapshot } = await this.inspect(scope, client, job));
    return {
      ...stopped,
      snapshot,
      notice: `Stop ${stopped.receipt.state} · leader ${stopped.termination.leaderExited ? "exited" : "not confirmed exited"} · children ${stopped.termination.childrenGone}`,
    };
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = this.#release();
    this.#scope = undefined;
    return this.#closing;
  }
}
