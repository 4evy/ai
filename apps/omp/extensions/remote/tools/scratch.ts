import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { remoteDefinitions } from "farstep/remote/remote";
import { manageScratch } from "farstep/remote/scratch/scratch";
import { registerSchemaTool } from "#apps/omp/lib/schema/tool";
import { scriptTransport } from "../connections/execution";
import type { Connections } from "../connections/state";

export function registerScratchTool(api: ExtensionAPI, { execution }: Connections) {
  registerSchemaTool(api, {
    ...remoteDefinitions.scratch,
    async execute(_id, args, signal, _update, ctx) {
      const target = await execution(args.target ?? "local", ctx.cwd);
      const result = await manageScratch(target, scriptTransport(target), args, signal);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
