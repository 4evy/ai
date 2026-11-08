import { sanitizeText } from "@oh-my-pi/pi-utils";
import * as Records from "effect/Record";
import { terminalSize } from "farstep/client/terminal/terminal";
import type {
  JobReceipt,
  TerminationResult,
  TerminationStatus,
} from "farstep/protocol/jobs/gateway";
import type { JobSnapshot } from "farstep/protocol/jobs/protocol";
import { isJobTerminal as terminal } from "farstep/protocol/jobs/states";
import type { WorkflowResult } from "farstep/protocol/workflow/workflow";
import { workflowFailed, workflowText } from "./output/workflow";
import { jobNotices } from "./presentation";
import type { JobRecord, Logs, Result } from "./types";

export interface JobResultOptions {
  notice?: string | undefined;
  readyTimedOut?: boolean | undefined;
  waitTimedOut?: boolean | undefined;
  matched?: string | undefined;
  markDelivered?: boolean | undefined;
  consume?: boolean | undefined;
  screen?: boolean | undefined;
  screenVersion?: string | undefined;
  settled?: boolean | undefined;
  receipt?: JobReceipt | undefined;
  raw?: boolean | undefined;
  compact?: boolean | undefined;
  styles?: boolean | undefined;
  finishedAt?: number | undefined;
  deliveredAt?: number | undefined;
  observedAt?: number | undefined;
  completionId?: string | undefined;
  termination?: TerminationResult["termination"] | undefined;
  terminationStatus?: TerminationStatus | undefined;
  unreadCursor?: number | undefined;
  terminalRedraw?: boolean | undefined;
}

const redrawPattern =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: VT escape sequences identify terminal redraws
  /\u001b\[(?:\?(?:1049|1047|47)[hl]|[\d;]*[ABCDEFGHJKSTf])|\r(?!\n)/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: VT escape sequences leave the alternate screen
const leaveScreenPattern = /\u001b\[\?(?:1049|1047|47)l/gu;

export function hasTerminalRedraw(text: string): boolean {
  return redrawPattern.test(text);
}

export function publicReceipt(
  receipt: JobReceipt,
): Omit<JobReceipt, "snapshot" | "logs"> {
  return {
    name: receipt.name,
    nativeId: receipt.nativeId,
    actionId: receipt.actionId,
    state: receipt.state,
    createdAt: receipt.createdAt,
    ...(receipt.sentAt !== undefined ? { sentAt: receipt.sentAt } : {}),
    ...(receipt.observedAt !== undefined ? { observedAt: receipt.observedAt } : {}),
    ...(receipt.screenVersion !== undefined
      ? { screenVersion: receipt.screenVersion }
      : {}),
    ...(receipt.screenChanged !== undefined
      ? { screenChanged: receipt.screenChanged }
      : {}),
    ...(receipt.settled !== undefined ? { settled: receipt.settled } : {}),
    ...(receipt.error !== undefined ? { error: sanitizeText(receipt.error) } : {}),
  };
}

function compactOutput(logs: Logs, redrawing: boolean): string {
  if (!redrawing) return logs.text;
  const raw = logs.rawText ?? logs.text;
  let restored = -1;
  for (const match of raw.matchAll(leaveScreenPattern))
    restored = match.index + match[0].length;
  if (restored >= 0)
    return (logs.outputGap ?? "") + sanitizeText(raw.slice(restored)).trim();
  if (!hasTerminalRedraw(raw)) return logs.text;
  return logs.outputGap ?? "";
}

function optionalFields<T extends object>(
  fields: T,
): {
  [Key in keyof T]?: Exclude<T[Key], undefined>;
} {
  return Records.filter(fields, (value) => value !== undefined) as {
    [Key in keyof T]?: Exclude<T[Key], undefined>;
  };
}

function screenVisible(
  snapshot: JobSnapshot,
  options: JobResultOptions,
  compact: boolean,
  redrawing: boolean,
): boolean {
  return Boolean(
    options.screen ||
      (!terminal(snapshot.state) && compact && redrawing && !options.raw),
  );
}

function outputView(snapshot: JobSnapshot, logs: Logs, options: JobResultOptions) {
  const compact = options.compact ?? true;
  const redrawing =
    options.terminalRedraw ?? hasTerminalRedraw(logs.rawText ?? logs.text);
  const showScreen = screenVisible(snapshot, options, compact, redrawing);
  const styledRows = logs.terminalStyleRows ?? logs.terminalRows;
  const terminalRows = showScreen
    ? styledRows?.map((row) => Bun.stripANSI(row))
    : undefined;
  const terminalStyleRows = showScreen ? styledRows : undefined;
  const newOutput =
    compact && !options.raw ? compactOutput(logs, redrawing) : logs.text;
  const output = renderedOutput(
    showScreen,
    terminalRows,
    terminalStyleRows,
    newOutput,
    logs,
    options,
  );
  return { compact, showScreen, newOutput, output, terminalRows, terminalStyleRows };
}

function renderedOutput(
  showScreen: boolean,
  terminalRows: string[] | undefined,
  terminalStyleRows: string[] | undefined,
  newOutput: string,
  logs: Logs,
  options: JobResultOptions,
): string | undefined {
  if (showScreen)
    return (options.styles === false ? terminalRows : terminalStyleRows)?.join("\n");
  if (options.raw) return (logs.rawText ?? logs.text).replaceAll("\u001b", "\\x1b");
  return newOutput;
}

function jobContext(snapshot: JobSnapshot, logs: Logs, options: JobResultOptions) {
  const terminationStatus = options.terminationStatus ?? logs.terminationStatus;
  const size = terminalSize(snapshot);
  const view = outputView(snapshot, logs, options);
  const finishedAt = options.finishedAt ?? snapshot.exitedAt;
  const termination = options.termination ?? terminationStatus?.termination;
  const deadline = terminationStatus?.deadline;
  const receipt = options.receipt ? publicReceipt(options.receipt) : undefined;
  return {
    finished: terminal(snapshot.state),
    size,
    view,
    finishedAt,
    termination,
    deadline,
    receipt,
    workflow: logs.workflow,
    notices: jobNotices(
      size,
      view.showScreen,
      finishedAt,
      receipt,
      termination,
      deadline,
      options,
    ).filter((notice) => !notice.startsWith("Receipt (")),
  };
}
type JobContext = ReturnType<typeof jobContext>;

function jobHeader(
  code: number | undefined,
  job: JobRecord,
  snapshot: JobSnapshot,
  logs: Logs,
  options: JobResultOptions,
  context: JobContext,
): string {
  const unreadCursor = options.unreadCursor ?? logs.cursor;
  const readiness =
    context.workflow?.kind === "job" ? context.workflow.steps[0]?.readiness : undefined;
  const requiresReadiness = job.ready !== undefined;
  const ready = requiresReadiness
    ? readiness?.state === "ready"
    : snapshot.state === "ready";
  return JSON.stringify({
    job: {
      name: job.name,
      connectionId: job.connectionId,
      cwd: job.cwd,
      owner: job.owner,
      nativeId: job.nativeId,
      installationId: job.installationId,
      scopeId: job.scopeId,
      interpreter: job.interpreter ?? job.spec.application,
      lifetime: snapshot.persist ? "persist" : "session",
      pty: job.pty,
      timeoutSeconds: job.timeoutSeconds,
      state: snapshot.state,
      lifecycle:
        snapshot.state === "unknown"
          ? "unknown"
          : context.finished
            ? "terminal"
            : ready
              ? "ready"
              : "running",
      exitCode: code,
      exitReason: snapshot.exitReason,
      pid: snapshot.pid,
      startedAt: snapshot.startedAt,
      finishedAt: context.finishedAt,
    },
    observation: {
      waitTimedOut: options.waitTimedOut,
      readyTimedOut: options.readyTimedOut,
      outputTimedOut: logs.timedOut || undefined,
      matched: options.matched,
      observedAt: options.observedAt,
      deliveredAt: options.deliveredAt,
      completionId: options.completionId,
    },
    readiness: {
      required: requiresReadiness,
      state: readiness?.state ?? (requiresReadiness ? "not-observed" : undefined),
      readyAt: requiresReadiness
        ? readiness?.state === "ready"
          ? readiness.observedAt
          : undefined
        : snapshot.readyAt,
      pending: requiresReadiness ? undefined : snapshot.readyPending,
      match: requiresReadiness ? undefined : snapshot.readyMatch,
    },
    output: {
      cursor: logs.cursor,
      unreadCursor,
      ...logs.outputRange,
      state:
        snapshot.state === "unknown"
          ? "unknown"
          : logs.outputGap || unreadCursor < snapshot.outputBytes
            ? "incomplete"
            : context.finished
              ? "complete"
              : "streaming",
      replay: logs.replay || undefined,
      view: context.view.showScreen ? "screen" : options.raw ? "raw" : "text",
      gap: logs.outputGap,
      screenVersion: options.screenVersion,
      settled: options.settled,
    },
    receipt: context.receipt
      ? { ...context.receipt, applicationAcknowledgement: "not-established" }
      : undefined,
    termination: context.termination,
    deadline: context.deadline,
    notice: options.notice,
  });
}

function displayedOutput(view: JobContext["view"]): string | undefined {
  if (view.showScreen)
    return view.terminalRows?.some((row) => row.trim().length > 0)
      ? view.output
      : "(empty screen)";
  return view.output || undefined;
}

function jobText(
  code: number | undefined,
  job: JobRecord,
  snapshot: JobSnapshot,
  logs: Logs,
  options: JobResultOptions,
  context: JobContext,
): string {
  const workflow = context.workflow;
  return [
    jobHeader(code, job, snapshot, logs, options, context),
    ...(workflow ? [workflowText(workflow)] : []),
    ...(job.pty || options.raw || !workflow?.steps.some((step) => step.output)
      ? [displayedOutput(context.view)]
      : []),
  ].join("\n");
}

function outputDetails(
  job: JobRecord,
  logs: Logs,
  options: JobResultOptions,
  context: JobContext,
) {
  return optionalFields({
    rawOutput: options.raw ? (logs.rawText ?? logs.text) : undefined,
    replay: logs.replay ? true : undefined,
    termination: context.termination,
    deadline: context.deadline,
    terminalColumns: job.pty ? context.size.columns : undefined,
    terminalHeight: job.pty ? context.size.rows : undefined,
    terminalRows: context.view.terminalRows,
    terminalStyleRows: context.view.terminalStyleRows,
    screenVersion: options.screenVersion,
    settled: options.settled,
    receipt: context.receipt,
  });
}

function timingDetails(
  code: number | undefined,
  options: JobResultOptions,
  finishedAt: number | undefined,
) {
  return optionalFields({
    finishedAt,
    deliveredAt: options.deliveredAt,
    deliveryDelayMs:
      finishedAt !== undefined && options.deliveredAt !== undefined
        ? Math.max(0, options.deliveredAt - finishedAt)
        : undefined,
    observedAt: options.observedAt,
    completionId: options.completionId,
    remoteExitCode: code,
    exitCode: code,
    waitTimedOut: options.waitTimedOut,
    matched: options.matched,
  });
}

function serviceReady(
  job: JobRecord,
  snapshot: JobSnapshot,
  workflow: WorkflowResult | undefined,
): boolean {
  if (job.ready && workflow?.kind === "job")
    return workflow.steps[0]?.readiness?.state === "ready";
  return (
    snapshot.readyAt !== undefined ||
    snapshot.state === "ready" ||
    (!job.ready && snapshot.state === "running")
  );
}

function serviceDetails(
  job: JobRecord,
  snapshot: JobSnapshot,
  options: JobResultOptions,
  workflow: WorkflowResult | undefined,
) {
  return {
    name: job.name,
    state: snapshot.state,
    ready: serviceReady(job, snapshot, workflow),
    timedOut:
      options.readyTimedOut === true ||
      workflow?.steps.some((step) => step.readiness?.state === "timed_out") === true,
    ...optionalFields({ pid: snapshot.pid }),
  };
}

function jobDetails(
  code: number | undefined,
  job: JobRecord,
  snapshot: JobSnapshot,
  logs: Logs,
  options: JobResultOptions,
  context: JobContext,
): NonNullable<Result["details"]> {
  return {
    job: job.name,
    connectionId: job.connectionId,
    cwd: job.cwd,
    owner: job.owner,
    nativeId: job.nativeId,
    installationId: job.installationId,
    scopeId: job.scopeId,
    cursor: logs.cursor,
    unreadCursor: options.unreadCursor ?? logs.cursor,
    newOutput: context.view.newOutput,
    compact: context.view.compact,
    ...(context.workflow ? { workflow: context.workflow } : {}),
    notices: context.notices,
    interpreter: job.interpreter ?? job.spec.application,
    ...outputDetails(job, logs, options, context),
    ...timingDetails(code, options, context.finishedAt),
    remoteState:
      code !== undefined ? "completed" : context.finished ? "unknown" : "running",
    state: snapshot.state,
    lifetime: snapshot.persist ? "persist" : "session",
    timeoutSeconds: job.timeoutSeconds,
    timeoutDisabled: job.timeoutSeconds === 0,
    wallTimeMs: Math.max(0, (snapshot.exitedAt ?? Date.now()) - job.startedAt),
    service: serviceDetails(job, snapshot, options, context.workflow),
  };
}

export function jobResult(
  code: number | undefined,
  job: JobRecord,
  snapshot: JobSnapshot,
  logs: Logs,
  options: JobResultOptions = {},
): Result {
  const context = jobContext(snapshot, logs, options);
  return {
    content: [
      { type: "text", text: jobText(code, job, snapshot, logs, options, context) },
    ],
    details: jobDetails(code, job, snapshot, logs, options, context),
    isError:
      (code !== undefined ? code !== 0 : context.finished) ||
      workflowFailed(context.workflow),
  };
}
