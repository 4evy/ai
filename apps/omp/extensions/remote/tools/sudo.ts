import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createShellRenderer } from "@oh-my-pi/pi-tui/tools/bash";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { remoteDefinitions } from "farstep/remote/remote";
import { shellArguments } from "farstep/remote/tools/shell";
import { registerSchemaTool } from "#apps/omp/lib/schema/tool";
import type { Connections } from "../connections/state";
import type { RemoteJobs } from "../jobs/jobs";

export function registerSudoTool(
  api: ExtensionAPI,
  { selected }: Connections,
  jobs: RemoteJobs,
) {
  registerSchemaTool(api, {
    ...remoteDefinitions.sudo,
    ...createShellRenderer<unknown>({
      ...shellArguments,
      resolveTitle: (args) =>
        `Remote sudo · ${isRecord(args) && typeof args.connection === "string" ? args.connection : "SSH"}`,
    }),
    async execute(_id, args, signal, onUpdate, ctx) {
      return jobs.sudo(selected(args.connection), args, ctx, signal, onUpdate);
    },
  });
}
