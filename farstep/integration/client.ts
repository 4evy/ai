import { hash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { atomicWrite, syncDirectoryAncestors } from "@ai/core/effect/fs/fs";
import { Effect } from "effect";
import * as v from "valibot";
import type { Gateway } from "../client/jobs/gateway";
import { JobRoutes, type JobScope, recoverJob } from "../client/jobs/recovery";
import { type JobSpec, jobSpecSchema } from "../protocol/jobs/protocol";
import { scriptFields } from "../protocol/script/script";
import { scriptShell } from "../remote/jobs/shell/shell";
import {
  connectionInputSchema,
  type ToolConnection,
  toolConnection,
} from "./connection";

const name = v.pipe(v.string(), v.regex(/^[A-Za-z0-9._-]{1,128}$/u));
const sha256 = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u));
export const launchInputSchema = v.strictObject({
  name,
  ...scriptFields,
  pty: v.optional(v.boolean(), false),
  environment: v.optional(v.picklist(["shared", "inherit"]), "shared"),
  ready: v.optional(
    v.strictObject({
      log: v.optional(v.string()),
      port: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535)),
      ),
      host: v.optional(v.literal("127.0.0.1")),
      timeoutMs: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(3_600_000)),
        30_000,
      ),
    }),
  ),
});
export const toolRequestSchema = v.variant("action", [
  v.strictObject({ action: v.literal("connect"), ...connectionInputSchema.entries }),
  v.strictObject({ action: v.literal("reconnect") }),
  v.strictObject({ action: v.literal("launch"), ...launchInputSchema.entries }),
  v.strictObject({ action: v.literal("observe"), name }),
  v.strictObject({ action: v.literal("stop"), name }),
  v.strictObject({
    action: v.literal("forward"),
    name,
    localPort: v.pipe(v.number(), v.integer(), v.minValue(1024), v.maxValue(65535)),
  }),
  v.strictObject({
    action: v.literal("retrieve"),
    name,
    source: v.pipe(v.string(), v.startsWith("/")),
    destination: v.string(),
    expectedSha256: v.nullable(sha256),
  }),
]);
export type ToolRequest = v.InferOutput<typeof toolRequestSchema>;
const stateSchema = v.strictObject({
  connection: connectionInputSchema,
  scope: sha256,
  owner: v.pipe(v.string(), v.regex(/^remote:cli:[a-f0-9-]{36}$/u)),
  installationId: v.string(),
});
const recordSchema = v.strictObject({
  name,
  spec: jobSpecSchema,
  nativeId: v.optional(v.string()),
  scopeId: sha256,
  owner: v.string(),
  projectDir: v.string(),
  connectionId: v.string(),
  installationId: v.string(),
  startedAt: v.optional(v.number()),
  nativeCreatedAt: v.optional(v.number()),
});
type State = v.InferOutput<typeof stateSchema>;
type JobRecord = v.InferOutput<typeof recordSchema>;

async function checkStateDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error(
      "CLI state directory must be private and owned by the current user",
    );
}

async function readState(path: string): Promise<string> {
  await using file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const info = await file.stat();
  if (
    !info.isFile() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0 ||
    info.nlink !== 1
  )
    throw new Error(
      "CLI state file must be private, regular and owned by the current user",
    );
  return await file.readFile("utf8");
}

async function reserveState(path: string, value: unknown): Promise<void> {
  await using file = await open(path, "wx", 0o600);
  await file.writeFile(JSON.stringify(value));
  await file.sync();
  await syncDirectoryAncestors(dirname(path), 2);
}

async function openGateway(
  connection: ToolConnection,
  scopeId: string,
  owner: string,
  installationId?: string,
): Promise<ClientRoute> {
  const scope: JobScope = { scopeId, owner, projectDir: connection.target.cwd };
  const active = { closed: false, failure: undefined as unknown };
  const assertCurrent = (current: JobScope) => {
    if (active.closed || current !== scope)
      throw new Error("CLI route was released. No operations were replayed");
    if (active.failure !== undefined) throw active.failure;
  };
  const routes = new JobRoutes<JobScope, ToolConnection>({
    isCurrent: (current) => !active.closed && current === scope,
    assertCurrent,
    address: (target) => [target.input.target, target.input.cwd],
    project: (target) => target.target.cwd,
    transport: (target, current) =>
      Effect.succeed(target.gateway(current.scopeId, current.owner)),
    failure: (_scope, _connection, error) => {
      active.failure = error;
    },
    closeFailure: (error) => {
      console.error(error);
    },
  });
  try {
    const gateway =
      installationId === undefined
        ? await routes.client(scope, connection)
        : await routes.recover(
            scope,
            { ...scope, connectionId: connection.input.target, installationId },
            async () => connection,
          );
    return { gateway, routes, scope, active, assertCurrent };
  } catch (error) {
    active.closed = true;
    await routes.release();
    throw error;
  }
}

interface ClientRoute {
  gateway: Gateway;
  routes: JobRoutes<JobScope, ToolConnection>;
  scope: JobScope;
  active: { closed: boolean; failure: unknown };
  assertCurrent(scope: JobScope): void;
}

export class ToolClient implements AsyncDisposable {
  readonly gateway: Gateway;
  private constructor(
    readonly directory: string,
    readonly state: State,
    readonly connection: ToolConnection,
    private readonly route: ClientRoute,
  ) {
    this.gateway = route.gateway;
  }

  static async connect(
    directory: string,
    input: v.InferOutput<typeof connectionInputSchema>,
  ) {
    directory = resolve(directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await checkStateDirectory(directory);
    const connection = await toolConnection(input);
    const owner = `remote:cli:${randomUUID()}`;
    const scope = hash("sha256", JSON.stringify([input, owner]));
    const route = await openGateway(connection, scope, owner);
    try {
      const state = {
        connection: input,
        scope,
        owner,
        installationId: route.gateway.installationId,
      };
      await reserveState(join(directory, "connection.json"), state);
      return new ToolClient(directory, state, connection, route);
    } catch (error) {
      route.active.closed = true;
      await route.routes.release();
      throw error;
    }
  }

  static async reconnect(directory: string) {
    directory = resolve(directory);
    await checkStateDirectory(directory);
    const state = v.parse(
      stateSchema,
      JSON.parse(await readState(join(directory, "connection.json"))),
    );
    const connection = await toolConnection(state.connection);
    const route = await openGateway(
      connection,
      state.scope,
      state.owner,
      state.installationId,
    );
    return new ToolClient(directory, state, connection, route);
  }

  identity() {
    return {
      state: this.directory,
      target: this.state.connection.target,
      scopeId: this.state.scope,
      owner: this.state.owner,
      installationId: this.state.installationId,
    };
  }

  private recordPath(job: string) {
    return join(this.directory, `${v.parse(name, job)}.json`);
  }

  private async save(job: string, record: JobRecord) {
    await atomicWrite(this.recordPath(job), JSON.stringify(record));
    await syncDirectoryAncestors(this.directory, 2);
  }

  async inspect(job: string) {
    const record = v.parse(
      recordSchema,
      JSON.parse(await readState(this.recordPath(job))),
    );
    if (record.name !== job || record.spec.name !== job)
      throw new Error("Stored job name changed");
    const recovered = await recoverJob(this.route.scope, this.gateway, record, () =>
      this.route.assertCurrent(this.route.scope),
    );
    if (record.nativeId === undefined)
      await this.save(job, { ...record, ...recovered.identity });
    return { snapshot: recovered.snapshot, spec: record.spec };
  }

  async launch(input: v.InferOutput<typeof launchInputSchema>) {
    const rendered = scriptShell(
      this.connection.target,
      input,
      this.gateway.scriptRunner,
    );
    const spec: JobSpec = v.parse(jobSpecSchema, {
      name: input.name,
      application: rendered.application,
      args: rendered.args,
      cwd: this.connection.target.cwd,
      env: this.gateway.env,
      pty: input.pty,
      persist: true,
      ...(input.ready
        ? {
            ready: {
              ...input.ready,
              ...(input.ready.port ? { host: "127.0.0.1" } : {}),
            },
          }
        : {}),
    });
    // Reserve the name durably before start. A lost reply is inspected, never replayed
    const record: JobRecord = {
      ...this.route.scope,
      name: input.name,
      spec,
      connectionId: this.state.connection.target,
      installationId: this.state.installationId,
    };
    await reserveState(this.recordPath(input.name), record);
    await this.gateway.openCoordination(
      {
        project: this.route.scope.projectDir,
        sessionId: "cli",
        agentId: this.state.owner.slice("remote:cli:".length),
      },
      (error) => {
        this.route.active.failure = error;
      },
    );
    const started = await this.gateway.request({
      op: "start",
      spec,
      owner: this.state.owner,
    });
    await this.save(input.name, {
      ...record,
      nativeId: started.snapshot.id,
      startedAt: started.snapshot.startedAt,
      nativeCreatedAt: started.snapshot.createdAt,
    });
    return { ...this.identity(), ...started };
  }

  async observe(job: string) {
    const described = await this.inspect(job);
    const output = await this.gateway.request({
      op: "logs",
      name: job,
      lines: 1000,
      head: false,
      follow: false,
      timeoutMs: 0,
    });
    return { ...this.identity(), ...described, output };
  }

  async stop(job: string) {
    const { snapshot } = await this.inspect(job);
    return this.gateway.terminate({
      name: job,
      nativeId: snapshot.id,
      actionId: randomUUID(),
      kind: "stop",
      timeoutMs: 2000,
    });
  }

  [Symbol.asyncDispose]() {
    this.route.active.closed = true;
    return this.route.routes.release();
  }
}
