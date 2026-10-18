import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { remoteDefinitions } from "farstep/remote/remote";
import { registerSchemaTool } from "#apps/omp/lib/schema/tool";
import type { Connections } from "../connections/state";
import type { RemoteJobs } from "../jobs/jobs";

export function registerCoordinationTool(
  api: ExtensionAPI,
  { execution }: Connections,
  jobs: RemoteJobs,
): void {
  registerSchemaTool(api, {
    ...remoteDefinitions.coordination,
    async execute(_id, input, signal, _update, ctx) {
      const connection = await execution(input.target, ctx.cwd);
      const result = await jobs.coordination(connection, input.request, ctx, signal);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
