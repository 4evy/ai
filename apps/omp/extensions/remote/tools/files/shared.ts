import { posix } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
  listRemoteDir,
  readRemoteFile,
  statRemotePath,
  writeRemoteFile,
} from "@oh-my-pi/pi-coding-agent/ssh/file-transfer";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { RemoteFiles } from "farstep/client/files/files";
import { scriptTransport } from "../../connections/execution";
import type { Connection } from "../../connections/types";

export function remoteFiles(connection: Connection): RemoteFiles {
  return new RemoteFiles({
    stat: (path, signal) =>
      statRemotePath(connection.target, path, signal ? { signal } : {}),
    read: (path, maxBytes, signal) =>
      readRemoteFile(connection.target, path, {
        maxBytes,
        ...(signal ? { signal } : {}),
      }),
    write: (path, bytes, signal) =>
      writeRemoteFile(connection.target, path, bytes, signal ? { signal } : {}),
    list: (path, signal) =>
      listRemoteDir(connection.target, path, signal ? { signal } : {}),
    command: scriptTransport(connection),
  });
}

export async function staging<T>(
  path: string,
  operation: (file: string, session: ToolSession) => Promise<T>,
): Promise<T> {
  await using directory = await TempDir.create("@omp-remote-file-");
  // Keep the format extension while avoiding native selector syntax in filenames
  const extension = posix.extname(path);
  const file = directory.join(
    `file${/^\.[A-Za-z0-9]+$/u.test(extension) ? extension : ""}`,
  );
  const session: ToolSession = {
    cwd: directory.path(),
    hasUI: false,
    enableLsp: false,
    hasEditTool: true,
    settings: Settings.isolated({
      "edit.mode": "replace",
      "read.summarize.enabled": false,
    }),
    getSessionFile: () => null,
    getSessionSpawns: () => "",
  };
  return await operation(file, session);
}
