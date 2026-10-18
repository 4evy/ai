import { objectSchema, recordSchema } from "@ai/core/schema/input";
import * as v from "valibot";
import { urlSchema } from "../identity";
import { terminalSizeSchema } from "../jobs/jobs";

export const MAX_WORKFLOW_STEPS = 128;
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export const jsonValueSchema: v.GenericSchema<JsonValue> = v.lazy(() =>
  v.union([
    v.string(),
    v.pipe(v.number(), v.finite()),
    v.boolean(),
    v.null(),
    v.array(jsonValueSchema),
    recordSchema(v.string(), jsonValueSchema),
  ]),
);
// The execution backend owns validation of its native launch specification
export function createWorkflowSchemas<S extends v.GenericSchema>(daemonSpecSchema: S) {
  const WORKFLOW_CAPABILITY = "workflow-v1";
  const text = v.pipe(v.string(), v.excludes("\0", "NUL is not allowed"));
  const name = v.pipe(
    text,
    v.regex(/^[A-Za-z0-9._-]{1,128}$/u),
    v.check((value) => value !== "." && value !== "..", "Invalid path-like identifier"),
  );
  const workflowRequestIdSchema = v.pipe(text, v.regex(/^[A-Za-z0-9._:-]{1,128}$/u));
  const workflowNativeSpecSchema = daemonSpecSchema;
  const workflowOutputPolicyObjectSchema = v.strictObject({
    format: v.optional(v.picklist(["text", "json", "jsonl"]), "text"),
    maxBytes: v.optional(
      v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(65536)),
      32768,
    ),
    maxCaptureBytes: v.optional(
      v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(MAX_CAPTURE_BYTES)),
      MAX_CAPTURE_BYTES,
    ),
    maxRecords: v.optional(
      v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(1000)),
      256,
    ),
  });
  const workflowOutputPolicySchema = objectSchema(workflowOutputPolicyObjectSchema);
  const workflowGuardSchema = v.strictObject({
    path: v.pipe(text, v.minLength(1)),
    when: v.picklist(["exists", "missing"]),
  });
  const readyScope = {
    timeoutMs: v.optional(
      v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(3600000)),
      30000,
    ),
    pollMs: v.optional(
      v.pipe(v.number(), v.safeInteger(), v.minValue(10), v.maxValue(60000)),
      100,
    ),
  };
  const workflowReadySchema = v.variant("kind", [
    v.strictObject({
      ...readyScope,
      kind: v.literal("log"),
      pattern: v.pipe(text, v.minLength(1), v.maxLength(4096)),
    }),
    v.strictObject({
      ...readyScope,
      kind: v.literal("tcp"),
      host: v.optional(v.pipe(text, v.minLength(1), v.maxLength(1024)), "127.0.0.1"),
      port: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(65535)),
    }),
    v.strictObject({
      ...readyScope,
      kind: v.literal("http"),
      url: v.pipe(urlSchema, v.maxLength(8192)),
      status: v.optional(
        v.pipe(v.number(), v.safeInteger(), v.minValue(100), v.maxValue(599)),
        200,
      ),
      bodyContains: v.optional(v.pipe(text, v.maxLength(65536))),
    }),
    v.strictObject({
      ...readyScope,
      kind: v.literal("file"),
      path: v.pipe(text, v.minLength(1)),
      state: v.optional(v.picklist(["present", "absent"]), "present"),
    }),
    v.strictObject({
      ...readyScope,
      kind: v.literal("command"),
      spec: workflowNativeSpecSchema,
    }),
  ]);
  const workflowReadinessResultSchema = v.strictObject({
    state: v.picklist(["pending", "ready", "failed", "timed_out"]),
    observedAt: v.pipe(v.number(), v.finite(), v.minValue(0)),
    reason: v.optional(text),
  });
  const workflowTaskSchema = v.strictObject({
    id: name,
    dependsOn: v.optional(
      v.pipe(v.array(name), v.maxLength(MAX_WORKFLOW_STEPS)),
      () => [],
    ),
    spec: workflowNativeSpecSchema,
    timeoutSeconds: v.optional(
      v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(3600)),
      0,
    ),
    guards: v.optional(v.pipe(v.array(workflowGuardSchema), v.maxLength(16)), () => []),
    ready: v.optional(workflowReadySchema),
    output: v.optional(workflowOutputPolicySchema, () =>
      v.parse(workflowOutputPolicySchema, {}),
    ),
  });
  const workflowRootSchema = v.strictObject({
    name,
    cwd: v.pipe(text, v.startsWith("/")),
    env: recordSchema(v.pipe(text, v.minLength(1)), text),
    pty: v.boolean(),
    terminalSize: v.optional(terminalSizeSchema),
    persist: v.boolean(),
  });
  const workflowPrepareSchema = v.strictObject({
    requestId: v.optional(workflowRequestIdSchema),
    kind: v.picklist(["job", "batch"]),
    root: workflowRootSchema,
    tasks: v.pipe(
      v.array(workflowTaskSchema),
      v.minLength(1),
      v.maxLength(MAX_WORKFLOW_STEPS),
    ),
    concurrency: v.optional(
      v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(32)),
      1,
    ),
    onFailure: v.optional(v.picklist(["drain", "cancel", "continue"]), "drain"),
    timeoutSeconds: v.optional(
      v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(3600)),
      0,
    ),
  });
  const workflowPreparedSchema = v.strictObject({
    spec: workflowNativeSpecSchema,
    name,
    fingerprint: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
    createdAt: v.pipe(v.number(), v.finite(), v.minValue(0)),
  });
  const workflowStartSchema = v.strictObject({
    name,
    fingerprint: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
  });
  const workflowInspectSchema = v.strictObject({ name, step: v.optional(name) });
  const workflowCancelSchema = v.strictObject({ name, step: v.optional(name) });
  const workflowArtifactSchema = v.strictObject({
    path: v.pipe(text, v.startsWith("/")),
    bytes: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    retainedBytes: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    truncated: v.boolean(),
  });
  const workflowOutputSchema = v.strictObject({
    format: v.picklist(["text", "json", "jsonl"]),
    state: v.picklist(["complete", "invalid", "oversized", "truncated", "inherited"]),
    stdout: v.optional(workflowArtifactSchema),
    stderr: v.optional(workflowArtifactSchema),
    stdoutText: v.optional(v.string()),
    stderrText: v.optional(v.string()),
    value: v.optional(jsonValueSchema),
    records: v.optional(v.pipe(v.array(jsonValueSchema), v.maxLength(1000))),
    error: v.optional(text),
    inlineOmitted: v.optional(v.boolean()),
  });
  const workflowStepResultSchema = v.strictObject({
    id: name,
    dependsOn: v.array(name),
    state: v.picklist([
      "queued",
      "starting",
      "running",
      "succeeded",
      "failed",
      "skipped",
      "blocked",
      "cancelled",
      "unknown",
    ]),
    pid: v.optional(v.pipe(v.number(), v.safeInteger(), v.gtValue(0))),
    startedAt: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
    finishedAt: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
    exitCode: v.optional(v.pipe(v.number(), v.safeInteger())),
    reason: v.optional(text),
    readiness: v.optional(workflowReadinessResultSchema),
    output: v.optional(workflowOutputSchema),
  });
  const workflowResultSchema = v.strictObject({
    name,
    kind: v.picklist(["job", "batch"]),
    requestId: v.optional(workflowRequestIdSchema),
    fingerprint: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
    state: v.picklist([
      "prepared",
      "running",
      "succeeded",
      "failed",
      "skipped",
      "cancelled",
      "unknown",
    ]),
    createdAt: v.pipe(v.number(), v.finite(), v.minValue(0)),
    finishedAt: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
    steps: v.pipe(
      v.array(workflowStepResultSchema),
      v.minLength(1),
      v.maxLength(MAX_WORKFLOW_STEPS),
    ),
  });
  return {
    WORKFLOW_CAPABILITY,
    jsonValueSchema,
    workflowRequestIdSchema,
    workflowNativeSpecSchema,
    workflowOutputPolicySchema,
    workflowGuardSchema,
    workflowReadySchema,
    workflowReadinessResultSchema,
    workflowTaskSchema,
    workflowRootSchema,
    workflowPrepareSchema,
    workflowPreparedSchema,
    workflowStartSchema,
    workflowInspectSchema,
    workflowCancelSchema,
    workflowArtifactSchema,
    workflowOutputSchema,
    workflowStepResultSchema,
    workflowResultSchema,
  };
}
