import { randomUUID } from "node:crypto";
import { attempt, Lifetime, run } from "@ai/core/effect/effect";
import { Effect, Exit } from "effect";
import * as v from "valibot";
import type {
  CoordinationOpen,
  CoordinationRequest,
  CoordinationResult,
} from "../../protocol/coordination";
import { coordinationResultSchema } from "../../protocol/coordination";
import type {
  ActionReceipt,
  ActionRequest,
  JobObservation,
  ScriptRunner,
  TerminationRequest,
  TerminationResult,
  TerminationStatus,
} from "../../protocol/jobs/gateway";
import {
  actionReceiptSchema,
  JOB_COMPLETION_METHOD,
  observeResultSchema,
  terminationResultSchema,
  terminationStatusSchema,
} from "../../protocol/jobs/gateway";
import type {
  JobCompletionNotification,
  JobOperation,
  JobRpcResult,
} from "../../protocol/jobs/protocol";
import { parseJobRpcResult, parseJobWireMessage } from "../../protocol/jobs/protocol";
import type { WorkflowPrepare } from "../../protocol/workflow/workflow";
import {
  workflowPreparedSchema,
  workflowResultSchema,
} from "../../protocol/workflow/workflow";
import type { HelperConfig, HelperConnection } from "../../transport/connection/bun";
import { connectHelperEffect } from "../../transport/connection/bun";

export interface GatewayConnection {
  backend: "local" | "ssh";
  platform: "linux" | "macos";
  transport: HelperConfig;
}

const notificationSchema = v.strictObject({ notification: v.unknown() });
const acknowledgmentSchema = v.strictObject({ accepted: v.literal(true) });

import { gatewayCallEffect } from "./gateway/call";
import { gatewayEnvironmentEffect } from "./gateway/connection";
import { GatewayPresence } from "./gateway/presence";

const GATEWAY_TIMEOUT_MS = 30_000;
const GATEWAY_GRACE_MS = 15_000;
const OBSERVATION_WAIT_MS = 500;
const TERMINATION_WAIT_MS = 2_000;
const COORDINATION_CLOSE_TIMEOUT_MS = 5_000;

function operationTimeout(operation: JobOperation): number {
  if (operation.op === "start")
    return operation.spec.ready?.timeoutMs ?? GATEWAY_TIMEOUT_MS;
  return "timeoutMs" in operation ? operation.timeoutMs : GATEWAY_TIMEOUT_MS;
}

export class Gateway {
  readonly backend: "local" | "ssh";
  readonly scopeId: string;
  readonly owner: string;
  readonly installationId: string;
  readonly env: Record<string, string>;
  readonly scriptRunner: ScriptRunner;
  readonly #helper: HelperConnection;
  #closed = false;
  readonly #lifetime: Lifetime;
  readonly #presence: GatewayPresence;
  #closing: Promise<void> | undefined;
  #onRegistered: (() => void) | undefined;

  private constructor(
    helper: HelperConnection,
    backend: "local" | "ssh",
    scopeId: string,
    owner: string,
    env: Record<string, string>,
    scriptRunner: ScriptRunner,
    lifetime: Lifetime,
  ) {
    this.#helper = helper;
    this.backend = backend;
    this.scopeId = scopeId;
    this.owner = owner;
    this.installationId = helper.identity.installationId;
    this.env = env;
    this.scriptRunner = scriptRunner;
    this.#lifetime = lifetime;
    this.#presence = new GatewayPresence(
      owner,
      lifetime,
      (tool, args, timeoutMs) => this.#callEffect(tool, args, timeoutMs),
      () => this.#closed,
      () => this.close(),
      () => {
        this.#onRegistered?.();
        this.#onRegistered = undefined;
      },
    );
  }

  static readonly connectEffect = Effect.fnUntraced(function* (
    connection: GatewayConnection,
    scopeId: string,
    owner: string,
    onCompletion: (
      client: Gateway,
      notification: JobCompletionNotification,
    ) => Promise<void>,
    onClose: (client: Gateway | undefined) => void,
  ) {
    const transport = connection.transport;
    let gateway: Gateway | undefined;
    let transportClosed = false;
    const queued: JobCompletionNotification[] = [];
    const deliver = (notification: JobCompletionNotification) => {
      if (!gateway) {
        queued.push(notification);
        return;
      }
      if (!gateway.#presence.registered) {
        queued.push(notification);
        return;
      }
      const current = gateway;
      void run(
        Effect.gen(function* () {
          yield* attempt(() => onCompletion(current, notification), {
            awaitOnInterrupt: true,
          });
          if (current.#closed) return;
          const response = yield* current.#helper.callEffect("job.ack_completion", {
            completionId: notification.completionId,
          });
          yield* Effect.try({
            try: () => v.parse(acknowledgmentSchema, response.structuredContent),
            catch: (error) => error,
          });
        }),
      ).catch(() => {
        void current.close().catch((error) => current.#presence.failure(error));
      });
    };
    const lifetime = new Lifetime("sequential");
    return yield* Effect.gen(function* () {
      const helper = yield* Effect.acquireRelease(
        Effect.interruptible(
          connectHelperEffect(`jobs-${randomUUID()}`, transport, {
            onNotification(method, params) {
              if (method !== JOB_COMPLETION_METHOD) return;
              const message = parseJobWireMessage(
                v.parse(notificationSchema, params).notification,
              );
              if (!("event" in message))
                throw new Error("Invalid job completion notification");
              deliver(message);
            },
            onClose() {
              transportClosed = true;
              if (gateway) {
                const unexpected = !gateway.#closed;
                gateway.#closed = true;
                gateway.#presence.stopHeartbeat();
                const closed = gateway;
                closed.#closing ??= closed.#lifetime.close();
                void closed.#closing.catch((error) => closed.#presence.failure(error));
                if (unexpected && gateway.#presence.registered)
                  gateway.#presence.failure(
                    new Error(
                      "Helper connection closed; coordination presence is unavailable",
                    ),
                  );
              }
              onClose(gateway);
            },
          }),
        ),
        (helper) => helper.closeEffect,
      );
      const { env, scriptRunner } = yield* gatewayEnvironmentEffect(helper, connection);
      if (transportClosed)
        return yield* Effect.fail(new Error("Job gateway closed during negotiation"));
      gateway = new Gateway(
        helper,
        connection.backend,
        scopeId,
        owner,
        env,
        scriptRunner,
        lifetime,
      );
      gateway.#onRegistered = () => {
        for (const notification of queued.splice(0)) deliver(notification);
      };
      return gateway;
    }).pipe(
      (effect) => lifetime.runEffect(effect),
      Effect.onExit((exit) =>
        Exit.isFailure(exit) ? lifetime.closeEffect : Effect.void,
      ),
    );
  });

  static connect(
    connection: GatewayConnection,
    scopeId: string,
    owner: string,
    onCompletion: (
      client: Gateway,
      notification: JobCompletionNotification,
    ) => Promise<void>,
    onClose: (client: Gateway | undefined) => void,
  ): Promise<Gateway> {
    return run(
      Gateway.connectEffect(connection, scopeId, owner, onCompletion, onClose),
    );
  }

  async request<Operation extends JobOperation>(
    operation: Operation,
    signal?: AbortSignal,
  ): Promise<JobRpcResult<Operation["op"]>> {
    const response = await this.#call(
      "job.request",
      { operation },
      signal,
      operationTimeout(operation) + GATEWAY_GRACE_MS,
    );
    return parseJobRpcResult(operation, response);
  }

  #callEffect(
    tool: string,
    args: Record<string, unknown>,
    timeoutMs = GATEWAY_TIMEOUT_MS,
  ) {
    return gatewayCallEffect(
      this.#helper,
      this,
      () => this.#closed,
      tool,
      args,
      timeoutMs,
    );
  }

  #call(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = GATEWAY_TIMEOUT_MS,
  ): Promise<unknown> {
    return run(this.#callEffect(tool, args, timeoutMs), signal);
  }
  openCoordinationEffect(
    input: CoordinationOpen,
    onFailure: (error: unknown) => void,
  ): Effect.Effect<void, unknown> {
    return this.#presence.openEffect(input, onFailure);
  }

  openCoordination(
    input: CoordinationOpen,
    onFailure: (error: unknown) => void,
  ): Promise<void> {
    return this.#presence.open(input, onFailure);
  }

  coordination(
    input: CoordinationRequest,
    signal?: AbortSignal,
  ): Promise<CoordinationResult> {
    return this.#presence.request(input, signal);
  }

  async prepareWorkflow(input: WorkflowPrepare, signal?: AbortSignal) {
    return v.parse(
      workflowPreparedSchema,
      await this.#call("job.workflow_prepare", input, signal),
    );
  }

  async startWorkflow(
    name: string,
    fingerprint: string,
    spec: Extract<JobOperation, { op: "start" }>["spec"],
    signal?: AbortSignal,
  ) {
    const result = parseJobRpcResult(
      { op: "start", spec, owner: this.owner },
      await this.#call("job.workflow_start", { name, fingerprint }, signal),
    );
    return result;
  }

  async workflow(name: string, signal?: AbortSignal, step?: string) {
    return v.parse(
      workflowResultSchema,
      await this.#call(
        "job.workflow_inspect",
        { name, ...(step !== undefined ? { step } : {}) },
        signal,
      ),
    );
  }

  async cancelWorkflow(name: string, step?: string, signal?: AbortSignal) {
    return v.parse(
      workflowResultSchema,
      await this.#call(
        "job.workflow_cancel",
        { name, ...(step !== undefined ? { step } : {}) },
        signal,
      ),
    );
  }

  async observe(
    input: {
      name: string;
      nativeId: string;
      settleMs?: number | undefined;
      maxWaitMs?: number | undefined;
      waitForFrame?: boolean | undefined;
    },
    signal?: AbortSignal,
  ): Promise<JobObservation> {
    return v.parse(
      observeResultSchema,
      await this.#call(
        "job.observe",
        input,
        signal,
        (input.maxWaitMs ?? OBSERVATION_WAIT_MS) + GATEWAY_GRACE_MS,
      ),
    );
  }

  async action(input: ActionRequest, signal?: AbortSignal): Promise<ActionReceipt> {
    return v.parse(
      actionReceiptSchema,
      await this.#call(
        "job.action",
        input,
        signal,
        (input.maxWaitMs ?? OBSERVATION_WAIT_MS) + GATEWAY_GRACE_MS,
      ),
    );
  }

  async receipt(
    input: { name: string; nativeId: string; actionId: string },
    signal?: AbortSignal,
  ): Promise<ActionReceipt> {
    return v.parse(actionReceiptSchema, await this.#call("job.receipt", input, signal));
  }

  async terminate(
    input: TerminationRequest,
    signal?: AbortSignal,
  ): Promise<TerminationResult> {
    return v.parse(
      terminationResultSchema,
      await this.#call(
        "job.terminate",
        input,
        signal,
        (input.timeoutMs ?? TERMINATION_WAIT_MS) + GATEWAY_GRACE_MS,
      ),
    );
  }

  async termination(
    input: { name: string; nativeId: string },
    signal?: AbortSignal,
  ): Promise<TerminationStatus> {
    return v.parse(
      terminationStatusSchema,
      await this.#call("job.termination", input, signal),
    );
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    if (this.#closed) return this.#lifetime.close();
    this.#closed = true;
    this.#closing = run(
      Effect.gen({ self: this }, function* () {
        yield* this.#presence.stopHeartbeatEffect();
        if (this.#presence.registered) {
          const response = yield* this.#helper.callEffect(
            "coordination.close",
            {},
            COORDINATION_CLOSE_TIMEOUT_MS,
          );
          yield* Effect.try({
            try: () => v.parse(coordinationResultSchema, response.structuredContent),
            catch: (error) => error,
          });
        }
      }).pipe(Effect.ensuring(this.#lifetime.closeEffect)),
    );
    return this.#closing;
  }
}
