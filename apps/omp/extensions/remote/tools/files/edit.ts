import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { editToolRenderer } from "@oh-my-pi/pi-tui/tools/edit";
import { remoteDefinitions } from "farstep/remote/remote";
import { registerSchemaTool } from "#apps/omp/lib/schema/tool";
import type { Connections } from "../../connections/state";
import { resolveRemoteCwd } from "../../connections/target";
import { remoteFilePresentation } from "./presentation";
import { remoteFiles, staging } from "./shared";

export function registerEditTool(api: ExtensionAPI, { selected }: Connections) {
  registerSchemaTool(api, {
    ...remoteDefinitions.edit,
    ...remoteFilePresentation(editToolRenderer),
    async execute(id, args, signal) {
      const connection = selected(args.connection);
      const path = resolveRemoteCwd(connection, args.path);
      const { result, sha256 } = await remoteFiles(connection).edit(
        path,
        args.expectedHash,
        (original) =>
          staging(path, async (file, session) => {
            await Bun.write(file, original);
            const result = await new EditTool(session, "replace").execute(
              id,
              {
                path: file,
                old_string: args.old_string,
                new_string: args.new_string,
                ...(args.replace_all === undefined
                  ? {}
                  : { replace_all: args.replace_all }),
              },
              signal,
            );
            if (result.isError) return { result };
            const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
            return {
              result: {
                ...result,
                content: result.content.map((item) =>
                  item.type === "text"
                    ? { ...item, text: item.text.replaceAll(file, path) }
                    : item,
                ),
              },
              bytes,
            };
          }),
        signal,
      );
      if (result.isError) return result;
      return {
        ...result,
        details: {
          ...result.details,
          diff: result.details?.diff ?? "",
          path,
          connectionId: connection.id,
          sha256,
        },
      };
    },
  });
}
