// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Script examples contain target-side template literals
import { guideExample } from "@ai/toolkit/guide/guide";
import * as v from "valibot";
import { coordinationRequestSchema } from "../../protocol/coordination";
import { createWorkflowSchemas } from "../../protocol/workflow/schemas";
import { createConnectionParameters } from "../tools/schemas/connection";
import { createDesktopParameters } from "../tools/schemas/desktop";
import { createFileParameters } from "../tools/schemas/files";
import { createHelperParameters } from "../tools/schemas/helper";
import { createJobParameters } from "../tools/schemas/jobs";
import { scratchParameters } from "../tools/schemas/scratch";
import { createSudoParameters } from "../tools/schemas/sudo";

const { workflowOutputSchema } = createWorkflowSchemas(v.unknown());

const { runParameters, batchParameters, jobParameters } = createJobParameters();
const { connectParameters } = createConnectionParameters();
const { desktopParameters, screenshotParameters, inputParameters } =
  createDesktopParameters();
const { readParameters, editParameters } = createFileParameters();
const { parameters: helperParameters } = createHelperParameters();
const { sudoParameters } = createSudoParameters();
const workId = "00000000-0000-4000-8000-000000000001";
const workspaceId = "00000000-0000-4000-8000-000000000002";
const fileHash = "0".repeat(64);
const placeholders = new Map([
  [workId, "WORK_ID"],
  [workspaceId, "WORKSPACE_ID"],
  [fileHash, "FULL_FILE_SHA256"],
]);

function example<TSchema extends v.GenericSchema>(
  schema: TSchema,
  input: NoInfer<v.InferInput<TSchema>>,
  multiline = false,
  replacements: ReadonlyMap<unknown, string> = placeholders,
): string {
  return guideExample(schema, input, { multiline, replacements });
}

export function localRunContext(cwd: string): string {
  return example(v.pick(runParameters, ["cwd"]), { cwd });
}

export const EXAMPLES = {
  connect: {
    connectTarget: example(connectParameters, { target: "SSH_ALIAS_OR_USER_AT_HOST" }),
  },
  helper: {
    inspectHelper: example(helperParameters, {
      connection: "CONNECTION_ID",
      action: "inspect",
    }),
    planHelper: example(helperParameters, {
      connection: "CONNECTION_ID",
      action: "plan",
      operation: "upgrade",
    }),
  },
  files: {
    readFileRange: example(readParameters, {
      connection: "CONNECTION_ID",
      path: "REMOTE_FILE_PATH",
      selector: "1-100",
    }),
    editFile: example(
      editParameters,
      {
        connection: "CONNECTION_ID",
        path: "REMOTE_FILE_PATH",
        old_string: "before",
        new_string: "after",
        expectedHash: fileHash,
      },
      true,
    ),
  },
  desktop: {
    inspectDesktop: example(desktopParameters, {
      connection: "CONNECTION_ID",
      action: "inspect",
    }),
    authorizeDesktop: example(desktopParameters, {
      connection: "CONNECTION_ID",
      action: "authorize",
    }),
    releaseWorkspace: example(desktopParameters, {
      connection: "CONNECTION_ID",
      action: "release-workspace",
      workspaceId: "RETURNED_WORKSPACE_ID",
    }),
  },
  screenshots: {
    captureFrame: example(screenshotParameters, {
      connection: "CONNECTION_ID",
      sessionId: "AUTHORIZED_SESSION_ID",
    }),
  },
  input: {
    clickFrame: example(
      inputParameters,
      {
        connection: "CONNECTION_ID",
        sessionId: "AUTHORIZED_SESSION_ID",
        frame: { streamId: "CURRENT_STREAM_ID", frameId: "CURRENT_FRAME_ID" },
        action: { method: "click", input: { x: 0, y: 1 } },
      },
      true,
      new Map([
        [0, "OBSERVED_X"],
        [1, "OBSERVED_Y"],
      ]),
    ),
  },
  coordination: {
    snapshot: example(coordinationRequestSchema, { action: "snapshot" }),
    createWork: example(coordinationRequestSchema, {
      action: "work",
      title: "Update documentation",
      requestId: "CREATE_REQUEST_ID",
    }),
    claimWork: example(coordinationRequestSchema, {
      action: "claim",
      work: workId,
      resources: ["documentation"],
      ttlSeconds: 600,
      requestId: "CLAIM_REQUEST_ID",
    }),
    releaseWork: example(coordinationRequestSchema, {
      action: "release",
      work: workId,
      requestId: "RELEASE_REQUEST_ID",
    }),
    linkJob: example(coordinationRequestSchema, {
      action: "link",
      work: workId,
      job: "NATIVE_JOB_NAME",
      requestId: "LINK_REQUEST_ID",
    }),
  },
  scratch: {
    createWorkspace: example(scratchParameters, {
      action: "create",
      name: "compiler-repro",
    }),
    inspectWorkspace: example(scratchParameters, {
      action: "inspect",
      workspace: workspaceId,
    }),
    removeWorkspace: example(scratchParameters, {
      action: "remove",
      workspace: workspaceId,
    }),
  },
  run: {
    environmentPaths: example(v.pick(runParameters, ["cwd", "envFiles"]), {
      cwd: "trials",
      envFiles: ["trials/first.env", "trials/second.env"],
    }),
    literalSearch: example(
      runParameters,
      {
        script:
          "const result = await $({ nothrow: true })`rg --fixed-strings -- ${params.text} ${params.path}`;\nif (result.exitCode !== 0 && result.exitCode !== 1) throw result;\nconsole.log(result.stdout);",
        params: { text: "a $literal", path: "./src" },
        pty: false,
      },
      true,
    ),
    packageLoop: example(
      runParameters,
      {
        script:
          "for (const directory of params.packages as string[]) {\n  console.error(`Checking ${directory}`);\n  await $({ cwd: directory, verbose: true })`bun run check`;\n}",
        params: { packages: ["packages/api", "packages/ui"] },
        pty: false,
      },
      true,
    ),
    parsedScript: example(
      runParameters,
      {
        script:
          "async function readCount(value: string): Promise<number> {\n  const result = await $`printf '%s\\n' ${value}`;\n  return Number(result.stdout.trim());\n}\nconst counts = [];\nfor (const value of params.values as string[]) {\n  const count = await readCount(value);\n  if (count > 0) counts.push(count);\n}\nconsole.log(JSON.stringify({ counts }));",
        params: { values: ["2", "0", "3"] },
        output: "json",
        pty: false,
      },
      true,
    ),
    dependentBatch: example(
      batchParameters,
      {
        requestId: "BUILD_REQUEST_ID",
        steps: [
          { id: "fetch", script: "await $({ verbose: true })`just fetch`;" },
          {
            id: "check",
            dependsOn: ["fetch"],
            script: "await $({ verbose: true })`just check`;",
          },
          {
            id: "build",
            dependsOn: ["fetch"],
            script: "await $({ verbose: true })`just build`;",
          },
        ],
        concurrency: 2,
        onFailure: "drain",
      },
      true,
    ),
    scriptReady: example(v.pick(runParameters, ["ready"]), {
      ready: {
        kind: "command",
        script: "await $`test -r ${params.path}`;",
        params: { path: "./ready" },
      },
    }),
    httpReady: example(v.pick(runParameters, ["ready"]), {
      ready: { kind: "http", url: "http://127.0.0.1:8080/health", status: 200 },
    }),
    parsedOutput: example(
      workflowOutputSchema,
      { format: "json", state: "complete", value: { ok: true } },
      true,
    ),
  },
  jobs: {
    jobStatus: example(jobParameters, { action: "status", job: "RETURNED_HANDLE" }),
    inputReceipt: example(jobParameters, {
      action: "receipt",
      job: "RETURNED_HANDLE",
      actionId: "INPUT_ACTION_ID",
    }),
  },
  sudo: {
    sudoIdentity: example(sudoParameters, {
      connection: "CONNECTION_ID",
      command: "id -u",
    }),
  },
  interactive: {
    terminalLaunch: example(
      runParameters,
      {
        script: 'await $({ stdio: "inherit" })`bash --noprofile --norc`;',
        pty: true,
        waitSeconds: 0,
      },
      true,
    ),
    reply: example(jobParameters, {
      action: "reply",
      job: "RETURNED_HANDLE",
      data: "y",
    }),
    checkedKey: example(
      jobParameters,
      {
        action: "keys",
        job: "RETURNED_HANDLE",
        actionId: "select-next-item-1",
        expectedScreenVersion: "OBSERVED_SCREEN_VERSION",
        keys: ["Down"],
      },
      true,
    ),
    checkedSequence: example(
      jobParameters,
      {
        action: "sequence",
        job: "RETURNED_HANDLE",
        actionId: "open-details-1",
        expectedScreenVersion: "OBSERVED_SCREEN_VERSION",
        steps: [
          { keys: ["Down"], expect: "selected item" },
          { keys: ["Enter"], expect: "details" },
        ],
      },
      true,
    ),
  },
};
