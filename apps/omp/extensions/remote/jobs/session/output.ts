import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Gateway } from "farstep/client/jobs/gateway";
import type { JobLogs } from "farstep/protocol/jobs/gateway";
import type { JobSnapshot } from "farstep/protocol/jobs/protocol";
import {
  JOB_OUTPUT_MAX_BYTES,
  type JobRpcResult,
} from "farstep/protocol/jobs/protocol";
import { isJobTerminal } from "farstep/protocol/jobs/states";
import { DEFAULT_LINES } from "farstep/remote/jobs/validation/validation";
import { assertIdentity, terminal } from "../broker";
import { decodeOutput, type OutputRead } from "../decoding";
import { type JobResultOptions, jobResult } from "../output";
import { ENTRY_TYPE, JOB_RECORD_VERSION, nativeKey } from "../records";
import type {
  DeliveryRecord,
  JobRecord,
  JobView,
  LaunchRecord,
  Logs,
  Result,
  Scope,
} from "../types";

import type { SessionState } from "./state";

export type LogOptions = {
  lines?: number | undefined;
  cursor?: number | undefined;
  follow?: boolean | undefined;
  timeoutMs?: number | undefined;
  renderTerminalRows?: boolean | undefined;
  screenLogs?: JobLogs | undefined;
};

export class SessionOutput {
  readonly #outputReads = new WeakMap<Logs, OutputRead>();
  constructor(
    private readonly api: ExtensionAPI,
    private readonly state: SessionState,
    private readonly inspect: (
      scope: Scope,
      client: Gateway,
      record: LaunchRecord,
      signal?: AbortSignal,
    ) => Promise<{ job: JobRecord; snapshot: JobSnapshot }>,
  ) {}

  delivery(scope: Scope, job: JobRecord): DeliveryRecord {
    const existing = scope.deliveries.get(
      nativeKey(job.installationId, job.scopeId, job.nativeId),
    );
    if (existing?.owner === job.owner && existing.name === job.name) return existing;
    return {
      version: JOB_RECORD_VERSION,
      kind: "delivery",
      name: job.name,
      owner: job.owner,
      nativeId: job.nativeId,
      installationId: job.installationId,
      scopeId: job.scopeId,
      delivered: false,
    };
  }

  async logs(
    scope: Scope,
    client: Gateway,
    job: JobRecord,
    snapshot: JobSnapshot,
    options: LogOptions = {},
    signal?: AbortSignal,
  ): Promise<JobView> {
    this.state.assertCurrent(scope);
    const screenLogs = await this.#screenLogs(client, job, options, signal);
    const requestedCursor =
      options.cursor ?? this.delivery(scope, job).outputCursor ?? 0;
    const output = await this.#readOutput(
      scope,
      client,
      job,
      snapshot,
      options,
      requestedCursor,
      screenLogs,
      signal,
    );
    const logs = this.#outputLogs(job, output, screenLogs, options, requestedCursor);
    if (!screenLogs) ({ snapshot } = await this.inspect(scope, client, job, signal));
    assertIdentity(job, snapshot);
    logs.terminationStatus = await client.termination(
      { name: job.name, nativeId: job.nativeId },
      signal,
    );
    this.state.assertCurrent(scope);
    if (job.workflowFingerprint)
      logs.workflow = await client.workflow(job.name, signal);
    const decoded = this.#decode(scope, job, snapshot, logs);
    Object.assign(logs, decoded.logs);
    return { snapshot, logs };
  }

  async #screenLogs(
    client: Gateway,
    job: JobRecord,
    options: LogOptions,
    signal?: AbortSignal,
  ): Promise<JobLogs | undefined> {
    let screenLogs = options.screenLogs;
    if (!screenLogs && options.renderTerminalRows) {
      screenLogs = await client.request(
        {
          op: "logs",
          name: job.name,
          lines: options.lines ?? DEFAULT_LINES,
          head: false,
          follow: options.follow ?? false,
          timeoutMs: options.timeoutMs ?? 0,
          renderTerminalRows: true,
        },
        signal,
      );
    }
    return screenLogs;
  }

  async #readOutput(
    scope: Scope,
    client: Gateway,
    job: JobRecord,
    snapshot: JobSnapshot,
    options: LogOptions,
    requestedCursor: number,
    screenLogs: JobLogs | undefined,
    signal?: AbortSignal,
  ) {
    // A screen covers its whole byte range; retain a bounded raw tail alongside it
    const cursor = screenLogs
      ? Math.min(
          screenLogs.cursor,
          Math.max(requestedCursor, screenLogs.cursor - JOB_OUTPUT_MAX_BYTES),
        )
      : requestedCursor;
    let output = await client.request(
      {
        op: "output",
        name: job.name,
        cursor,
        follow: !screenLogs && (options.follow ?? false),
        timeoutMs: options.timeoutMs ?? 0,
      },
      signal,
    );
    this.state.assertCurrent(scope);
    if (
      !screenLogs &&
      options.cursor === undefined &&
      terminal(snapshot) &&
      output.cursor < output.availableEnd
    ) {
      output = await client.request(
        {
          op: "output",
          name: job.name,
          cursor: Math.max(requestedCursor, output.availableEnd - JOB_OUTPUT_MAX_BYTES),
          follow: false,
          timeoutMs: 0,
        },
        signal,
      );
      this.state.assertCurrent(scope);
    }
    return output;
  }

  #outputLogs(
    job: JobRecord,
    output: Extract<JobRpcResult, { op: "output" }>,
    screenLogs: JobLogs | undefined,
    options: LogOptions,
    requestedCursor: number,
  ): Logs {
    const end = screenLogs ? Math.min(output.cursor, screenLogs.cursor) : output.cursor;
    const bytes = Buffer.from(output.data, "base64").subarray(
      0,
      Math.max(0, end - output.startCursor),
    );
    const logs: Logs = {
      ...screenLogs,
      op: "logs",
      name: job.name,
      text: "",
      cursor: end,
      timedOut: screenLogs?.timedOut ?? output.timedOut,
      state: screenLogs?.state ?? output.state,
      ...(options.cursor !== undefined ? { replay: true } : {}),
    };
    this.#outputReads.set(logs, {
      bytes,
      startCursor: output.startCursor,
      cursor: end,
      availableEnd: output.availableEnd,
      availableStart: output.availableStart,
      requestedCursor,
      replay: options.cursor !== undefined,
      lines: options.lines ?? DEFAULT_LINES,
    });
    return logs;
  }

  #decode(
    scope: Scope,
    job: JobRecord,
    snapshot: JobSnapshot,
    logs: Logs,
  ): { logs: Logs; pending: string | undefined; redrawing: boolean } {
    return decodeOutput(
      this.delivery(scope, job),
      this.#outputReads.get(logs),
      snapshot,
      logs,
    );
  }

  consume(
    scope: Scope,
    job: JobRecord,
    snapshot: JobSnapshot,
    logs: Logs,
    options: {
      markDelivered?: boolean | undefined;
      completionId?: string | undefined;
      deliveredAt?: number | undefined;
    } = {},
  ): DeliveryRecord {
    this.state.assertCurrent(scope);
    const previous = this.delivery(scope, job);
    const decoded = this.#decode(scope, job, snapshot, logs);
    const advancing = logs.cursor >= (previous.outputCursor ?? 0);
    const read = this.#outputReads.get(logs);
    const complete = completeOutput(snapshot, logs, read);
    const delivery: DeliveryRecord = {
      ...previous,
      outputCursor: Math.max(previous.outputCursor ?? 0, logs.cursor),
      ...(advancing ? { decoderPending: decoded.pending } : {}),
      terminalRedraw: decoded.redrawing,
      ...(complete && options.markDelivered ? { delivered: true } : {}),
      ...(snapshot.exitCode !== undefined ? { remoteExitCode: snapshot.exitCode } : {}),
      ...(snapshot.exitedAt !== undefined ? { finishedAt: snapshot.exitedAt } : {}),
      ...(options.completionId !== undefined
        ? { completionId: options.completionId }
        : {}),
      ...(options.deliveredAt !== undefined
        ? { deliveredAt: options.deliveredAt }
        : {}),
    };
    const key = nativeKey(job.installationId, job.scopeId, job.nativeId);
    if (options.deliveredAt !== undefined) scope.deliveries.set(key, delivery);
    this.api.appendEntry(ENTRY_TYPE, delivery);
    scope.deliveries.set(key, delivery);
    return delivery;
  }

  result(
    scope: Scope,
    job: JobRecord,
    snapshot: JobSnapshot,
    logs: Logs,
    options: JobResultOptions = {},
  ): Result {
    this.state.assertCurrent(scope);
    const decoded = this.#decode(scope, job, snapshot, logs);
    const previous = this.delivery(scope, job);
    const cursor = Math.max(previous.outputCursor ?? 0, logs.cursor);
    // A message alone can restore safely even if appending its delivery entry fails
    const pending =
      logs.cursor >= (previous.outputCursor ?? 0)
        ? decoded.pending
        : previous.decoderPending;
    const unreadCursor = cursor - (pending ? Buffer.byteLength(pending, "base64") : 0);
    const result = jobResult(snapshot.exitCode, job, snapshot, decoded.logs, {
      ...options,
      unreadCursor,
      terminalRedraw: decoded.redrawing,
    });
    if (options.consume !== false) this.consume(scope, job, snapshot, logs, options);
    return result;
  }
}

function completeOutput(
  snapshot: JobSnapshot,
  logs: Logs,
  read: OutputRead | undefined,
): boolean {
  const complete =
    terminal(snapshot) &&
    isJobTerminal(logs.state) &&
    (!read || read.cursor >= read.availableEnd);
  return complete;
}
