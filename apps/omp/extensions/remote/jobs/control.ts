import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { toError } from "@oh-my-pi/pi-utils/type-guards";
import type { Gateway } from "farstep/client/jobs/gateway";
import { assertIdentity } from "farstep/client/jobs/recovery";
import type { JobObservation } from "farstep/protocol/jobs/gateway";
import { isJobTerminal as terminal } from "farstep/protocol/jobs/states";
import {
  DEFAULT_LINES,
  validateLogPattern,
} from "farstep/remote/jobs/validation/validation";
import { ACTION_HANDLERS, type ControlContext, type ControlEffects } from "./actions";
import { publicReceipt } from "./output";
import { receiptStatus } from "./presentation";
import type { JobSession } from "./session";
import {
  JOB_ACTIONS,
  type JobInput,
  type LaunchRecord,
  type Logs,
  type Result,
  type Scope,
} from "./types";

const DEFAULT_SETTLING_WAIT_MS = 500;
const MAX_SETTLING_WAIT_MS = 5000;
const WORKFLOW_STEP_ACTIONS = new Set<JobInput["action"]>(["status", "logs", "cancel"]);

async function listJobs(
  session: JobSession,
  scope: Scope,
  signal?: AbortSignal,
): Promise<Result> {
  const jobs = [];
  for (const record of scope.branch.values()) {
    try {
      const client = await session.forRecord(scope, record);
      const { job, snapshot } = await session.inspect(scope, client, record, signal);
      jobs.push({
        job: job.name,
        state: snapshot.state,
        exitCode: snapshot.exitCode ?? null,
        connection: job.connectionId,
        lifetime: snapshot.persist ? "persist" : "session",
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      jobs.push({
        job: record.name,
        state: "unavailable",
        error: toError(error).message,
      });
    }
  }
  return {
    content: [{ type: "text", text: JSON.stringify({ jobs }) }],
    details: {},
    isError: false,
  };
}

async function recoverReceipt(
  client: Gateway,
  record: LaunchRecord,
  input: JobInput,
  signal?: AbortSignal,
): Promise<Result> {
  const name = record.name;
  if (!input.actionId) throw new Error("receipt requires actionId");
  if (!record.nativeId)
    throw new Error(
      "The launch has no confirmed native identity; inspect its status before receipt recovery",
    );
  const receipt = await client.receipt(
    {
      name,
      nativeId: record.nativeId,
      actionId: input.actionId,
    },
    signal,
  );
  const safeReceipt = publicReceipt(receipt);
  const styledRows = receipt.logs?.terminalStyleRows ?? receipt.logs?.terminalRows;
  const terminalRows = styledRows?.map((row) => Bun.stripANSI(row));
  return {
    content: [
      {
        type: "text",
        text: [
          `Job ${name} · action ${receipt.actionId}: ${receiptStatus(safeReceipt)}`,
          "Recovered historical receipt; no input was resent. Current process state was not inferred",
          JSON.stringify({ receipt: safeReceipt }),
          ...(receipt.screenVersion
            ? [
                `Observed screen ${receipt.screenVersion}${receipt.settled ? " · settled" : " · unsettled"}`,
              ]
            : []),
          ...(styledRows ? [styledRows.join("\n")] : []),
          ...(safeReceipt.error ? [safeReceipt.error] : []),
        ].join("\n"),
      },
    ],
    details: {
      job: name,
      connectionId: record.connectionId,
      receipt: safeReceipt,
      remoteState: "unknown",
      newOutput: "",
      screenVersion: receipt.screenVersion,
      settled: receipt.settled,
      terminalRows,
      terminalStyleRows: styledRows,
      observedAt: receipt.observedAt,
      cursor: receipt.logs?.cursor,
    },
    isError: receipt.state !== "processed",
  };
}

async function renderControlResult(
  context: ControlContext,
  effects: ControlEffects,
  lines: number,
): Promise<Result> {
  const { session, scope, job, input, signal, name, settling } = context;
  let { snapshot, client } = context;
  let observation: JobObservation | undefined;
  snapshot = effects.snapshot ?? snapshot;
  client = effects.client ?? client;
  const { notice, waitTimedOut, matched, receipt, termination } = effects;
  const fromReceipt = await controlReceipt(context, effects, client, snapshot);
  snapshot = fromReceipt.snapshot;
  observation = fromReceipt.observation;
  if (fromReceipt.result) return fromReceipt.result;
  const screen = controlScreen(job, input, snapshot);
  if (screen && !observation)
    observation = await session.observe(scope, client, job, snapshot, settling, signal);
  const unread = await controlUnread(context, client, snapshot, screen, lines);
  const view = unread ?? observation;
  if (!view) throw new Error("Job observation is unavailable");
  // Keep object identity so the session retains its byte-read metadata for replay
  const logs: Logs = view.logs;
  if (input.step !== undefined)
    logs.workflow = await client.workflow(name, signal, input.step);
  const result = session.result(scope, job, view.snapshot, logs, {
    notice,
    waitTimedOut,
    matched,
    markDelivered: true,
    screen,
    ...(observation
      ? { screenVersion: observation.screenVersion, settled: observation.settled }
      : {}),
    receipt,
    termination,
    raw: input.raw,
    compact: input.compact,
  });
  applyControlErrors(result, effects);
  return result;
}

export async function controlJob(
  session: JobSession,
  input: JobInput,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<Result> {
  const scope = session.current(ctx);
  const waitMs = Math.round(
    (input.waitSeconds ?? JOB_ACTIONS[input.action].waitSeconds) * 1000,
  );
  const lines = input.lines ?? DEFAULT_LINES;
  validateLogPattern(input.pattern);
  const settling = controlSettling(input, waitMs);
  signal?.throwIfAborted();
  if (input.step !== undefined && !WORKFLOW_STEP_ACTIONS.has(input.action))
    throw new Error("step is supported only for workflow status, logs or cancel");
  if (input.action === "list") return listJobs(session, scope, signal);
  if (!input.job) throw new Error(`${input.action} requires job`);
  const name = input.job;
  const record = scope.branch.get(name);
  if (!record)
    throw new Error(
      `Job ${name} is not managed by this remote owner on the current branch`,
    );
  if (input.step !== undefined && !record.workflowFingerprint)
    throw new Error("step requires a workflow job");
  let client = await session.forRecord(scope, record);
  if (input.action === "receipt") return recoverReceipt(client, record, input, signal);
  const finish = session.begin(scope, name);
  try {
    const { job, snapshot } = await session.inspect(scope, client, record, signal);
    const act = async (
      actionId: string,
      data?: string,
      resize?: { columns: number; rows: number },
      expectedScreenVersion?: string,
    ) => {
      try {
        return await client.action(
          {
            name,
            nativeId: job.nativeId,
            actionId,
            ...(data !== undefined ? { data } : {}),
            ...(resize ? { resize } : {}),
            ...(expectedScreenVersion !== undefined ? { expectedScreenVersion } : {}),
            ...settling,
          },
          signal,
        );
      } catch {
        // Receipt lookup is safe after transport loss; input is never replayed
        try {
          client = await session.forRecord(scope, job);
          return await client.receipt({ name, nativeId: job.nativeId, actionId });
        } catch {
          return {
            actionId,
            name,
            nativeId: job.nativeId,
            state: "sent-outcome-unknown" as const,
            createdAt: Date.now(),
            error:
              "Transport lost; delivery is unknown. Reconnect and recover this actionId before deciding whether to send a new action",
          };
        }
      }
    };
    const context: ControlContext = {
      session,
      scope,
      input,
      ctx,
      signal,
      job,
      snapshot,
      get client() {
        return client;
      },
      name,
      settling,
      waitMs,
      act,
    };
    const effects = await ACTION_HANDLERS[input.action](context);
    return await renderControlResult(context, effects, lines);
  } finally {
    finish();
  }
}

async function receiptObservation(
  context: ControlContext,
  client: Gateway,
  receipt: NonNullable<ControlEffects["receipt"]>,
): Promise<JobObservation | undefined> {
  const { session, scope, job, signal } = context;
  let observation: JobObservation | undefined;
  if (receipt.logs && receipt.snapshot && receipt.screenVersion !== undefined) {
    const unread = await session.logs(
      scope,
      client,
      job,
      receipt.snapshot,
      {
        screenLogs: receipt.logs,
      },
      signal,
    );
    observation = {
      ...unread,
      screenVersion: receipt.screenVersion,
      settled: receipt.settled ?? false,
      observedAt: receipt.observedAt ?? Date.now(),
    };
  }
  return observation;
}

function unknownReceiptResult(
  context: ControlContext,
  effects: ControlEffects,
  snapshot: ControlContext["snapshot"],
  receipt: NonNullable<ControlEffects["receipt"]>,
): Result {
  const { session, scope, job, name } = context;
  const { notice, sequence } = effects;
  const safeReceipt = publicReceipt(receipt);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          job: name,
          state: snapshot.state,
          exitCode: snapshot.exitCode ?? null,
          newOutput: "",
          cursor: session.delivery(scope, job).outputCursor ?? 0,
          receipt: safeReceipt,
          notice: safeReceipt.error ?? notice,
          ...(sequence ? { sequence } : {}),
        }),
      },
    ],
    details: {
      job: name,
      connectionId: job.connectionId,
      receipt: safeReceipt,
      remoteState: "unknown",
      ...(sequence ? { sequence } : {}),
    },
    isError: true,
  };
}

function controlScreen(
  job: ControlContext["job"],
  input: JobInput,
  snapshot: ControlContext["snapshot"],
): boolean {
  return job.pty && !input.raw && !terminal(snapshot.state) && input.action !== "logs";
}

async function controlUnread(
  context: ControlContext,
  client: Gateway,
  snapshot: ControlContext["snapshot"],
  screen: boolean,
  lines: number,
) {
  const { session, scope, job, input, signal, waitMs } = context;
  const unread =
    !screen || input.raw
      ? await session.logs(
          scope,
          client,
          job,
          snapshot,
          {
            lines,
            cursor: input.cursor,
            follow: input.action === "logs" && waitMs > 0,
            timeoutMs: input.action === "logs" ? waitMs : 0,
          },
          signal,
        )
      : undefined;
  return unread;
}

function controlSettling(input: JobInput, waitMs: number) {
  const settling = {
    settleMs: input.settleMs,
    maxWaitMs:
      input.maxWaitMs ??
      (input.waitSeconds === undefined
        ? DEFAULT_SETTLING_WAIT_MS
        : Math.min(waitMs, MAX_SETTLING_WAIT_MS)),
  };
  return settling;
}

async function controlReceipt(
  context: ControlContext,
  effects: ControlEffects,
  client: Gateway,
  snapshot: ControlContext["snapshot"],
) {
  const { job } = context;
  const { receipt } = effects;
  let observation: JobObservation | undefined;
  let result: Result | undefined;
  if (receipt) {
    if (receipt.snapshot) {
      assertIdentity(job, receipt.snapshot);
      snapshot = receipt.snapshot;
    }
    observation = await receiptObservation(context, client, receipt);
    if (receipt.state !== "processed" && !observation) {
      result = unknownReceiptResult(context, effects, snapshot, receipt);
    }
  }
  return { snapshot, observation, result };
}

function applyControlErrors(
  result: Result,
  { sequence, receipt }: ControlEffects,
): void {
  if (sequence) {
    result.details = { ...result.details, sequence };
    result.isError ||= sequence.error !== undefined;
  }
  result.isError ||= receipt !== undefined && receipt.state !== "processed";
}
