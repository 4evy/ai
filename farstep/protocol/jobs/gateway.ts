import { readText } from "@ai/toolkit/text/text";
import { objectSchema, recordSchema } from "@ai/values/schema/input";
import { objectInputSchema } from "farstep/protocol/identity";
import type { JobRpcResult } from "farstep/protocol/jobs/protocol";
import { jobSnapshotSchema, parseJobRpcResult } from "farstep/protocol/jobs/protocol";
import * as v from "valibot";

export const JOB_CAPABILITIES = [
  "jobs",
  "job-snapshots",
  "terminal-size",
  "terminal-replay",
  "completion-ack",
  "raw-output",
  "job-actions",
  "settled-screen",
  "styled-screen",
  "job-environment",
  "job-termination",
  "job-deadlines",
  "typescript-scripts-v1",
] as const;
export const scriptRunnerSchema = v.strictObject({
  application: v.pipe(v.string(), v.startsWith("/")),
  script: v.pipe(v.string(), v.startsWith("/")),
});
export type ScriptRunner = v.InferOutput<typeof scriptRunnerSchema>;

export const JOB_COMPLETION_METHOD = "notifications/farstep/job-completion";

export { jobSpecSchema } from "farstep/protocol/jobs/protocol";

const stylesSchema = v.pipe(
  objectInputSchema,
  v.object({ terminalStyleRows: v.optional(v.array(v.string())) }),
);

const boundedString = v.pipe(v.string(), v.maxLength(32768), v.excludes("\0"));
export const jobEnvironmentKey =
  /^(?:TERM|COLORTERM|LANG|LANGUAGE|LC_[A-Z_]+|TZ|PATH|TMPDIR|XDG_(?:CONFIG_HOME|DATA_HOME|STATE_HOME|CACHE_HOME|CONFIG_DIRS|DATA_DIRS))$/u;
const environmentKeySchema = v.pipe(v.string(), v.regex(jobEnvironmentKey));
export const jobEnvironmentSchema = v.pipe(
  recordSchema(environmentKeySchema, boundedString),
  v.maxEntries(64, "At most 64 environment overrides are allowed"),
);
export { jobIdentitySchema, observeRequestSchema } from "farstep/protocol/jobs/jobs";

import {
  actionIdSchema,
  jobIdentitySchema,
  settlingShape,
  terminalSizeSchema,
} from "farstep/protocol/jobs/jobs";
export const actionRequestSchema = v.pipe(
  v.strictObject({
    ...jobIdentitySchema.entries,
    actionId: actionIdSchema,
    data: v.optional(v.pipe(v.string(), v.maxLength(262144))),
    resize: v.optional(terminalSizeSchema),
    expectedScreenVersion: v.optional(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u))),
    ...settlingShape,
  }),
  v.check(
    (value) => value.data !== undefined || value.resize !== undefined,
    "Action requires data or resize",
  ),
);
export const receiptRequestSchema = v.strictObject({
  ...jobIdentitySchema.entries,
  actionId: actionIdSchema,
});
export type JobLogs = JobRpcResult<"logs"> & {
  terminalStyleRows?: string[] | undefined;
};
const logsSchema = v.pipe(
  v.unknown(),
  v.transform((value): JobLogs => {
    const parsed = parseJobRpcResult(
      {
        op: "logs",
        name: "screen",
        lines: 1000,
        head: false,
        follow: false,
        timeoutMs: 0,
      },
      value,
    );
    const styles = v.parse(stylesSchema, value);
    return { ...parsed, ...styles };
  }),
);
export const observeResultSchema = v.strictObject({
  snapshot: jobSnapshotSchema,
  logs: logsSchema,
  screenVersion: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
  settled: v.boolean(),
  observedAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});
export const actionReceiptSchema = v.strictObject({
  ...jobIdentitySchema.entries,
  actionId: actionIdSchema,
  state: v.pipe(
    v.picklist(["not-sent", "sent-outcome-unknown", "processed"]),
    v.description(
      "Processed means broker accepted plus terminal observed, not proof the application consumed input",
    ),
  ),
  createdAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  sentAt: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
  observedAt: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
  screenVersion: v.optional(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u))),
  screenChanged: v.optional(
    v.pipe(
      v.boolean(),
      v.description(readText(new URL("./gateway.md", import.meta.url), "changed")),
    ),
  ),
  settled: v.optional(v.boolean()),
  snapshot: v.optional(jobSnapshotSchema),
  logs: v.optional(logsSchema),
  error: v.optional(v.string()),
});
export const terminationRequestSchema = v.strictObject({
  ...jobIdentitySchema.entries,
  actionId: actionIdSchema,
  kind: v.picklist(["interrupt", "stop", "force"]),
  timeoutMs: v.optional(
    v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(10000)),
    2000,
  ),
});
export const terminationMetadataSchema = v.strictObject({
  kind: v.picklist(["interrupt", "stop", "force"]),
  requestedAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  brokerAccepted: v.boolean(),
  leaderExited: v.boolean(),
  childrenGone: v.literal("unknown"),
  trackedProcessesNoLongerObserved: v.optional(v.boolean()),
});
export const terminationResultSchema = v.strictObject({
  receipt: actionReceiptSchema,
  termination: terminationMetadataSchema,
});
export const prepareStartRequestSchema = v.strictObject({
  operation: v.unknown(),
  deadlineSeconds: v.optional(
    v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(2147483)),
    0,
  ),
});
export const deadlineEvidenceSchema = v.strictObject({
  deadlineSeconds: v.pipe(v.number(), v.safeInteger(), v.gtValue(0)),
  preparedAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  startedAt: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
  deadlineTriggeredAt: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
  signalSentAt: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
  forceSentAt: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
  leaderExited: v.optional(v.boolean()),
  trackedProcessesNoLongerObserved: v.optional(v.boolean()),
  childrenGone: v.literal("unknown"),
  exitCode: v.optional(v.pipe(v.number(), v.safeInteger())),
  nativeTreeSignalFailed: v.optional(v.boolean()),
  error: v.optional(v.literal("deadline-enforcement-failed")),
});
const terminationStatusObjectSchema = v.strictObject({
  termination: v.optional(terminationMetadataSchema),
  deadline: v.optional(deadlineEvidenceSchema),
});
export const terminationStatusSchema = objectSchema(terminationStatusObjectSchema);
export type TerminationStatus = v.InferOutput<typeof terminationStatusSchema>;
export type JobObservation = v.InferOutput<typeof observeResultSchema>;
export type ActionReceipt = v.InferOutput<typeof actionReceiptSchema>;
export type JobReceipt = ActionReceipt;
export type ActionRequest = v.InferInput<typeof actionRequestSchema>;
export type TerminationRequest = v.InferInput<typeof terminationRequestSchema>;
export type TerminationResult = v.InferOutput<typeof terminationResultSchema>;
