import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createShellRenderer } from "@oh-my-pi/pi-tui/tools/bash";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { remoteDefinitions } from "farstep/remote/remote";
import { scriptArguments } from "farstep/remote/tools/shell";
import { registerSchemaTool } from "#apps/omp/lib/schema/tool";
import type { Connections } from "../connections/state";
import type { RemoteJobs } from "../jobs/jobs";
import { jobPresentation } from "../jobs/presentation";

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
  registerSchemaTool(api, {
    ...remoteDefinitions.run,
    ...createShellRenderer<unknown>({
      ...scriptArguments,
      resolveTitle: (args) =>
        `${isRecord(args) && typeof args.target === "string" && args.target !== "local" ? `SSH · ${args.target}` : "Local"}`,
    }),
    async execute(_id, args, signal, onUpdate, ctx) {
      const target = await execution(args.target ?? "local", ctx.cwd);
      return jobs.run(target, args, ctx, signal, onUpdate);
    },
  });
  registerSchemaTool(api, {
    ...remoteDefinitions.batch,
    ...createShellRenderer<unknown>({
      ...scriptArguments,
      resolveCommand: batchPreview,
      resolveTitle: () => "Batch plan",
    }),
    async execute(_id, args, signal, onUpdate, ctx) {
      const target = await execution(args.target ?? "local", ctx.cwd);
      return jobs.batch(target, args, ctx, signal, onUpdate);
    },
  });
  registerSchemaTool(api, {
    ...remoteDefinitions.job,
    ...jobPresentation(),
    async execute(_id, input, signal, _update, ctx) {
      return jobs.control(input, ctx, signal);
    },
  });
}
