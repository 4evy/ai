import type { AgentToolResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { remoteDefinitions } from "farstep/remote/remote";
import { manageScratch } from "farstep/remote/scratch/scratch";
import { compileTool, registerCompiledTool } from "#apps/omp/lib/schema/tool";
import { scriptTransport } from "../connections/execution";
import type { Connections } from "../connections/state";
import { farstepPresentation } from "./presentation";

export function registerScratchTool(api: ExtensionAPI, { execution }: Connections) {
  registerCompiledTool(
    api,
    compileTool({
      ...remoteDefinitions.scratch,
      async execute(args, { signal, context: ctx }): Promise<AgentToolResult<unknown>> {
        const target = await execution(args.target ?? "local", ctx.cwd);
        const result = await manageScratch(
          target,
          scriptTransport(target),
          args,
          signal,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
    }),
    farstepPresentation("Scratch"),
  );
}
