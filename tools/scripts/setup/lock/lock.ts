import { open, readFile, rm, stat } from "node:fs/promises";
import { errorCode } from "@ai/core/error/error";

export async function acquireLock(lockPath: string) {
  try {
    return await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    // Give another updater time to write its PID before considering recovery
    try {
      if (Date.now() - (await stat(lockPath)).mtimeMs < 60_000) return;
      const pid = Number(await readFile(lockPath, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          return;
        } catch (error) {
          if (errorCode(error) !== "ESRCH") return;
        }
      }
      await rm(lockPath, { force: true });
      return await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (["ENOENT", "EEXIST"].includes(errorCode(error) ?? "")) return;
      throw error;
    }
  }
}
