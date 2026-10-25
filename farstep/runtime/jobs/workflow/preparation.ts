import { dirname, join } from "node:path";
import * as v from "valibot";
import {
  workflowNativeSpecSchema,
  workflowPrepareSchema,
} from "#farstep/protocol/workflow/workflow";
import { exists, privateDirectory, privateRead } from "../../state";
import { validateEnvironment } from "../environment";
import { fingerprint, validateSpec, validateWorkflowGraph } from "./manifest";
import {
  initialWorkflowResult,
  requestIndexSchema,
  type WorkflowManifest,
} from "./records";
import {
  immutableWorkflowWrite,
  withWorkflowLock,
  workflowDirectory,
  workflowHash,
  writeWorkflowRecord,
} from "./storage";

export class WorkflowPreparation {
  constructor(
    private readonly directory: string,
    private readonly scopeId: string,
    private readonly owner: string,
    private readonly installationId: string,
    private readonly baselineEnv: Record<string, string>,
    private readonly load: (
      name: string,
    ) => Promise<{ directory: string; manifest: WorkflowManifest }>,
  ) {}

  private async preparedRequest(
    index: string | undefined,
    name: string,
    digest: string,
  ) {
    if (!index || !(await exists(index))) return undefined;
    const original = v.parse(requestIndexSchema, JSON.parse(await privateRead(index)));
    if (original.name !== name || original.fingerprint !== digest)
      throw new Error("Workflow request ID was already used with a different payload");
    const { manifest } = await this.load(original.name);
    if (manifest.prepared.fingerprint !== digest)
      throw new Error("Workflow request index identity mismatch");
    return manifest.prepared;
  }

  async prepare(value: unknown) {
    const input = v.parse(workflowPrepareSchema, value);
    validateWorkflowGraph(input);
    validateEnvironment(input.root.env, this.baselineEnv, "Workflow");
    for (const task of input.tasks) {
      validateSpec(task.spec, this.baselineEnv);
      if (task.ready?.kind === "command") {
        validateSpec(task.ready.spec, this.baselineEnv);
        if (task.ready.spec.pty) throw new Error("Readiness commands cannot use a PTY");
      }
    }
    const digest = fingerprint(input, this.scopeId, this.owner, this.installationId);
    const directory = await workflowDirectory(this.directory, input.root.name);
    const root = dirname(directory);
    const requests = join(root, "requests");
    await privateDirectory(requests);
    return withWorkflowLock(root, "prepare", () =>
      withWorkflowLock(directory, "mutation", async () => {
        const index = input.requestId
          ? join(requests, `${workflowHash(input.requestId)}.json`)
          : undefined;
        const original = await this.preparedRequest(index, input.root.name, digest);
        if (original) return original;
        const record = join(directory, "manifest.json");
        if (await exists(record)) {
          const { manifest } = await this.load(input.root.name);
          if (manifest.prepared.fingerprint !== digest)
            throw new Error(
              "Workflow name was already prepared with a different payload",
            );
          if (
            !(await exists(join(directory, "journal.json"))) &&
            !(await exists(join(directory, "start.json")))
          )
            await writeWorkflowRecord(join(directory, "journal.json"), {
              phase: "prepared",
              result: initialWorkflowResult(manifest),
            });
          if (index)
            await immutableWorkflowWrite(index, {
              name: input.root.name,
              fingerprint: digest,
            });
          return manifest.prepared;
        }
        const launcherArgs = Bun.main.startsWith("/$bunfs/") ? [] : [Bun.main];
        const spec = v.parse(workflowNativeSpecSchema, {
          ...input.root,
          application: process.execPath,
          args: [...launcherArgs, "workflow", "--record", record],
        });
        const manifest: WorkflowManifest = {
          scopeId: this.scopeId,
          owner: this.owner,
          installationId: this.installationId,
          input,
          prepared: {
            spec,
            name: input.root.name,
            fingerprint: digest,
            createdAt: Date.now(),
          },
        };
        await immutableWorkflowWrite(record, manifest);
        await writeWorkflowRecord(join(directory, "journal.json"), {
          phase: "prepared",
          result: initialWorkflowResult(manifest),
        });
        if (index)
          await immutableWorkflowWrite(index, {
            name: input.root.name,
            fingerprint: digest,
          });
        return manifest.prepared;
      }),
    );
  }
}
