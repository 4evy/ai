import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { outputMeta } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { writeToolRenderer } from "@oh-my-pi/pi-tui/tools/write";
import { hash } from "farstep/client/files/files";
import { remoteDefinitions } from "farstep/remote/remote";
import { registerSchemaTool } from "#apps/omp/lib/schema/tool";
import type { Connections } from "../../connections/state";
import { resolveRemoteCwd } from "../../connections/target";
import { remoteFilePresentation } from "./presentation";
import { remoteFiles, staging } from "./shared";

export function registerWriteTool(api: ExtensionAPI, { selected }: Connections) {
  registerSchemaTool(api, {
    ...remoteDefinitions.write,
    ...remoteFilePresentation(writeToolRenderer),
    async execute(id, args, signal) {
      const connection = selected(args.connection);
      const path = resolveRemoteCwd(connection, args.path);
      if (args.path.endsWith("/"))
        throw new Error("Write requires a file path without a trailing slash");
      return staging(path, async (file, session) => {
        const result = await new WriteTool(session).execute(
          id,
          { path: file, content: args.content },
          signal,
        );
        if (result.isError) return result;
        const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
        await remoteFiles(connection).write(path, bytes, signal);
        const {
          resolvedPath: _stagedPath,
          madeExecutable: _stagedMode,
          ...details
        } = result.details ?? {};
        return {
          content: [{ type: "text", text: `Wrote ${bytes.length} bytes to ${path}` }],
          details: {
            ...details,
            meta: {
              ...details.meta,
              ...outputMeta().sourcePath(path).get(),
            },
            connectionId: connection.id,
            path,
            sha256: hash(bytes),
            bytes: bytes.length,
          },
        };
      });
    },
  });
}
