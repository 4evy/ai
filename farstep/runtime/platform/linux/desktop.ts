import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../state";

export async function desktopEndpoint(): Promise<string> {
  const runtime = paths().runtime;
  const directory = await lstat(runtime);
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0
  ) {
    throw new Error(
      "Desktop socket directory has unsafe ownership, type or permissions",
    );
  }
  const socket = join(runtime, "desktop.sock");
  const info = await lstat(socket);
  if (
    !info.isSocket() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error("Desktop socket has unsafe ownership, type or permissions");
  }
  return socket;
}
