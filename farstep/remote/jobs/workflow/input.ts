import * as v from "valibot";
import { createWorkflowSchemas } from "#farstep/protocol/workflow/schemas";
import { scriptFields } from "../../../protocol/script/script";
import { textSchema } from "../shell/values";

const { workflowOutputPolicySchema, workflowReadySchema, workflowRequestIdSchema } =
  createWorkflowSchemas(v.unknown());

const [logReady, tcpReady, httpReady, fileReady] = workflowReadySchema.options;

const polling = {
  timeout: v.pipe(
    v.optional(v.pipe(v.number(), v.finite(), v.minValue(0.001), v.maxValue(3600))),
    v.description("Readiness deadline in seconds; default 30"),
  ),
  interval: v.pipe(
    v.optional(v.pipe(v.number(), v.finite(), v.minValue(0.01), v.maxValue(60))),
    v.description("Polling interval in seconds; default 0.1"),
  ),
};
export const readinessInputSchema = v.union([
  v.pipe(textSchema, v.minLength(1), v.description("Readiness regex in output")),
  v.variant("kind", [
    v.strictObject({
      ...polling,
      kind: v.literal("log"),
      pattern: logReady.entries.pattern,
    }),
    v.strictObject({
      ...polling,
      kind: v.literal("tcp"),
      host: v.optional(v.unwrap(tcpReady.entries.host)),
      port: tcpReady.entries.port,
    }),
    v.strictObject({
      ...polling,
      kind: v.literal("http"),
      url: httpReady.entries.url,
      status: v.optional(v.unwrap(httpReady.entries.status)),
      bodyContains: httpReady.entries.bodyContains,
    }),
    v.strictObject({
      ...polling,
      kind: v.literal("file"),
      path: fileReady.entries.path,
      state: v.optional(v.unwrap(fileReady.entries.state)),
    }),
    v.strictObject({
      ...polling,
      kind: v.literal("command"),
      ...scriptFields,
      cwd: v.optional(v.pipe(textSchema, v.minLength(1))),
    }),
  ]),
]);
export type ReadinessInput = v.InferOutput<typeof readinessInputSchema>;
const outputInputSchema = v.union([
  v.picklist(["text", "json", "jsonl"]),
  workflowOutputPolicySchema,
]);
export const workflowInputFields = {
  requestId: v.pipe(
    v.optional(workflowRequestIdSchema),
    v.description(
      "Stable launch intent ID; reuse recovers the same job, changed arguments reject",
    ),
  ),
  output: v.pipe(
    v.optional(outputInputSchema),
    v.description(
      "Bounded text/JSON/JSONL stdout with separate stderr and private file references; machine output requires pty:false",
    ),
  ),
  creates: v.pipe(
    v.optional(v.pipe(textSchema, v.minLength(1))),
    v.description(
      "Skip if this filesystem entry exists, relative to job cwd; not an atomic lock or freshness check",
    ),
  ),
  removes: v.pipe(
    v.optional(v.pipe(textSchema, v.minLength(1))),
    v.description(
      "Skip if this filesystem entry is missing, relative to job cwd; evaluated after creates",
    ),
  ),
};
