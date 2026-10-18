import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { remoteDefinitions } from "farstep/remote/remote";
import { registerSchemaTool } from "#apps/omp/lib/schema/tool";
import type { Connections } from "../../connections/state";
import { resolveRemoteCwd } from "../../connections/target";
import { remoteFiles } from "./shared";

export function registerDeleteTool(api: ExtensionAPI, { selected }: Connections) {
  registerSchemaTool(api, {
    ...remoteDefinitions.delete,
    async execute(_id, args, signal) {
      const connection = selected(args.connection);
      const path = resolveRemoteCwd(connection, args.path);
      await remoteFiles(connection).delete(path, signal);
      return {
        content: [{ type: "text", text: `Deleted ${path}` }],
        details: { connectionId: connection.id, path },
      };
    },
  });
}
