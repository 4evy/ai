import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createShellRenderer } from "@oh-my-pi/pi-tui/tools/bash";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { remoteDefinitions } from "farstep/remote/remote";
import { shellArguments } from "farstep/remote/tools/shell";
import { compileTool, registerCompiledTool } from "#apps/omp/lib/schema/tool";
import type { Connections } from "../connections/state";
import type { RemoteJobs } from "../jobs/jobs";
import type { Result } from "../jobs/types";

export function registerSudoTool(
  api: ExtensionAPI,
  { selected }: Connections,
  jobs: RemoteJobs,
) {
  registerCompiledTool(
    api,
    compileTool({
      ...remoteDefinitions.sudo,
      async execute(args, { signal, update: onUpdate, context: ctx }): Promise<Result> {
        return jobs.sudo(selected(args.connection), args, ctx, signal, onUpdate);
      },
    }),
    createShellRenderer<unknown>({
      ...shellArguments,
      resolveTitle: (args) =>
        `Remote sudo · ${isRecord(args) && typeof args.connection === "string" ? args.connection : "SSH"}`,
    }),
  );
}
