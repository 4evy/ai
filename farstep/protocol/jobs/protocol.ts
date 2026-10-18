import * as v from "valibot";
import { terminalSizeSchema } from "./jobs";

export const JOB_PTY_COLUMNS = 120;
export const JOB_PTY_ROWS = 40;
export const JOB_OUTPUT_MAX_BYTES = 256 * 1024;

const text = v.pipe(v.string(), v.minLength(1));
const offset = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const timeout = v.pipe(offset, v.maxValue(3_600_000));
const name = v.pipe(text, v.maxLength(256), v.regex(/^[A-Za-z0-9._-]+$/u));
const state = v.picklist([
  "starting",
  "running",
  "ready",
  "stopping",
  "exited",
  "failed",
  "unknown",
]);
const ready = v.pipe(
  v.strictObject({
    log: v.optional(text),
    port: v.optional(v.pipe(offset, v.minValue(1), v.maxValue(65535))),
    host: v.optional(text),
    timeoutMs: timeout,
  }),
  v.check((value) => value.log !== undefined || value.port !== undefined),
);

export const jobSpecSchema = v.pipe(
  v.strictObject({
    name,
    application: text,
    args: v.array(v.string()),
    env: v.record(v.string(), v.string()),
    cwd: text,
    pty: v.boolean(),
    terminalSize: v.optional(terminalSizeSchema),
    ready: v.optional(ready),
    persist: v.boolean(),
  }),
  v.check((value) => !value.terminalSize || value.pty),
);
export type JobSpec = v.InferOutput<typeof jobSpecSchema>;

export const jobSnapshotSchema = v.strictObject({
  name,
  id: text,
  state,
  pid: v.optional(offset),
  createdAt: offset,
  startedAt: offset,
  readyAt: v.optional(offset),
  exitedAt: v.optional(offset),
  exitCode: v.optional(v.pipe(v.number(), v.safeInteger())),
  exitReason: v.optional(text),
  outputBytes: offset,
  owner: v.optional(text),
  readyMatch: v.optional(v.string()),
  readyPending: v.optional(v.array(v.picklist(["log", "port"]))),
  persist: v.boolean(),
  terminalSize: v.optional(terminalSizeSchema),
});
export type JobSnapshot = v.InferOutput<typeof jobSnapshotSchema>;
export type JobState = JobSnapshot["state"];
export type JobTerminalSize = v.InferOutput<typeof terminalSizeSchema>;

const terminalEvent = v.strictObject({
  offset,
  terminalSize: terminalSizeSchema,
  reset: v.optional(v.boolean()),
});
export const jobTerminalEventsSchema = v.pipe(
  v.array(terminalEvent),
  v.check((events) =>
    events.every((event, i) => !i || event.offset >= (events[i - 1]?.offset ?? 0)),
  ),
);
const terminalReplay = v.strictObject({
  terminalSize: terminalSizeSchema,
  events: jobTerminalEventsSchema,
});
export type JobTerminalEvent = v.InferOutput<typeof terminalEvent>;
export type JobTerminalReplay = v.InferOutput<typeof terminalReplay>;

export const jobOperationSchema = v.variant("op", [
  v.strictObject({ op: v.literal("ping") }),
  v.strictObject({ op: v.literal("list") }),
  v.strictObject({
    op: v.literal("start"),
    spec: jobSpecSchema,
    owner: v.optional(text),
  }),
  v.strictObject({
    op: v.literal("logs"),
    name,
    lines: v.pipe(offset, v.maxValue(10000)),
    head: v.boolean(),
    grep: v.optional(text),
    follow: v.boolean(),
    cursor: v.optional(offset),
    renderTerminalRows: v.optional(v.boolean()),
    timeoutMs: timeout,
  }),
  v.strictObject({
    op: v.literal("output"),
    name,
    cursor: offset,
    follow: v.boolean(),
    timeoutMs: timeout,
  }),
  v.strictObject({
    op: v.literal("wait"),
    name,
    for: v.picklist(["ready", "exit"]),
    pattern: v.optional(text),
    timeoutMs: timeout,
  }),
  v.strictObject({
    op: v.literal("send"),
    name,
    data: v.optional(text),
    signal: v.optional(
      v.picklist(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGKILL"]),
    ),
    resize: v.optional(terminalSizeSchema),
  }),
  v.strictObject({
    op: v.literal("stop"),
    name,
    timeoutMs: timeout,
    id: v.optional(text),
  }),
  v.strictObject({ op: v.literal("describe"), name }),
  v.strictObject({
    op: v.literal("mode"),
    name,
    mode: v.picklist(["persist", "session"]),
  }),
]);
export type JobOperation = v.InferOutput<typeof jobOperationSchema>;

const jobWireRequestSchema = v.strictObject({
  id: text,
  token: text,
  owners: v.optional(v.array(text)),
  detachedOwners: v.optional(v.array(text)),
  completionEvents: v.optional(v.boolean()),
  completionAcks: v.optional(v.array(text)),
  completionUnsubscribes: v.optional(v.array(text)),
  completionReplays: v.optional(v.array(text)),
  completionSubscriptionId: v.optional(text),
  operation: jobOperationSchema,
});
export type JobWireRequest = v.InferOutput<typeof jobWireRequestSchema>;

const completionSchema = v.strictObject({
  event: v.literal("job-completed"),
  completionId: text,
  owner: text,
  snapshot: jobSnapshotSchema,
});
export type JobCompletionNotification = v.InferOutput<typeof completionSchema>;
const responseSchema = v.variant("ok", [
  v.strictObject({ id: text, ok: v.literal(true), result: v.unknown() }),
  v.strictObject({ id: text, ok: v.literal(false), error: text }),
]);
export type JobWireMessage =
  | v.InferOutput<typeof responseSchema>
  | JobCompletionNotification;

const outputShape = {
  name,
  data: v.pipe(
    v.string(),
    v.maxLength(Math.ceil(JOB_OUTPUT_MAX_BYTES / 3) * 4),
    v.regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
  ),
  startCursor: offset,
  cursor: offset,
  availableStart: offset,
  availableEnd: offset,
  timedOut: v.boolean(),
  state,
};
const resultSchemas = {
  ping: v.object({ op: v.literal("ping"), projectDir: text }),
  start: v.object({
    op: v.literal("start"),
    snapshot: jobSnapshotSchema,
    readyTimedOut: v.boolean(),
  }),
  list: v.object({
    op: v.literal("list"),
    snapshots: v.array(jobSnapshotSchema),
  }),
  logs: v.object({
    op: v.literal("logs"),
    name,
    text: v.optional(v.string(), ""),
    terminalRows: v.optional(v.array(v.string())),
    terminalText: v.optional(v.string()),
    terminalSize: v.optional(terminalSizeSchema),
    terminalReplay: v.optional(terminalReplay),
    cursor: offset,
    timedOut: v.boolean(),
    state,
  }),
  output: v.object({ op: v.literal("output"), ...outputShape }),
  wait: v.object({
    op: v.literal("wait"),
    snapshot: jobSnapshotSchema,
    matched: v.optional(v.string()),
    timedOut: v.boolean(),
  }),
  send: v.object({ op: v.literal("send"), snapshot: jobSnapshotSchema }),
  stop: v.object({ op: v.literal("stop"), snapshot: jobSnapshotSchema }),
  mode: v.object({ op: v.literal("mode"), snapshot: jobSnapshotSchema }),
  describe: v.object({
    op: v.literal("describe"),
    snapshot: jobSnapshotSchema,
    spec: jobSpecSchema,
  }),
} satisfies {
  [Op in JobOperation["op"]]: v.GenericSchema<unknown, { op: Op }>;
};
export type JobRpcResult<Op extends JobOperation["op"] = JobOperation["op"]> =
  v.InferOutput<(typeof resultSchemas)[Op]>;

export function parseJobSpec(value: unknown): JobSpec {
  return v.parse(jobSpecSchema, value);
}
export function parseJobSnapshot(value: unknown): JobSnapshot {
  return v.parse(jobSnapshotSchema, value);
}
export function parseJobTerminalSize(value: unknown): JobTerminalSize {
  return v.parse(terminalSizeSchema, value);
}
export function parseJobWireRequest(value: unknown): JobWireRequest {
  return v.parse(jobWireRequestSchema, value);
}
export function parseJobWireMessage(value: unknown): JobWireMessage {
  return v.parse(v.union([completionSchema, responseSchema]), value);
}
export function parseJobRpcResult<Op extends JobOperation["op"]>(
  operation: JobOperation & { op: Op },
  value: unknown,
): JobRpcResult<Op> {
  const raw = v.parse(v.record(v.string(), v.unknown()), value);
  const result = v.parse(resultSchemas[operation.op], { ...raw, op: operation.op });
  const requested: JobOperation = operation;
  if (requested.op === "output" && result.op === "output") {
    if (
      result.availableStart > result.availableEnd ||
      result.startCursor !== Math.max(requested.cursor, result.availableStart) ||
      result.startCursor > result.cursor ||
      result.cursor > result.availableEnd ||
      result.cursor - result.startCursor > JOB_OUTPUT_MAX_BYTES ||
      Buffer.byteLength(result.data, "base64") !== result.cursor - result.startCursor
    )
      throw new Error("Invalid bounded incremental output range");
  }
  return result;
}
