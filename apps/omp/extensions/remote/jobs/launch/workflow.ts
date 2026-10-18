import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Gateway } from "farstep/client/jobs/gateway";
import {
  JOB_PTY_COLUMNS,
  JOB_PTY_ROWS,
  parseJobTerminalSize,
} from "farstep/protocol/jobs/protocol";
import type {
  WorkflowPrepare,
  WorkflowReady,
  WorkflowTask,
} from "farstep/protocol/workflow/workflow";
import {
  workflowPrepareSchema,
  workflowReadySchema,
  workflowTaskSchema,
} from "farstep/protocol/workflow/workflow";
import { scriptShell } from "farstep/remote/jobs/shell/shell";
import type { ReadinessInput } from "farstep/remote/jobs/workflow/input";
import * as v from "valibot";
import { resolveExecutionCwd } from "../../connections/target";
import type { ExecutionTarget } from "../../connections/types";
import { JOB_RECORD_VERSION } from "../records";
import type { JobSession } from "../session";
import type { BatchInput, LaunchRecord, RunInput, Scope } from "../types";
import { launchEnvironment } from "./environment";

const MAX_LAUNCH_SUFFIX_LENGTH = 24;
const LAUNCH_TOKEN_LENGTH = 16;
const DEFAULT_INITIAL_WAIT_SECONDS = 10;
const DEFAULT_READY_WAIT_SECONDS = 30;

export interface PreparedLaunch {
  scope: Scope;
  client: Gateway;
  intent: LaunchRecord & { workflowFingerprint: string };
  size: ReturnType<typeof parseJobTerminalSize> | undefined;
  waitMs: number;
}

function launchName(
  target: ExecutionTarget,
  scopeId: string,
  owner: string,
  input: { requestId?: string | undefined; name?: string | undefined },
  fallback: string,
): string {
  const token =
    input.requestId === undefined
      ? randomUUID().replaceAll("-", "")
      : createHash("sha256")
          .update(JSON.stringify([scopeId, owner, target.id, input.requestId]))
          .digest("hex");
  const suffix =
    (input.name ?? fallback)
      .replace(/[^A-Za-z0-9._-]/gu, "-")
      .slice(0, MAX_LAUNCH_SUFFIX_LENGTH) || fallback;
  return `${target.backend === "local" ? "local" : "remote"}-${token.slice(0, LAUNCH_TOKEN_LENGTH)}-${suffix}`;
}

function pathAt(target: ExecutionTarget, cwd: string, path: string): string {
  return path.startsWith("~")
    ? resolveExecutionCwd(target, path)
    : posix.resolve(cwd, path);
}

function readySpec(
  target: ExecutionTarget,
  client: Gateway,
  input: RunInput,
  env: Record<string, string>,
  cwd: string,
  ready: ReadinessInput,
): WorkflowReady {
  if (typeof ready === "string")
    return v.parse(workflowReadySchema, { kind: "log", pattern: ready });
  const { timeout, interval, ...condition } = ready;
  let native: Record<string, unknown> = condition;
  switch (condition.kind) {
    case "command": {
      const shell = scriptShell(
        target,
        {
          ...input,
          script: condition.script,
          params: condition.params,
          captureBytes: condition.captureBytes,
        },
        client.scriptRunner,
      );
      native = {
        kind: "command",
        spec: {
          name: "readiness-probe",
          application: shell.application,
          args: shell.args,
          env,
          cwd: condition.cwd ? pathAt(target, cwd, condition.cwd) : cwd,
          pty: false,
          persist: false,
        },
      };
      break;
    }
    case "file":
      native = { ...condition, path: pathAt(target, cwd, condition.path) };
      break;
  }
  return v.parse(workflowReadySchema, {
    ...native,
    timeoutMs: timeout === undefined ? undefined : Math.round(timeout * 1000),
    pollMs: interval === undefined ? undefined : Math.round(interval * 1000),
  });
}

interface RenderedTask {
  task: WorkflowTask;
  command: string;
}

function task(
  target: ExecutionTarget,
  client: Gateway,
  name: string,
  input: RunInput,
  id: string,
  dependsOn: string[],
  defaultPty: boolean,
): RenderedTask {
  const shell = scriptShell(target, input, client.scriptRunner);
  const cwd = resolveExecutionCwd(target, input.cwd);
  const env = launchEnvironment(target, input.environment, client.env);
  const pty = input.pty ?? defaultPty;
  const spec = {
    name,
    application: shell.application,
    args: shell.args,
    env,
    cwd,
    pty,
    persist: false,
  };
  const guards = (
    [
      [input.creates, "missing"],
      [input.removes, "exists"],
    ] as const
  ).flatMap(([path, when]) =>
    path === undefined ? [] : [{ path: pathAt(target, cwd, path), when }],
  );
  const parsed = v.parse(workflowTaskSchema, {
    id,
    dependsOn,
    spec,
    output: typeof input.output === "string" ? { format: input.output } : input.output,
    timeoutSeconds: input.timeout ?? 0,
    guards,
    ...(input.ready !== undefined
      ? { ready: readySpec(target, client, input, env, cwd, input.ready) }
      : {}),
  });
  if (parsed.output.format !== "text" && pty)
    throw new Error("JSON/JSONL output requires pty:false");
  return { command: shell.command, task: parsed };
}

function launchPty(input: RunInput | BatchInput): boolean {
  const format = typeof input.output === "string" ? input.output : input.output?.format;
  const pty = "script" in input ? (input.pty ?? (format ?? "text") === "text") : false;
  return pty;
}

function launchOptions(input: RunInput | BatchInput) {
  return {
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    ...("ready" in input && input.ready !== undefined ? { ready: input.ready } : {}),
  };
}

function launchTerminal(input: RunInput | BatchInput) {
  const pty = launchPty(input);
  if (
    "script" in input &&
    !pty &&
    (input.columns !== undefined || input.rows !== undefined)
  )
    throw new Error("Terminal dimensions require pty:true");
  const size =
    pty && "script" in input
      ? parseJobTerminalSize({
          columns: input.columns ?? JOB_PTY_COLUMNS,
          rows: input.rows ?? JOB_PTY_ROWS,
        })
      : undefined;
  return { pty, size };
}

function mergedStep(
  target: ExecutionTarget,
  input: BatchInput,
  step: BatchInput["steps"][number],
): RunInput {
  return {
    ...step,
    shell: step.shell ?? input.shell,
    login: step.login ?? input.login,
    environment: step.environment ?? input.environment,
    output: step.output ?? input.output,
    env: { ...input.env, ...step.env },
    envFiles: [
      ...(input.envFiles ?? []).map((path) => resolveExecutionCwd(target, path)),
      ...(step.envFiles ?? []),
    ],
    pty: false,
  };
}

function batchTasks(
  target: ExecutionTarget,
  client: Gateway,
  input: BatchInput,
  name: string,
  cwd: string,
): WorkflowTask[] {
  const stepTarget = { ...target, cwd };
  return input.steps.map((step, index) => {
    if (step.pty) throw new Error("Batch steps require pty:false");
    const merged = mergedStep(target, input, step);
    return task(
      stepTarget,
      client,
      `${name}.s${index}`,
      merged,
      step.id,
      step.dependsOn ?? [],
      false,
    ).task;
  });
}

function launchTasks(
  target: ExecutionTarget,
  client: Gateway,
  input: RunInput | BatchInput,
  name: string,
  cwd: string,
  pty: boolean,
) {
  if ("script" in input) {
    const rendered = task(target, client, `${name}.work`, input, "work", [], pty);
    return {
      tasks: [rendered.task],
      description: {
        command: rendered.command,
        interpreter: rendered.task.spec.application,
      },
    };
  }
  return {
    tasks: batchTasks(target, client, input, name, cwd),
    description: {
      command: JSON.stringify(
        input.steps.map(({ id, dependsOn, script, params }) => ({
          id,
          dependsOn,
          script,
          params,
        })),
      ),
      interpreter: target.bash,
    },
  };
}

async function prepared(
  session: JobSession,
  target: ExecutionTarget,
  input: RunInput | BatchInput,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  kind: "job" | "batch",
): Promise<PreparedLaunch> {
  const waitMs = Math.round(
    (input.waitSeconds ??
      ("ready" in input && input.ready
        ? DEFAULT_READY_WAIT_SECONDS
        : DEFAULT_INITIAL_WAIT_SECONDS)) * 1000,
  );
  const scope = session.current(ctx);
  const client = await session.client(scope, target);
  signal?.throwIfAborted();
  const name = launchName(target, scope.scopeId, scope.owner, input, kind);
  const cwd = resolveExecutionCwd(target, input.cwd);
  const { pty, size } = launchTerminal(input);
  const { tasks, description } = launchTasks(target, client, input, name, cwd, pty);
  const request: WorkflowPrepare = v.parse(workflowPrepareSchema, {
    kind,
    requestId: input.requestId,
    root: {
      name,
      cwd,
      env: launchEnvironment(target, input.environment, client.env),
      pty,
      persist:
        (input.lifetime ?? (kind === "batch" ? "persist" : "session")) === "persist",
      ...(size ? { terminalSize: size } : {}),
    },
    tasks,
    concurrency: "steps" in input ? input.concurrency : 1,
    onFailure: "steps" in input ? input.onFailure : "drain",
    timeoutSeconds: input.timeout ?? 0,
  });
  const remote = await client.prepareWorkflow(request, signal);
  signal?.throwIfAborted();
  const intent: PreparedLaunch["intent"] = {
    version: JOB_RECORD_VERSION,
    kind: "launch",
    name: remote.name,
    owner: scope.owner,
    projectDir: scope.projectDir,
    scopeId: scope.scopeId,
    installationId: client.installationId,
    spec: remote.spec,
    connectionId: target.id,
    ...description,
    cwd,
    pty,
    timeoutSeconds: input.timeout ?? 0,
    createdAt: remote.createdAt,
    workflowFingerprint: remote.fingerprint,
    ...launchOptions(input),
  };
  return { scope, client, intent, size, waitMs };
}

export function prepareWorkflowLaunch(
  session: JobSession,
  target: ExecutionTarget,
  input: RunInput,
  ctx: ExtensionContext,
  signal?: AbortSignal,
) {
  return prepared(session, target, input, ctx, signal, "job");
}
export function prepareBatchLaunch(
  session: JobSession,
  target: ExecutionTarget,
  input: BatchInput,
  ctx: ExtensionContext,
  signal?: AbortSignal,
) {
  return prepared(session, target, input, ctx, signal, "batch");
}
