import { hash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { link, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { attempt, Lifetime } from "@ai/runtime/effect/effect";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { isEexist, isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { Effect } from "effect";
import type { CoordinationJob } from "farstep/protocol/coordination";
import { uuidSchema } from "farstep/protocol/identity";
import { JOB_STATE_POLICY } from "farstep/protocol/jobs/states";
import { BoundedFrames } from "farstep/transport/bounds";
import * as v from "valibot";
import { CoordinationRegistry } from "../coordination/registry";
import { brokerRoot } from "../platform/processes";
import {
  loadIdentity,
  MAX_REQUEST_BYTES,
  paths,
  privateDirectory,
  privateRead,
  VERSION,
} from "../state";
import { registerSystemTools } from "../system/tools";
import { JobActions } from "./actions";
import { createJobBrokerClient, type JobBrokerClient } from "./broker/client";
import { CompletionChannel } from "./completion";
import { executionEnvironment } from "./environment";
import { JobGateway } from "./gateway";
import { guardTools, serveStdio, toolRegistry } from "./tools";
import { WorkflowService } from "./workflow/workflow";

const scopeSchema = v.strictObject({
  scopeId: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
  owner: v.pipe(v.string(), v.regex(/^remote:[^\0]+:[^\0]+$/u)),
  installationId: uuidSchema,
});

export async function brokerDirectory(directory: string): Promise<string> {
  const root = brokerRoot();
  await privateDirectory(root);
  const runtime = join(root, hash("sha256", directory));
  await privateDirectory(runtime);
  return runtime;
}

export async function verifyBrokerRuntime(): Promise<void> {
  const directory = join(paths().state, "health");
  await privateDirectory(directory);
  const canonical = await realpath(directory);
  const broker = await createJobBrokerClient(canonical, {
    runtimeDir: await brokerDirectory(canonical),
  });
  try {
    const response = await broker.request({ op: "ping" });
    if (response.projectDir !== canonical)
      throw new Error("Packaged broker health identity mismatch");
  } finally {
    broker.close();
  }
}

async function scopeDirectory(scopeId: string, owner: string): Promise<string> {
  const { installationId } = await loadIdentity();
  const metadata = v.parse(scopeSchema, { scopeId, owner, installationId });
  const root = join(await realpath(paths().state), "scopes");
  await privateDirectory(root);
  const directory = join(root, scopeId);
  await privateDirectory(directory);
  if ((await realpath(directory)) !== directory)
    throw new Error("Broker scope must be a canonical private directory");
  const file = join(directory, "scope.json");
  const temporary = join(directory, `.scope-${randomUUID()}`);
  try {
    await writeFile(temporary, JSON.stringify(metadata), { flag: "wx", mode: 0o600 });
    await link(temporary, file);
  } catch (error) {
    if (!isEexist(error)) throw error;
    const existing = v.parse(scopeSchema, JSON.parse(await privateRead(file)));
    if (
      existing.owner !== owner ||
      existing.scopeId !== scopeId ||
      existing.installationId !== installationId
    )
      throw new Error("Broker scope identity mismatch");
  } finally {
    await rm(temporary, { force: true });
  }
  return directory;
}

export async function inspectBusyJobs(): Promise<boolean> {
  const root = join(paths().state, "scopes");
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
  await privateDirectory(root);
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/u.test(entry.name))
      throw new Error("Unexpected entry in private broker scopes");
    const directory = join(root, entry.name);
    await privateDirectory(directory);
    const metadata = v.parse(
      scopeSchema,
      JSON.parse(await privateRead(join(directory, "scope.json"))),
    );
    if (metadata.scopeId !== entry.name)
      throw new Error("Broker scope directory identity mismatch");
    const broker = await createJobBrokerClient(directory, {
      runtimeDir: await brokerDirectory(directory),
    });
    try {
      const result = await broker.request({ op: "list" });
      if (
        result.snapshots.some(
          (snapshot) => !JOB_STATE_POLICY[snapshot.state].exitObserved,
        )
      )
        return true;
    } finally {
      broker.close();
    }
  }
  return false;
}

async function refreshCoordinationJob(
  coordination: CoordinationRegistry,
  client: JobBrokerClient,
  job: CoordinationJob,
): Promise<void> {
  try {
    const response = await client.request({ op: "describe", name: job.name });
    await coordination.observeJob(response.snapshot, job);
  } catch {
    await coordination.unavailableJob(
      job,
      "Native job could not be verified; execution outcome is unknown",
    );
  }
}

async function refreshCoordinationScope(
  coordination: CoordinationRegistry,
  scopeId: string,
  records: CoordinationJob[],
): Promise<void> {
  let client: JobBrokerClient | undefined;
  try {
    const directory = join(await realpath(paths().state), "scopes", scopeId);
    if ((await realpath(directory)) !== directory)
      throw new Error("Coordination scope is not canonical");
    await privateDirectory(directory);
    const metadata = v.parse(
      scopeSchema,
      JSON.parse(await privateRead(join(directory, "scope.json"))),
    );
    if (
      metadata.scopeId !== scopeId ||
      records.some(
        (job) =>
          job.owner !== metadata.owner ||
          job.installationId !== metadata.installationId,
      )
    )
      throw new Error("Coordination scope identity mismatch");
    client = await createJobBrokerClient(directory, {
      runtimeDir: await brokerDirectory(directory),
    });
    for (const job of records) {
      await refreshCoordinationJob(coordination, client, job);
    }
  } catch {
    for (const job of records)
      await coordination.unavailableJob(
        job,
        "Native scope could not be verified; execution outcome is unknown",
      );
  } finally {
    client?.close();
  }
}

async function refreshCoordinationJobs(
  coordination: CoordinationRegistry,
  jobs: CoordinationJob[],
): Promise<void> {
  const scopes = Map.groupBy(
    jobs.values().filter((job) => job.state !== "stopped" && job.state !== "failed"),
    (job) => job.scopeId,
  );
  for (const [scopeId, records] of scopes) {
    await refreshCoordinationScope(coordination, scopeId, records);
  }
}

export async function runJobs(scopeId: string, owner: string): Promise<void> {
  await using lifetime = new Lifetime("sequential");
  const directory = await scopeDirectory(scopeId, owner);
  const identity = await loadIdentity();
  const broker = await lifetime.run(
    Effect.acquireRelease(
      attempt(async () =>
        createJobBrokerClient(directory, {
          runtimeDir: await brokerDirectory(directory),
        }),
      ),
      (client) => Effect.sync(() => client.close()),
    ),
  );
  const coordination = await lifetime.run(
    Effect.acquireRelease(
      attempt(() =>
        CoordinationRegistry.create({
          owner,
          scopeId,
          installationId: identity.installationId,
        }),
      ),
      (registry) => attempt(() => registry.close()).pipe(Effect.orDie),
    ),
  );
  const actions = new JobActions(
    broker,
    directory,
    scopeId,
    owner,
    identity.installationId,
  );
  const server = await lifetime.run(
    Effect.acquireRelease(
      Effect.sync(() => new Server({ name: "farstep-jobs", version: VERSION })),
      (connected) => attempt(() => connected.close()).pipe(Effect.orDie),
    ),
  );
  const register = toolRegistry(server, lifetime);
  const completion = new CompletionChannel(broker, coordination, server, owner);
  server.onclose = () => completion.close();
  const env = executionEnvironment();
  const workflows = new WorkflowService(
    broker,
    directory,
    scopeId,
    owner,
    identity.installationId,
    env,
  );
  const gateway = new JobGateway(
    { directory, scopeId, owner, installationId: identity.installationId, env },
    broker,
    coordination,
    actions,
    workflows,
    completion,
  );
  gateway.registerHandshake(register);
  const requireHandshake = () => completion.requireHandshake();
  registerSystemTools(register, requireHandshake, completion.disconnected.signal);
  coordination.register(register, requireHandshake, (jobs) =>
    refreshCoordinationJobs(coordination, jobs),
  );
  const guarded = guardTools(register, requireHandshake);
  gateway.registerWorkflows(guarded);
  gateway.registerActions(guarded);
  gateway.registerControl(guarded);
  const bounded = new BoundedFrames(MAX_REQUEST_BYTES, "MCP request exceeds 1 MiB");
  await serveStdio(
    server,
    bounded,
    () => completion.wait(),
    () => completion.close(),
  );
}
