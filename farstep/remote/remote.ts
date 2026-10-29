import { readText } from "@ai/toolkit/text/text";
import type { ToolContext, ToolExecution, ToolMetadata } from "@ai/toolkit/tool/tool";
import { objectSchema } from "@ai/values/schema/input";
import { isRecord } from "@ai/values/value/value";
import * as v from "valibot";
import {
  COORDINATION_ACTIONS,
  coordinationRequestInputSchema,
  coordinationRequestSchema,
} from "../protocol/coordination";
import { checkScriptInput } from "../protocol/script/script";
import { systemExecSchema } from "../protocol/system";
import { MAX_WORKFLOW_STEPS } from "../protocol/workflow/schemas";
import { createGuideParameters } from "./guide/schemas";
import { JOB_ACTIONS } from "./jobs/actions";
import { REMOTE_TOOLS } from "./tools/names";
import { createConnectionParameters } from "./tools/schemas/connection";
import { createDesktopParameters } from "./tools/schemas/desktop";
import { createFileParameters, MAX_FILE_BYTES } from "./tools/schemas/files";
import { createHelperParameters } from "./tools/schemas/helper";
import { createJobParameters } from "./tools/schemas/jobs";
import { scratchParameters } from "./tools/schemas/scratch";
import { createSudoParameters } from "./tools/schemas/sudo";

const { guideParameters } = createGuideParameters();
const { connectParameters } = createConnectionParameters();
const { desktopParameters, screenshotParameters, inputParameters } =
  createDesktopParameters();
const { readParameters, writeParameters, editParameters, deleteParameters } =
  createFileParameters();
const { parameters: helperParameters } = createHelperParameters();
const { runParameters, batchParameters, jobParameters } = createJobParameters();
const { sudoParameters } = createSudoParameters();
const targetSchema = v.optional(v.pipe(v.string(), v.minLength(1)), "local");
const intentSchema = v.optional(v.string());
const coordinationParameters = objectSchema(
  v.pipe(
    v.looseObject({ target: targetSchema, i: intentSchema }),
    v.transform(({ target, i: _intent, ...request }) => ({ target, request })),
    v.strictObject({ target: v.string(), request: coordinationRequestSchema }),
  ),
  v.object({
    ...coordinationRequestInputSchema.entries,
    target: targetSchema,
    i: intentSchema,
  }),
);
const systemParameters = v.variant("action", [
  v.strictObject({
    action: v.literal("inspect"),
    target: v.optional(v.string(), "local"),
  }),
  v.strictObject({
    action: v.literal("exec"),
    target: v.optional(v.string(), "local"),
    ...systemExecSchema.entries,
  }),
]);

function checkRunCommands(input: unknown): void {
  if (!isRecord(input)) return;
  checkScriptInput(input);
  if (isRecord(input.ready) && input.ready.kind === "command")
    checkScriptInput(input.ready);
}

export const remoteDefinitions = {
  guide: {
    name: REMOTE_TOOLS.guide,
    label: "Execution and remote guide",
    description: readText(new URL("./remote.md", import.meta.url), "guide"),
    parameters: guideParameters,
    loadMode: "essential",
    approval: "read",
  },
  connect: {
    name: REMOTE_TOOLS.connect,
    label: "Remote connection",
    description:
      "Connect and verify a generic SSH host; save its remote workspace profile.",
    parameters: connectParameters,
    loadMode: "discoverable",
    approval: "exec",
  },
  coordination: {
    name: REMOTE_TOOLS.coordination,
    label: "Shared agent coordination",
    description: readText(new URL("./remote.md", import.meta.url), "coordination"),
    parameters: coordinationParameters,
    loadMode: "discoverable",
    approval: (input) => {
      const parsed = v.safeParse(coordinationParameters, input);
      return parsed.success
        ? COORDINATION_ACTIONS[parsed.output.request.action].approval
        : "exec";
    },
  },
  run: {
    beforeParse: checkRunCommands,
    name: REMOTE_TOOLS.run,
    label: "Command",
    description: readText(new URL("./remote.md", import.meta.url), "run"),
    parameters: runParameters,
    loadMode: "discoverable",
    approval: "exec",
  },
  batch: {
    beforeParse(input: unknown) {
      if (isRecord(input) && Array.isArray(input.steps)) {
        if (input.steps.length > MAX_WORKFLOW_STEPS)
          throw new Error(`Batch supports at most ${MAX_WORKFLOW_STEPS} steps`);
        for (const step of input.steps) checkRunCommands(step);
      }
    },
    name: REMOTE_TOOLS.batch,
    label: "Batch",
    description: readText(new URL("./remote.md", import.meta.url), "batch"),
    parameters: batchParameters,
    loadMode: "discoverable",
    approval: "exec",
  },
  job: {
    name: REMOTE_TOOLS.job,
    label: "Job",
    description: readText(new URL("./remote.md", import.meta.url), "job"),
    parameters: jobParameters,
    loadMode: "discoverable",
    approval: (input) => {
      const parsed = v.safeParse(jobParameters, input);
      return parsed.success ? JOB_ACTIONS[parsed.output.action].approval : "exec";
    },
  },
  sudo: {
    name: REMOTE_TOOLS.sudo,
    label: "Remote sudo",
    description: "Run a remote sudo command with separate stdin-only authentication.",
    parameters: sudoParameters,
    loadMode: "discoverable",
    approval: "exec",
  },
  desktop: {
    name: REMOTE_TOOLS.desktop,
    label: "Remote desktop",
    description: readText(new URL("./remote.md", import.meta.url), "desktop"),
    parameters: desktopParameters,
    loadMode: "discoverable",
    approval: (input) => {
      const parsed = v.safeParse(desktopParameters, input);
      return parsed.success && parsed.output.action === "inspect" ? "read" : "exec";
    },
  },
  screenshot: {
    name: REMOTE_TOOLS.screenshot,
    label: "Remote screenshot",
    description: readText(new URL("./remote.md", import.meta.url), "screenshot"),
    parameters: screenshotParameters,
    loadMode: "discoverable",
    approval: "read",
  },
  input: {
    name: REMOTE_TOOLS.input,
    label: "Remote desktop input",
    description: readText(new URL("./remote.md", import.meta.url), "input"),
    parameters: inputParameters,
    loadMode: "discoverable",
    approval: "exec",
  },
  helper: {
    name: REMOTE_TOOLS.helper,
    label: "Remote helper installation",
    description: readText(new URL("./remote.md", import.meta.url), "helper"),
    parameters: helperParameters,
    loadMode: "discoverable",
    approval: (input) => {
      const parsed = v.safeParse(helperParameters, input);
      return parsed.success &&
        (parsed.output.action === "inspect" || parsed.output.action === "plan")
        ? "read"
        : "exec";
    },
  },
  scratch: {
    name: REMOTE_TOOLS.scratch,
    label: "Scratch workspace",
    description: readText(new URL("./remote.md", import.meta.url), "scratch"),
    parameters: scratchParameters,
    loadMode: "discoverable",
    approval: (input) => {
      const parsed = v.safeParse(scratchParameters, input);
      return parsed.success && ["list", "inspect"].includes(parsed.output.action)
        ? "read"
        : "write";
    },
  },
  system: {
    name: REMOTE_TOOLS.system,
    label: "Farstep system access",
    description: readText(new URL("./remote.md", import.meta.url), "system"),
    parameters: systemParameters,
    loadMode: "discoverable",
    approval: (input) => {
      const parsed = v.safeParse(systemParameters, input);
      return parsed.success && parsed.output.action === "inspect" ? "read" : "exec";
    },
  },
  read: {
    name: REMOTE_TOOLS.read,
    label: "Read remote file",
    description: readText(new URL("./remote.md", import.meta.url), "read", {
      LIMIT_MIB: String(MAX_FILE_BYTES / 1024 / 1024),
    }),
    parameters: readParameters,
    loadMode: "discoverable",
    approval: "read",
  },
  write: {
    name: REMOTE_TOOLS.write,
    label: "Write remote file",
    description: readText(new URL("./remote.md", import.meta.url), "write"),
    parameters: writeParameters,
    loadMode: "discoverable",
    approval: "write",
  },
  edit: {
    name: REMOTE_TOOLS.edit,
    label: "Edit remote file",
    description: readText(new URL("./remote.md", import.meta.url), "edit"),
    parameters: editParameters,
    loadMode: "discoverable",
    approval: "write",
  },
  delete: {
    name: REMOTE_TOOLS.delete,
    label: "Delete remote file",
    description: readText(new URL("./remote.md", import.meta.url), "delete"),
    parameters: deleteParameters,
    loadMode: "discoverable",
    approval: "write",
  },
} satisfies Record<string, ToolMetadata<v.GenericSchema>>;
export type RemoteHandlers<C extends ToolContext = ToolContext> = {
  [K in keyof typeof remoteDefinitions]: ToolExecution<
    v.InferOutput<(typeof remoteDefinitions)[K]["parameters"]>,
    C
  >;
};
