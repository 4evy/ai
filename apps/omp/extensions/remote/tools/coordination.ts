import type { AgentToolResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { remoteDefinitions } from "farstep/remote/remote";
import { compileTool, registerCompiledTool } from "#apps/omp/lib/schema/tool";
import type { Connections } from "../connections/state";
import type { RemoteJobs } from "../jobs/jobs";

export function registerCoordinationTool(
  api: ExtensionAPI,
  { execution }: Connections,
  jobs: RemoteJobs,
): void {
  registerCompiledTool(
    api,
    compileTool({
      ...remoteDefinitions.coordination,
      async execute(
        input,
        { signal, context: ctx },
      ): Promise<AgentToolResult<unknown>> {
        const connection = await execution(input.target, ctx.cwd);
        const result = await jobs.coordination(connection, input.request, ctx, signal);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
    }),
  );
}
