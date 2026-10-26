import type { AgentToolResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { remoteDefinitions } from "farstep/remote/remote";
import { compileTool, registerCompiledTool } from "#apps/omp/lib/schema/tool";
import { connect } from "../connections/connections";
import type { Connections } from "../connections/state";
import { connectionState } from "../connections/state";
import type { RemoteJobs } from "../jobs/jobs";
import { farstepPresentation } from "./presentation";
import { touchCoordination } from "./registration/registration";

export function registerConnectionTool(
  api: ExtensionAPI,
  { save }: Connections,
  jobs: RemoteJobs,
) {
  registerCompiledTool(
    api,
    compileTool({
      ...remoteDefinitions.connect,
      async execute(
        input,
        { signal, context: ctx },
      ): Promise<AgentToolResult<unknown>> {
        const connection = await connect(input, ctx.cwd, signal);
        save(connection);
        const multiplexing = await connectionState(connection, signal);
        await touchCoordination(
          api,
          connection,
          jobs,
          ctx,
          (reason) =>
            `SSH connection ${connection.id} is saved, but coordination registration is unavailable: ${reason}. No operations were replayed`,
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ connection, multiplexing }, null, 2),
            },
          ],
          details: { connection, multiplexing, verifiedAt: Date.now() },
        };
      },
    }),
    farstepPresentation("SSH connection"),
  );
}
