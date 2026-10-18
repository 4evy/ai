import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DepGraph } from "dependency-graph";
import type { JobSpec } from "farstep/protocol/jobs/protocol";
import canonical from "fast-json-stable-stringify";
import * as v from "valibot";
import type { WorkflowPrepare } from "#farstep/protocol/workflow/workflow";
import { privateDirectory, privateRead } from "../../state";
import { validateEnvironment } from "../environment";
import { validateReadiness } from "./policy";

import {
  identityShape,
  type WorkflowManifest,
  workflowManifestSchema,
} from "./records";
import { workflowHash } from "./storage";

export function validateWorkflowGraph(input: WorkflowPrepare): void {
  if (input.kind === "job" && (input.tasks.length !== 1 || input.concurrency !== 1))
    throw new Error("Single jobs require exactly one step and concurrency one");
  if (input.kind === "batch" && input.root.pty)
    throw new Error("Workflow batches cannot use a PTY");
  if (input.root.terminalSize && !input.root.pty)
    throw new Error("Workflow terminal size requires a PTY");
  const tasks = new Map(input.tasks.map((task) => [task.id, task]));
  if (tasks.size !== input.tasks.length)
    throw new Error("Workflow step IDs must be unique");
  const graph = new DepGraph();
  for (const id of tasks.keys()) graph.addNode(id);
  for (const [id, task] of tasks) {
    if (id === "." || id === "..") throw new Error("Invalid workflow step ID");
    if (new Set(task.dependsOn).size !== task.dependsOn.length)
      throw new Error(`Duplicate dependencies for workflow step ${id}`);
    if (task.spec.pty !== input.root.pty)
      throw new Error("Workflow step PTY must match the root");
    if (input.root.pty && task.output.format !== "text")
      throw new Error("JSON and JSONL output require non-PTY execution");
    if (task.ready) validateReadiness(task.ready);
    for (const dependency of task.dependsOn) {
      if (!graph.hasNode(dependency))
        throw new Error(`Unknown workflow dependency: ${dependency}`);
      graph.addDependency(id, dependency);
    }
  }
  graph.overallOrder();
}

export async function readWorkflowManifest(path: string): Promise<WorkflowManifest> {
  if (resolve(path) !== path || !path.endsWith("/manifest.json"))
    throw new Error("Invalid private workflow manifest path");
  const directory = dirname(path);
  const root = dirname(directory);
  const scope = dirname(root);
  for (const parent of [scope, root, directory]) {
    await privateDirectory(parent);
    if ((await realpath(parent)) !== parent)
      throw new Error("Workflow manifest directory is not canonical");
  }
  if (root !== join(scope, "workflows"))
    throw new Error("Invalid workflow manifest root");
  const manifest = v.parse(workflowManifestSchema, JSON.parse(await privateRead(path)));
  const metadata = v.parse(
    v.strictObject(identityShape),
    JSON.parse(await privateRead(join(scope, "scope.json"))),
  );
  if (
    metadata.scopeId !== manifest.scopeId ||
    metadata.owner !== manifest.owner ||
    metadata.installationId !== manifest.installationId ||
    directory !== join(root, workflowHash(manifest.prepared.name)) ||
    manifest.input.root.name !== manifest.prepared.name
  )
    throw new Error("Workflow manifest scope or owner mismatch");
  if (
    fingerprint(
      manifest.input,
      manifest.scopeId,
      manifest.owner,
      manifest.installationId,
    ) !== manifest.prepared.fingerprint
  )
    throw new Error("Workflow manifest fingerprint mismatch");
  validateWorkflowGraph(manifest.input);
  return manifest;
}

export function fingerprint(
  input: WorkflowPrepare,
  scopeId: string,
  owner: string,
  installationId: string,
): string {
  // Validated JSON inputs retain the persisted lexical order, including numeric keys
  return workflowHash(canonical({ installationId, scopeId, owner, input }));
}

export function validateSpec(spec: JobSpec, baseline: Record<string, string>): void {
  if (
    !spec.application.startsWith("/") ||
    !spec.cwd.startsWith("/") ||
    spec.ready ||
    [spec.application, spec.cwd, ...spec.args].some((value) => value.includes("\0"))
  )
    throw new Error("Invalid managed workflow child specification");
  validateEnvironment(spec.env, baseline, "Workflow");
}

export function assertWorkflowSpec(actual: JobSpec, expected: JobSpec): void {
  if (
    actual.application !== expected.application ||
    !isDeepStrictEqual(actual.args, expected.args) ||
    actual.cwd !== expected.cwd ||
    !isDeepStrictEqual(actual.env, expected.env) ||
    actual.pty !== expected.pty
  )
    throw new Error("Workflow name is occupied by a different native launch");
}
