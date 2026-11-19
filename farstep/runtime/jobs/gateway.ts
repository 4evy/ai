import { join } from "node:path";
import { readText } from "@ai/toolkit/text/text";
import { COORDINATION_CAPABILITY } from "farstep/protocol/coordination";
import { type JobOperation, jobOperationSchema } from "farstep/protocol/jobs/protocol";
import { SYSTEM_CAPABILITY } from "farstep/protocol/system";
import * as v from "valibot";
import {
  actionRequestSchema,
  JOB_CAPABILITIES,
  jobIdentitySchema,
  observeRequestSchema,
  prepareStartRequestSchema,
  receiptRequestSchema,
  SCRIPT_CAPABILITY,
  type ScriptRunner,
  terminationRequestSchema,
} from "#farstep/protocol/jobs/gateway";
import {
  WORKFLOW_CAPABILITY,
  workflowCancelSchema,
  workflowInspectSchema,
  workflowPrepareSchema,
  workflowStartSchema,
} from "#farstep/protocol/workflow/workflow";
import type { CoordinationRegistry } from "../coordination/registry";
import { exists, PROTOCOL_MAJOR, paths, VERSION, withMaintenanceLock } from "../state";
import type { JobActions } from "./actions";
import type { JobBrokerClient } from "./broker/client";
import type { CompletionChannel } from "./completion";
import { bindDeadline, deadlineEvidence, prepareDeadline } from "./deadline";
import { validateEnvironment } from "./environment";
import { scriptActivation, scriptRunner, verifyScriptRunner } from "./script/runner";
import type { ToolRegistrar } from "./tools";
import type { WorkflowService } from "./workflow/workflow";

export interface JobScope {
  directory: string;
  scopeId: string;
  owner: string;
  installationId: string;
  env: Record<string, string>;
}

function result(value: Record<string, unknown>) {
  return {
    content: [],
    structuredContent: value,
  };
}

function assertManagedLaunch(
  request: JobOperation,
  owner: string,
  env: Record<string, string>,
): asserts request is Extract<JobOperation, { op: "start" }> {
  if (
    request.op !== "start" ||
    request.owner !== owner ||
    !request.spec.cwd.startsWith("/") ||
    !request.spec.application.startsWith("/")
  )
    throw new Error("Invalid managed remote launch specification");
  validateEnvironment(request.spec.env, env, "Job");
}

function operation(value: unknown): JobOperation {
  return v.parse(jobOperationSchema, value);
}

const MUTATING_OPERATIONS = new Set<JobOperation["op"]>(["send", "stop", "mode"]);

export class JobGateway {
  #verifiedRunner: { generation: string; result: Promise<ScriptRunner> } | undefined;

  private async runner(): Promise<ScriptRunner> {
    const current = await scriptRunner();
    if (this.#verifiedRunner?.generation !== current.generation)
      this.#verifiedRunner = {
        generation: current.generation,
        result: verifyScriptRunner(current.packagePath ?? undefined),
      };
    return this.#verifiedRunner.result;
  }

  constructor(
    private readonly scope: JobScope,
    private readonly broker: JobBrokerClient,
    private readonly coordination: CoordinationRegistry,
    private readonly actions: JobActions,
    private readonly workflows: WorkflowService,
    private readonly completion: CompletionChannel,
  ) {}

  registerHandshake(register: ToolRegistrar): void {
    register("helper.handshake", { inputSchema: v.object({}) }, async () => {
      // A broken runner must not prevent recovery of already-owned jobs
      const scriptsReady = await this.runner().then(
        () => true,
        () => false,
      );
      this.completion.subscribe();
      return result({
        protocolMajor: PROTOCOL_MAJOR,
        version: VERSION,
        installationId: this.scope.installationId,
        platform: process.platform,
        capabilities: [
          ...JOB_CAPABILITIES.filter(
            (capability) => scriptsReady || capability !== SCRIPT_CAPABILITY,
          ),
          WORKFLOW_CAPABILITY,
          COORDINATION_CAPABILITY,
          SYSTEM_CAPABILITY,
        ],
      });
    });
    register(
      "job.environment",
      { inputSchema: v.object({ launch: v.optional(v.boolean(), true) }) },
      async ({ launch }, signal) => {
        if (!launch)
          return result({
            env: this.scope.env,
            scriptRunner: { application: process.execPath },
          });
        const scriptRunner = await this.runner();
        return result({
          env: this.scope.env,
          scriptRunner,
          activation: await scriptActivation(scriptRunner, true, { signal }),
        });
      },
    );
    register("job.activation", { inputSchema: v.object({}) }, async (_input, signal) =>
      result({
        activation: await scriptActivation(await scriptRunner(), false, { signal }),
      }),
    );
    register(
      "job.ack_completion",
      { inputSchema: v.object({ completionId: v.pipe(v.string(), v.minLength(1)) }) },
      async ({ completionId }) => {
        this.completion.acknowledge(completionId);
        return result({ accepted: true });
      },
    );
  }

  registerWorkflows(register: ToolRegistrar): void {
    const routes = [
      [
        "job.workflow_prepare",
        workflowPrepareSchema,
        (input: unknown, _signal?: AbortSignal) => this.workflows.prepare(input),
      ],
      [
        "job.workflow_start",
        workflowStartSchema,
        (input: unknown, signal?: AbortSignal) => this.startWorkflow(input, signal),
      ],
      [
        "job.workflow_inspect",
        workflowInspectSchema,
        (input: unknown, _signal?: AbortSignal) => this.workflows.inspect(input),
      ],
      [
        "job.workflow_cancel",
        workflowCancelSchema,
        (input: unknown, _signal?: AbortSignal) => this.workflows.cancel(input),
      ],
    ] as const;
    for (const [name, schema, handle] of routes)
      register(name, { inputSchema: v.object(schema.entries) }, async (input, signal) =>
        result(await handle(v.parse(schema, input), signal)),
      );
  }

  private async startWorkflow(input: unknown, signal?: AbortSignal) {
    const started = await this.workflows.start(
      input,
      (spec) =>
        this.coordination.beginJob({
          name: spec.name,
          cwd: spec.cwd,
          kind: "workflow",
          lifetime: spec.persist ? "persist" : "session",
        }),
      signal,
    );
    if ("outcome" in started) return started;
    await this.coordination.observeJob(started.snapshot);
    return started;
  }

  registerActions(register: ToolRegistrar): void {
    register(
      "job.observe",
      { inputSchema: v.object(observeRequestSchema.entries) },
      async (input) => {
        const observed = await this.actions.observe(input);
        await this.coordination.observeJob(observed.snapshot);
        return result(observed);
      },
    );
    register(
      "job.action",
      {
        inputSchema: v.object(actionRequestSchema.entries),
        description: readText(new URL("./jobs.md", import.meta.url), "receipts"),
      },
      async (input) => {
        return result(await this.actions.action(input));
      },
    );
    register(
      "job.receipt",
      { inputSchema: v.object(receiptRequestSchema.entries) },
      async (input) => {
        return result(await this.actions.receipt(input));
      },
    );
    register(
      "job.terminate",
      { inputSchema: v.object(terminationRequestSchema.entries) },
      async (input) => {
        return result(await this.actions.terminate(input));
      },
    );
  }

  registerControl(register: ToolRegistrar): void {
    register(
      "job.termination",
      { inputSchema: v.object(jobIdentitySchema.entries) },
      async (input) => this.termination(input),
    );
    register(
      "job.prepare_start",
      { inputSchema: v.object(prepareStartRequestSchema.entries) },
      async (input) => this.prepare(input),
    );
    register(
      "job.request",
      { inputSchema: v.object({ operation: v.unknown() }) },
      async (input) => this.request(input.operation),
    );
  }

  private async termination({
    name,
    nativeId,
  }: v.InferOutput<typeof jobIdentitySchema>) {
    const described = await this.broker.request({ op: "describe", name });
    if (
      described.snapshot.owner !== this.scope.owner ||
      described.snapshot.id !== nativeId
    )
      throw new Error("Job identity or remote owner mismatch");
    await bindDeadline(
      this.scope.directory,
      described.spec,
      nativeId,
      this.scope.installationId,
      this.scope.scopeId,
      this.scope.owner,
    );
    return result({
      termination: await this.actions.termination(name, nativeId),
      deadline: await deadlineEvidence(
        this.scope.directory,
        name,
        nativeId,
        this.scope.installationId,
        this.scope.scopeId,
        this.scope.owner,
      ),
    });
  }

  private async prepare(input: v.InferOutput<typeof prepareStartRequestSchema>) {
    const { operation: value, deadlineSeconds } = v.parse(
      prepareStartRequestSchema,
      input,
    );
    const request = operation(value);
    assertManagedLaunch(request, this.scope.owner, this.scope.env);
    return withMaintenanceLock(async () =>
      result({
        spec: await prepareDeadline(
          this.scope.directory,
          this.scope.scopeId,
          this.scope.owner,
          this.scope.installationId,
          request.spec,
          deadlineSeconds,
        ),
      }),
    );
  }

  private async start(request: Extract<JobOperation, { op: "start" }>) {
    const spec = request.spec;
    return withMaintenanceLock(async () => {
      if (!(await exists(join(paths().state, "installer.json"))))
        throw new Error("Helper is not activated; managed launches are disabled");
      await this.coordination.beginJob({
        name: spec.name,
        cwd: spec.cwd,
        kind: "command",
        lifetime: spec.persist ? "persist" : "session",
      });
      const response = await this.broker.request(request);
      await bindDeadline(
        this.scope.directory,
        spec,
        response.snapshot.id,
        this.scope.installationId,
        this.scope.scopeId,
        this.scope.owner,
      );
      await this.coordination.observeJob(response.snapshot);
      return result(response);
    });
  }

  private async request(value: unknown) {
    const request = operation(value);
    if (request.op === "start") {
      assertManagedLaunch(request, this.scope.owner, this.scope.env);
      return this.start(request);
    }
    if ("name" in request) {
      const described = await this.broker.request({
        op: "describe",
        name: request.name,
      });
      if (described.snapshot.owner !== this.scope.owner)
        throw new Error("Job belongs to another remote owner");
    }
    const response =
      "name" in request && MUTATING_OPERATIONS.has(request.op)
        ? await this.actions.mutate(
            request.name,
            (await this.actions.bind(request.name)).id,
            () => this.broker.request(request),
          )
        : await this.broker.request(request);
    let snapshots = "snapshot" in response ? [response.snapshot] : [];
    if (response.op === "list") {
      response.snapshots = response.snapshots.filter(
        (snapshot) => snapshot.owner === this.scope.owner,
      );
      snapshots = response.snapshots;
    }
    for (const snapshot of snapshots) await this.coordination.observeJob(snapshot);
    return result(response);
  }
}
