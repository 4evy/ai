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
    environmentConfig: example(
      runParameters,
      {
        script:
          "const service = cmd.with({\n  cwd: params.directory,\n  env: Env.only(['PATH', 'HOME']).dotenv(params.dotenv).set({ NODE_ENV: 'production' }),\n});\nconst settings = await service.config(Config.all({\n  name: Config.String('SERVICE_NAME'),\n  port: Config.Number('PORT'),\n  debug: Config.Boolean('DEBUG'),\n  token: Config.Redacted('API_TOKEN'),\n}));\nconsole.log({ name: settings.name, port: settings.port, debug: settings.debug });",
        params: { directory: "./service", dotenv: ".env" },
        pty: false,
      },
      true,
    ),
    literalSearch: example(
      runParameters,
      {
        script:
          "const result = await cmd.run(['rg', '--fixed-strings', '--', params.text, params.path], { okExitCodes: [0, 1] });\nconsole.log(result.stdout);",
        params: { text: "a $literal", path: "./src" },
        pty: false,
      },
      true,
    ),
    argumentVector: example(
      runParameters,
      {
        script:
          "for (const argv of params.commands as string[][]) {\n  console.log(await cmd.text(argv));\n}",
        params: {
          commands: [
            ["printf", "%s\n", "a path with spaces", "$(not a command)"],
            ["printf", "%s\n", "second command"],
          ],
        },
        pty: false,
      },
      true,
    ),
    commandInput: example(
      runParameters,
      {
        script:
          "const rows = await cmd.lines(['sort'], { stdin: { text: params.text } });\nconsole.log(JSON.stringify(rows));",
        params: { text: "pear\napple\npear\n" },
        output: { format: "json", maxBytes: 4096, maxCaptureBytes: 1024 * 1024 },
        pty: false,
      },
      true,
    ),
    packageLoop: example(
      runParameters,
      {
        script:
          "const results = await cmd.map(params.packages as string[], async (directory, _index, signal) => {\n  const local = cmd.with({ cwd: directory, env: { CI: '1' }, signal });\n  await local.run(['bun', 'run', 'check'], { verbose: true });\n  return directory;\n}, { concurrency: 2 });\nconsole.log(JSON.stringify({ checked: results }));",
        params: { packages: ["packages/api", "packages/ui"] },
        pty: false,
      },
      true,
    ),
    parsedScript: example(
      runParameters,
      {
        script:
          "const counts = [];\nfor (const value of params.values as string[]) {\n  const count = Number(await cmd.text(['printf', '%s', value]));\n  if (count > 0) counts.push(count);\n}\nconsole.log(JSON.stringify({ counts }));",
        params: { values: ["2", "0", "3"] },
        output: "json",
        pty: false,
      },
      true,
    ),
    stdoutJson: example(
      runParameters,
      {
        script:
          "const value = await cmd.json(['bun', '--eval', params.source]);\nconsole.log(JSON.stringify(value));",
        params: {
          source:
            "console.error('progress'); console.log(JSON.stringify({ ok: true }));",
        },
        output: "json",
        pty: false,
      },
      true,
    ),
    pipeline: example(
      runParameters,
      {
        script:
          "const result = await cmd.pipe([\n  { argv: ['cat'], options: { stdin: { file: params.input }, timeout: '5s' } },\n  { argv: ['gzip', '-c'], options: { env: { LC_ALL: 'C' }, timeout: '10s' } },\n], { stdout: { file: params.output }, stderr: { file: params.log, append: true } });\nconst archive = await cmd.bytes(['cat'], { stdin: { file: params.output } });\nawait cmd.run(['gzip', '-t'], { stdin: { bytes: archive } });\nconsole.log(JSON.stringify({ exitCode: result.exitCode, bytes: archive.byteLength }));",
        params: {
          input: "./input.bin",
          output: "./input.bin.gz",
          log: "./compression.log",
        },
        pty: false,
      },
      true,
    ),
    typedQuery: example(
      runParameters,
      {
        script:
          "const Job = Schema.Struct({ team: Schema.String, cpu: Schema.Number });\nconst Owner = Schema.Struct({ team: Schema.String, name: Schema.String });\nconst owners = Query.fromEffect(Schema.decodeUnknownEffect(Schema.Array(Owner))(params.owners));\nconst report = cmd.query.json(['cat'], { stdin: { text: JSON.stringify(params.jobs) }, schema: Job })\n  .where(job => job.cpu >= 2)\n  .groupBy(job => job.team)\n  .select(({ key, rows }) => ({ team: key, cpu: Math.sumPrecise(rows.map(row => row.cpu)), jobs: rows.length }))\n  .leftJoin(owners, { left: row => row.team, right: owner => owner.team }, (row, owner) => ({ ...row, owner: owner?.name ?? 'unassigned' }))\n  .orderBy((a, b) => b.cpu - a.cpu)\n  .pick('team', 'cpu', 'jobs', 'owner');\nconsole.log(JSON.stringify(await report.take(10).collect()));",
        params: {
          jobs: [
            { team: "build", cpu: 3 },
            { team: "build", cpu: 4 },
            { team: "search", cpu: 2 },
            { team: "idle", cpu: 0 },
          ],
          owners: [{ team: "build", name: "compiler" }],
        },
        output: "json",
        pty: false,
      },
      true,
    ),
    effectQueries: example(
      runParameters,
      {
        script:
          "const Snapshot = Schema.Struct({ ready: Schema.Boolean, workers: Schema.Number });\nconst results = await cmd.execute(Effect.all({\n  snapshot: cmd.effect.json(['cat'], { stdin: { text: JSON.stringify(params.snapshot) }, schema: Snapshot }),\n  version: cmd.effect.text(['bun', '--version']),\n}, { concurrency: 2 }).pipe(Effect.timeout('5 seconds')));\nconsole.log(JSON.stringify(results));",
        params: { snapshot: { ready: true, workers: 4 } },
        output: "json",
        pty: false,
      },
      true,
    ),
    liveQuery: example(
      runParameters,
      {
        script:
          "const Row = Schema.Struct({ sequence: Schema.Number });\nconst rows = await cmd.query.jsonl(['bun', '--eval', params.source], { schema: Row })\n  .where(row => row.sequence % 2 === 0)\n  .take(3)\n  .collect();\nconsole.log(JSON.stringify(rows));",
        params: {
          source:
            "let sequence = 0; setInterval(() => console.log(JSON.stringify({ sequence: ++sequence })), 25);",
        },
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
