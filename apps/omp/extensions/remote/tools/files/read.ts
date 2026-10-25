import type { AgentToolResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { outputMeta } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { parseSel } from "@oh-my-pi/pi-coding-agent/tools/read-selector";
import { type ReadToolDetails, readToolRenderer } from "@oh-my-pi/pi-tui/tools/read";
import { hash } from "farstep/client/files/files";
import { remoteDefinitions } from "farstep/remote/remote";
import { compileTool, registerCompiledTool } from "#apps/omp/lib/schema/tool";
import type { Connections } from "../../connections/state";
import { resolveRemoteCwd } from "../../connections/target";
import { type FileDetails, remoteFilePresentation } from "./presentation";
import { remoteFiles, staging } from "./shared";

const DEFAULT_DIRECTORY_PAGE_SIZE = 200;

export function registerReadTool(api: ExtensionAPI, { selected }: Connections) {
  registerCompiledTool(
    api,
    compileTool({
      ...remoteDefinitions.read,
      async execute(
        args,
        { id, signal },
      ): Promise<AgentToolResult<ReadToolDetails & FileDetails>> {
        if (args.selector && parseSel(args.selector).kind === "none")
          throw new Error(
            "Invalid native read selector; pass a range, raw, conflicts or img",
          );
        const connection = selected(args.connection);
        const path = resolveRemoteCwd(connection, args.path);
        const files = remoteFiles(connection);
        const kind = await files.stat(path, signal);
        if (kind === "directory") {
          if (args.selector) throw new Error("Use offset/limit for directory listings");
          const entries = await files.list(path, signal);
          const offset = args.offset ?? 0;
          const page = entries.slice(
            offset,
            offset + (args.limit ?? DEFAULT_DIRECTORY_PAGE_SIZE),
          );
          return {
            content: [
              {
                type: "text",
                text:
                  page
                    .map((entry) => `${entry.name}${entry.isDirectory ? "/" : ""}`)
                    .join("\n") || "[No entries in this page]",
              },
            ],
            details: {
              connectionId: connection.id,
              path,
              isDirectory: true,
              totalEntries: entries.length,
              offset,
              truncated: offset + page.length < entries.length,
            },
          };
        }
        if (kind !== "file")
          throw new Error(
            `Remote path is ${kind}; expected a regular file or directory`,
          );
        if (args.offset !== undefined || args.limit !== undefined)
          throw new Error(
            "Use selector for file ranges; offset/limit apply to directories",
          );
        const bytes = await files.read(path, signal);
        const sha256 = hash(bytes);
        return staging(path, async (file, session) => {
          await Bun.write(file, bytes);
          const result = await new ReadTool(session).execute(
            id,
            { path: `${file}${args.selector ? `:${args.selector}` : ""}` },
            signal,
          );
          const { resolvedPath: _stagedPath, ...details } = result.details ?? {};
          return {
            ...result,
            content: [
              {
                type: "text",
                text: `Full-file SHA-256 (${path}): ${sha256}`,
              },
              ...result.content.map((item) =>
                item.type === "text"
                  ? {
                      ...item,
                      text: item.text.replaceAll(file, path),
                    }
                  : item,
              ),
            ],
            details: {
              ...details,
              path,
              displayTarget: path,
              connectionId: connection.id,
              sha256,
              fileSize: bytes.length,
              meta: {
                ...result.details?.meta,
                ...outputMeta().sourcePath(path).get(),
              },
            },
          };
        });
      },
    }),
    remoteFilePresentation(readToolRenderer),
  );
}
