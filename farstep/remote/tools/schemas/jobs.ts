import { readText } from "@ai/toolkit/text/text";
import { Struct } from "effect";
import * as v from "valibot";
import {
  actionIdSchema,
  settlingShape,
  terminalSizeSchema,
} from "#farstep/protocol/jobs/jobs";
import {
  createWorkflowSchemas,
  MAX_WORKFLOW_STEPS,
} from "#farstep/protocol/workflow/schemas";
import { TERMINAL_KEYS } from "../../../client/terminal/keys/keys";
import { scriptFields } from "../../../protocol/script/script";
import { JOB_ACTIONS, MAX_SEQUENCE_STEPS } from "../../jobs/actions";
import {
  environmentSchema,
  MAX_ENVIRONMENT_VALUE_LENGTH,
  MAX_ENVIRONMENT_VARIABLES,
} from "../../jobs/shell/bindings";
import { readinessInputSchema, workflowInputFields } from "../../jobs/workflow/input";

const { workflowPrepareSchema, workflowTaskSchema } = createWorkflowSchemas(
  v.unknown(),
);

export function createJobParameters() {
  const columnsParameter = v.optional(terminalSizeSchema.entries.columns);
  const rowsParameter = v.optional(terminalSizeSchema.entries.rows);
  const lifetimeParameter = v.optional(v.picklist(["session", "persist"]));
  const runParameters = v.strictObject({
    ...workflowInputFields,
    target: v.pipe(
      v.optional(v.pipe(v.string(), v.minLength(1))),
      v.description("Execution target; local (default) or a saved SSH connection ID"),
    ),
    ...scriptFields,
    name: v.pipe(
      v.optional(v.string()),
      v.description("Readable suffix; handle remains unique"),
    ),
    cwd: v.pipe(
      v.optional(v.string()),
      v.description("Target absolute or workspace-relative cwd"),
    ),
    timeout: v.pipe(
      v.optional(v.unwrap(workflowTaskSchema.entries.timeoutSeconds)),
      v.description("Execution seconds; 0 disables deadline"),
    ),
    waitSeconds: v.pipe(
      v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(30))),
      v.description("Initial observation budget, not command deadline"),
    ),
    pty: v.pipe(
      v.optional(v.boolean()),
      v.description("Target broker PTY; default true, or false for JSON/JSONL output"),
    ),
    columns: v.pipe(columnsParameter, v.description("PTY columns; default 120")),
    rows: v.pipe(rowsParameter, v.description("PTY rows; default 40")),
    ready: v.pipe(
      v.optional(readinessInputSchema),
      v.description("Log, TCP, HTTP, file or TypeScript command readiness"),
    ),
    lifetime: lifetimeParameter,
    shell: v.pipe(
      v.optional(v.picklist(["bash", "zsh"])),
      v.description("Target interpreter; default bash"),
    ),
    login: v.pipe(
      v.optional(v.boolean()),
      v.description("Load the selected shell's login startup files; default false"),
    ),
    environment: v.pipe(
      v.optional(v.picklist(["shared", "inherit"])),
      v.description(
        readText(new URL("./jobs/jobs.md", import.meta.url), "environment"),
      ),
    ),
    envFiles: v.pipe(
      v.optional(v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.maxLength(16))),
      v.description(readText(new URL("./jobs/jobs.md", import.meta.url), "files")),
    ),
    env: v.pipe(
      v.optional(environmentSchema),
      v.description(
        readText(new URL("./jobs/jobs.md", import.meta.url), "variables", {
          VARIABLES: String(MAX_ENVIRONMENT_VARIABLES),
          LENGTH: String(MAX_ENVIRONMENT_VALUE_LENGTH),
        }),
      ),
    ),
    raw: v.pipe(
      v.optional(v.boolean()),
      v.description("Include unread raw terminal redraw logs"),
    ),
    compact: v.pipe(
      v.optional(v.boolean()),
      v.description("Compact structured result; default true"),
    ),
  });
  const batchStepParameters = v.strictObject({
    ...v.omit(runParameters, [
      "target",
      "name",
      "requestId",
      "lifetime",
      "waitSeconds",
      "raw",
      "compact",
      "columns",
      "rows",
    ]).entries,
    id: workflowTaskSchema.entries.id,
    dependsOn: workflowTaskSchema.entries.dependsOn,
  });
  const batchParameters = v.strictObject({
    ...v.omit(runParameters, [
      "script",
      "params",
      "captureBytes",
      "ready",
      "pty",
      "columns",
      "rows",
      "creates",
      "removes",
    ]).entries,
    steps: v.pipe(
      v.array(batchStepParameters),
      v.minLength(1),
      v.maxLength(MAX_WORKFLOW_STEPS),
    ),
    concurrency: workflowPrepareSchema.entries.concurrency,
    onFailure: v.pipe(
      workflowPrepareSchema.entries.onFailure,
      v.description(
        "drain stops scheduling on failure; cancel also stops running work; continue runs independent steps",
      ),
    ),
  });
  const jobParameters = createJobControlParameters();
  return { runParameters, batchParameters, jobParameters };
}

function createJobControlParameters() {
  const geometry = terminalSizeSchema.entries;
  const columnsParameter = v.optional(geometry.columns);
  const rowsParameter = v.optional(geometry.rows);
  const lifetimeParameter = v.optional(v.picklist(["session", "persist"]));
  // JOB_ACTIONS is the complete static set of accepted action names
  const actions = Struct.keys(JOB_ACTIONS);
  const jobParameters = v.object({
    action: v.picklist(actions),
    job: v.pipe(v.optional(v.string()), v.description("Exact returned job handle")),
    step: v.pipe(
      v.optional(workflowTaskSchema.entries.id),
      v.description(
        "Step ID for workflow status, logs or cancel; omit for the whole workflow",
      ),
    ),
    data: v.pipe(
      v.optional(v.string()),
      v.description("Raw input, or a reply/password submitted with Enter"),
    ),
    keys: v.pipe(
      v.optional(v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1))),
      v.description(`Named terminal keys in order. ${TERMINAL_KEYS}`),
    ),
    prompt: v.pipe(
      v.optional(v.pipe(v.string(), v.minLength(1))),
      v.description("Label for a plaintext password prompt"),
    ),
    columns: v.pipe(columnsParameter, v.description("New PTY width for resize")),
    rows: v.pipe(rowsParameter, v.description("New PTY height for resize")),
    cursor: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    lines: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000))),
    waitSeconds: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(60))),
    pattern: v.pipe(v.optional(v.string()), v.description("Output regex for wait")),
    lifetime: lifetimeParameter,
    actionId: v.pipe(
      v.optional(actionIdSchema),
      v.description(
        "Stable input ID; duplicate IDs recover receipts without resending",
      ),
    ),
    expectedScreenVersion: v.pipe(
      v.optional(v.pipe(v.string(), v.minLength(1))),
      v.description("Reject input if the observed screen changed"),
    ),
    settleMs: v.pipe(
      v.optional(v.unwrap(settlingShape.settleMs)),
      v.description("Quiet terminal window in milliseconds; default 100"),
    ),
    maxWaitMs: v.pipe(
      v.optional(v.unwrap(settlingShape.maxWaitMs)),
      v.description("Hard terminal settling budget; default 500, even for spinners"),
    ),
    raw: v.pipe(
      v.optional(v.boolean()),
      v.description("Include unread raw terminal redraw logs"),
    ),
    compact: v.pipe(
      v.optional(v.boolean()),
      v.description("Compact structured result; default true"),
    ),
    steps: v.pipe(
      v.optional(
        v.pipe(
          v.array(
            v.object({
              keys: v.pipe(
                v.array(v.pipe(v.string(), v.minLength(1))),
                v.minLength(1),
                v.maxLength(64),
              ),
              expect: v.pipe(
                v.string(),
                v.minLength(1),
                v.description("Regex required in the screen after this step"),
              ),
              screenVersion: v.optional(v.pipe(v.string(), v.minLength(1))),
            }),
          ),
          v.minLength(1),
          v.maxLength(MAX_SEQUENCE_STEPS),
        ),
      ),
      v.description("Bounded checked sequence; stop before the next step on mismatch"),
    ),
  });
  return jobParameters;
}
