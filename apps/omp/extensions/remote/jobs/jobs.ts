import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import type {
  CoordinationRequest,
  CoordinationResult,
} from "farstep/protocol/coordination";
import type { SudoInput } from "farstep/remote/sudo/script";
import type { Connections } from "../connections/state";
import type { Connection, ExecutionTarget } from "../connections/types";
import { runSudo } from "../sudo/sudo";
import { controlJob } from "./control";
import { runBatchJob, runJob } from "./launch/launch";
import { JobSession } from "./session";
import type { BatchInput, JobInput, RemoteJobDetails, Result, RunInput } from "./types";

export class RemoteJobs {
  readonly #session: JobSession;
  constructor(api: ExtensionAPI, connections: Connections) {
    this.#session = new JobSession(api, connections);
  }
  restore(ctx: ExtensionContext): void {
    this.#session.restore(ctx);
  }
  coordination(
    connection: ExecutionTarget,
    input: CoordinationRequest,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<CoordinationResult> {
    return this.#session.coordination(connection, input, ctx, signal);
  }
  touch(connection: ExecutionTarget, ctx: ExtensionContext): Promise<void> {
    return this.#session.touch(connection, ctx);
  }
  run(
    connection: ExecutionTarget,
    input: RunInput,
    ctx: ExtensionContext,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<RemoteJobDetails>,
  ): Promise<Result> {
    return runJob(this.#session, connection, input, ctx, signal, onUpdate);
  }
  batch(
    connection: ExecutionTarget,
    input: BatchInput,
    ctx: ExtensionContext,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<RemoteJobDetails>,
  ): Promise<Result> {
    return runBatchJob(this.#session, connection, input, ctx, signal, onUpdate);
  }
  control(
    input: JobInput,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<Result> {
    return controlJob(this.#session, input, ctx, signal);
  }
  sudo(
    connection: Connection,
    input: SudoInput,
    ctx: ExtensionContext,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback,
  ) {
    return runSudo(this.#session, connection, input, ctx, signal, onUpdate);
  }
  disconnect(connection: ExecutionTarget): Promise<void> {
    return this.#session.disconnect(connection);
  }
  close(): Promise<void> {
    return this.#session.close();
  }
}
