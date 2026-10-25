import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createShellRenderer } from "@oh-my-pi/pi-tui/tools/bash";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { remoteDefinitions } from "farstep/remote/remote";
import { scriptArguments } from "farstep/remote/tools/shell";
import { compileTool, registerCompiledTool } from "#apps/omp/lib/schema/tool";
import type { Connections } from "../connections/state";
import type { RemoteJobs } from "../jobs/jobs";
import { jobPresentation } from "../jobs/presentation";
import type { Result } from "../jobs/types";

const MAX_BATCH_PREVIEW_STEPS = 128;

function batchPreview(input: unknown): string | undefined {
  if (!isRecord(input) || !Array.isArray(input.steps)) return undefined;
  const concurrency = typeof input.concurrency === "number" ? input.concurrency : 1;
  const onFailure = typeof input.onFailure === "string" ? input.onFailure : "drain";
  const rootEnv = isRecord(input.env) ? input.env : {};
  const rootShell = "shell" in input ? input.shell : undefined;
  return [
    "# Batch plan: separate scripts managed as dependency steps",
    `# concurrency: ${concurrency}; onFailure: ${onFailure}`,
    ...input.steps.slice(0, MAX_BATCH_PREVIEW_STEPS).flatMap((step, index) => {
      if (!isRecord(step)) return [`# Step ${index + 1}`];
      const id = "id" in step ? JSON.stringify(step.id) : String(index + 1);
      const dependencies = "dependsOn" in step ? JSON.stringify(step.dependsOn) : "[]";
      const stepEnv = isRecord(step.env) ? step.env : {};
      const shell =
        "shell" in step && step.shell !== undefined ? step.shell : rootShell;
      return [
        `# Step ${id}; dependsOn ${dependencies}`,
        scriptArguments.resolveCommand({
          ...input,
          ...step,
          shell,
          env: { ...rootEnv, ...stepEnv },
        }) ?? "(script pending)",
      ];
    }),
  ].join("\n");
}

export function registerJobTools(
  api: ExtensionAPI,
  { execution }: Connections,
  jobs: RemoteJobs,
) {
  registerCompiledTool(
    api,
    compileTool({
      ...remoteDefinitions.run,
      async execute(args, { signal, update: onUpdate, context: ctx }): Promise<Result> {
        const target = await execution(args.target ?? "local", ctx.cwd);
        return jobs.run(target, args, ctx, signal, onUpdate);
      },
    }),
    createShellRenderer<unknown>({
      ...scriptArguments,
      resolveTitle: (args) =>
        `${isRecord(args) && typeof args.target === "string" && args.target !== "local" ? `SSH · ${args.target}` : "Local"}`,
    }),
  );
  registerCompiledTool(
    api,
    compileTool({
      ...remoteDefinitions.batch,
      async execute(args, { signal, update: onUpdate, context: ctx }): Promise<Result> {
        const target = await execution(args.target ?? "local", ctx.cwd);
        return jobs.batch(target, args, ctx, signal, onUpdate);
      },
    }),
    createShellRenderer<unknown>({
      ...scriptArguments,
      resolveCommand: batchPreview,
      resolveTitle: () => "Batch plan",
    }),
  );
  registerCompiledTool(
    api,
    compileTool({
      ...remoteDefinitions.job,
      async execute(input, { signal, context: ctx }): Promise<Result> {
        return jobs.control(input, ctx, signal);
      },
    }),
    jobPresentation(),
  );
}
