import { readText } from "@ai/core/text/text";
import type { AgentToolResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { remoteDefinitions } from "farstep/remote/remote";
import { compileTool, registerCompiledTool } from "#apps/omp/lib/schema/tool";
import type { Connections } from "../connections/state";
import { manageHelper } from "../helper/manage";
import type { RemoteJobs } from "../jobs/jobs";
import { touchCoordination } from "./registration/registration";

export function registerHelperTool(
  api: ExtensionAPI,
  connections: Connections,
  jobs: RemoteJobs,
) {
  registerCompiledTool(
    api,
    compileTool({
      ...remoteDefinitions.helper,
      async execute(args, { signal, context: ctx }): Promise<AgentToolResult<unknown>> {
        const result = await manageHelper(args, connections, jobs, signal);
        const connection = connections.selected(args.connection);
        await touchCoordination(api, connection, jobs, ctx, (reason) =>
          readText(new URL("./helper/helper.md", import.meta.url), "coordination", {
            CONNECTION: String(connection.id),
            ERROR: reason,
          }),
        );
        return result;
      },
    }),
  );
}
