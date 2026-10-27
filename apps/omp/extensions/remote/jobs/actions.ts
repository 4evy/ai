import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { toError } from "@oh-my-pi/pi-utils/type-guards";
import type { Gateway } from "farstep/client/jobs/gateway";
import { assertIdentity } from "farstep/client/jobs/recovery";
import {
  keyBytes,
  parseTerminalKeys,
  terminalSize,
} from "farstep/client/terminal/terminal";
import type { ActionReceipt, TerminationResult } from "farstep/protocol/jobs/gateway";
import type { JobSnapshot } from "farstep/protocol/jobs/protocol";
import { parseJobTerminalSize } from "farstep/protocol/jobs/protocol";
import { isJobTerminal as terminal } from "farstep/protocol/jobs/states";
import { DEFAULT_TERMINATION_WAIT_MS, MAX_TERMINATION_WAIT_MS } from "./limits/limits";
import { publicReceipt } from "./output";
import type { JobSession } from "./session";
import {
  type JobInput,
  type JobRecord,
  MAX_SEQUENCE_STEPS,
  type RemoteJobDetails,
  type Scope,
} from "./types";

type Settling = { settleMs: number | undefined; maxWaitMs: number };
const MAX_SEQUENCE_ACTION_ID_LENGTH = 100;
type SendAction = (
  actionId: string,
  data?: string,
  resize?: { columns: number; rows: number },
  expectedScreenVersion?: string,
) => Promise<ActionReceipt>;
export interface ControlContext {
  session: JobSession;
  scope: Scope;
  input: JobInput;
  ctx: ExtensionContext;
  signal: AbortSignal | undefined;
  job: JobRecord;
  snapshot: JobSnapshot;
  client: Gateway;
  name: string;
  settling: Settling;
  waitMs: number;
  act: SendAction;
}
export interface ControlEffects {
  client?: Gateway | undefined;
  snapshot?: JobSnapshot | undefined;
  notice?: string | undefined;
  waitTimedOut?: boolean | undefined;
  matched?: string | undefined;
  receipt?: ActionReceipt | undefined;
  termination?: TerminationResult["termination"] | undefined;
  sequence?: RemoteJobDetails["sequence"];
}

async function inputAction(context: ControlContext): Promise<ControlEffects> {
  const { input, job, act } = context;
  if (!job.pty) throw new Error(`${input.action} requires a managed remote PTY`);
  let data = input.data;
  if (input.action === "password" && data === undefined)
    data = await passwordData(context);
  if (input.action === "keys") data = await keyboardData(context);
  if (data === undefined) throw new Error(`${input.action} requires explicit data`);
  if (input.action === "reply" || input.action === "password") {
    if (/[\r\n\0]/u.test(data))
      throw new Error(`${input.action} data must not contain CR, LF, or NUL`);
    data = `${data}\r`;
  }
  const receipt = await act(
    input.actionId ?? randomUUID(),
    data,
    undefined,
    input.expectedScreenVersion,
  );
  return { receipt };
}

async function passwordData({
  input,
  ctx,
  signal,
  job,
}: ControlContext): Promise<string> {
  if (!ctx.hasUI) throw new Error("password requires data or an interactive UI");
  const data = await ctx.ui.input(
    input.prompt ?? `Password (${job.connectionId}; Esc cancels): `,
    undefined,
    signal ? { signal } : undefined,
  );
  signal?.throwIfAborted();
  if (data === undefined) throw new Error("Password prompt cancelled");
  return data;
}

async function keyboardData({
  input,
  signal,
  job,
  client,
  name,
}: ControlContext): Promise<string> {
  const keys = parseTerminalKeys(input.keys);
  const before = await client.observe(
    { name, nativeId: job.nativeId, settleMs: 0, maxWaitMs: 0 },
    signal,
  );
  assertIdentity(job, before.snapshot);
  return keyBytes(keys, before.logs.terminalText);
}

async function sequenceAction(context: ControlContext): Promise<ControlEffects> {
  const { input, signal, job, name, settling, act } = context;
  let receipt: ActionReceipt | undefined;
  if (!job.pty) throw new Error("sequence requires a managed remote PTY");
  const steps = sequenceSteps(input);
  const actionId = input.actionId ?? randomUUID();
  if (actionId.length > MAX_SEQUENCE_ACTION_ID_LENGTH)
    throw new Error(
      `Sequence actionId must be at most ${MAX_SEQUENCE_ACTION_ID_LENGTH} characters`,
    );
  let expectedVersion = input.expectedScreenVersion;
  const sequence: NonNullable<RemoteJobDetails["sequence"]> = {
    actionId,
    receipts: [],
    completedSteps: 0,
  };
  async function sendStep(index: number, step: SequenceStep): Promise<boolean> {
    signal?.throwIfAborted();
    const before = await context.client.observe(
      { name, nativeId: job.nativeId, ...settling },
      signal,
    );
    assertIdentity(job, before.snapshot);
    if (!sequenceScreenMatches(index, steps, before)) {
      sequence.error = `Screen changed before step ${index + 1}; subsequent keys were not sent`;
      return false;
    }
    let data: string;
    try {
      data = keyBytes(step.keys, before.logs.terminalText);
    } catch (error) {
      sequence.error = `Cannot encode step ${index + 1}: ${toError(error).message}; subsequent keys were not sent`;
      return false;
    }
    receipt = await act(
      `${actionId}:${index}`,
      data,
      undefined,
      step.screenVersion ?? expectedVersion ?? before.screenVersion,
    );
    sequence.receipts.push(publicReceipt(receipt));
    const error = sequenceReceiptError(job, receipt, step, index);
    if (error) {
      sequence.error = error;
      return false;
    }
    sequence.completedSteps++;
    expectedVersion = receipt.screenVersion;
    if (!receipt.settled && index + 1 < steps.length) {
      sequence.error = `Screen is still changing after step ${index + 1}; subsequent keys were not sent`;
      return false;
    }
    return true;
  }
  for (const [index, step] of steps.entries()) {
    if (!(await sendStep(index, step))) break;
  }
  const notice = sequence.error ?? `Completed ${sequence.completedSteps} checked steps`;
  return { notice, receipt, sequence };
}

async function terminateAction(context: ControlContext): Promise<ControlEffects> {
  const {
    session,
    scope,
    input,
    signal,
    job,
    name,
    waitMs,
    client: initialClient,
  } = context;
  let receipt: ActionReceipt | undefined;
  let termination: TerminationResult["termination"] | undefined;
  let client = initialClient;
  const actionId = input.actionId ?? randomUUID();
  try {
    const stopped = await client.terminate(
      {
        name,
        nativeId: job.nativeId,
        actionId,
        kind: input.action === "force" ? "force" : "interrupt",
        timeoutMs: Math.min(
          waitMs || DEFAULT_TERMINATION_WAIT_MS,
          MAX_TERMINATION_WAIT_MS,
        ),
      },
      signal,
    );
    receipt = stopped.receipt;
    termination = stopped.termination;
  } catch {
    try {
      client = await session.forRecord(scope, job);
      receipt = await client.receipt({ name, nativeId: job.nativeId, actionId });
    } catch {
      receipt = {
        name,
        nativeId: job.nativeId,
        actionId,
        state: "sent-outcome-unknown",
        createdAt: Date.now(),
        error: "Termination delivery is unknown; recover this receipt before retrying",
      };
    }
  }
  const notice =
    input.action === "force" ? "Requested forced stop" : "Requested interruption";
  return { notice, receipt, termination, client };
}

async function stopAction({
  session,
  scope,
  job,
  client,
  snapshot,
}: ControlContext): Promise<ControlEffects> {
  return session.stop(scope, client, job, snapshot);
}

async function modeAction(context: ControlContext): Promise<ControlEffects> {
  const { input, signal, job, client, name } = context;
  if (input.lifetime !== "session" && input.lifetime !== "persist")
    throw new Error("mode requires lifetime session or persist");
  const changed = await client.request(
    { op: "mode", name, mode: input.lifetime },
    signal,
  );
  assertIdentity(job, changed.snapshot);
  const snapshot = changed.snapshot;
  const notice = `Lifetime: ${input.lifetime}`;
  return { notice, snapshot };
}

async function waitAction(context: ControlContext): Promise<ControlEffects> {
  const { input, signal, job, client, name, waitMs } = context;
  let notice: string | undefined;
  const waited = await client.request(
    {
      op: "wait",
      name,
      for: "exit",
      timeoutMs: waitMs,
      ...(input.pattern !== undefined ? { pattern: input.pattern } : {}),
    },
    signal,
  );
  assertIdentity(job, waited.snapshot);
  const snapshot = waited.snapshot;
  const waitTimedOut = waited.timedOut;
  const matched = waited.matched;
  if (input.pattern && matched === undefined && terminal(snapshot.state))
    notice = "The remote process finished without observing the requested log pattern";
  return { notice, waitTimedOut, matched, snapshot };
}

async function resizeAction(context: ControlContext): Promise<ControlEffects> {
  const { input, job, snapshot, act } = context;
  if (!job.pty) throw new Error("resize requires a managed remote PTY");
  if (input.columns === undefined && input.rows === undefined)
    throw new Error("resize requires columns or rows");
  const size = terminalSize(snapshot);
  const receipt = await act(
    input.actionId ?? randomUUID(),
    undefined,
    parseJobTerminalSize({
      columns: input.columns ?? size.columns,
      rows: input.rows ?? size.rows,
    }),
    input.expectedScreenVersion,
  );
  const notice = "Requested terminal resize";
  return { notice, receipt };
}

async function screenAction({ job }: ControlContext): Promise<ControlEffects> {
  if (!job.pty) throw new Error("screen requires a managed remote PTY");
  return {};
}

async function inspectAction(): Promise<ControlEffects> {
  return {};
}

async function cancelAction({
  client,
  job,
  input,
  signal,
}: ControlContext): Promise<ControlEffects> {
  if (!job.workflowFingerprint)
    throw new Error("cancel requires a workflow job; ordinary jobs use stop");
  await client.cancelWorkflow(job.name, input.step, signal);
  return {
    notice: input.step
      ? `Requested cancellation of step ${input.step}`
      : "Requested cancellation of the workflow",
  };
}

export const ACTION_HANDLERS = {
  input: inputAction,
  reply: inputAction,
  password: inputAction,
  keys: inputAction,
  sequence: sequenceAction,
  interrupt: terminateAction,
  force: terminateAction,
  stop: stopAction,
  mode: modeAction,
  wait: waitAction,
  resize: resizeAction,
  screen: screenAction,
  status: inspectAction,
  logs: inspectAction,
  cancel: cancelAction,
} satisfies Record<
  Exclude<JobInput["action"], "list" | "receipt">,
  (context: ControlContext) => Promise<ControlEffects>
>;

function sequenceSteps(input: JobInput) {
  if (!input.steps?.length || input.steps.length > MAX_SEQUENCE_STEPS)
    throw new Error(`sequence requires 1–${MAX_SEQUENCE_STEPS} checked steps`);
  const steps = input.steps.map((step) => {
    if (!step.expect) throw new Error("Each sequence step requires expect");
    return {
      keys: parseTerminalKeys(step.keys),
      check: new RegExp(step.expect, "u"),
      screenVersion: step.screenVersion,
    };
  });
  return steps;
}
type SequenceStep = ReturnType<typeof sequenceSteps>[number];

function sequenceScreenMatches(
  index: number,
  steps: SequenceStep[],
  before: Awaited<ReturnType<Gateway["observe"]>>,
): boolean {
  return (
    index === 0 ||
    (before.settled &&
      Boolean(
        steps[index - 1]?.check.test(
          (before.logs.terminalRows ?? []).map((row) => Bun.stripANSI(row)).join("\n"),
        ),
      ))
  );
}

function sequenceReceiptError(
  job: JobRecord,
  receipt: ActionReceipt,
  step: SequenceStep,
  index: number,
): string | undefined {
  if (receipt.state !== "processed" || !receipt.logs || !receipt.snapshot) {
    return `Step ${index + 1} was not observed as processed; subsequent keys were not sent`;
  }
  assertIdentity(job, receipt.snapshot);
  const screen = (receipt.logs.terminalRows ?? [])
    .map((row) => Bun.stripANSI(row))
    .join("\n");
  if (!step.check.test(screen)) {
    return `Screen check failed after step ${index + 1}; subsequent keys were not sent`;
  }
  return undefined;
}
