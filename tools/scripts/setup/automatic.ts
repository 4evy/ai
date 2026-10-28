import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { errorCode, errorMessage } from "@ai/core/error/error";
import { tryAcquireFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { setup } from "./setup";

const directory = join(
  process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"),
  "ai-tools/updates",
);
const interval = 24 * 60 * 60_000;
type UpstreamTool = "codex" | "claude";

async function due(attemptPath: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(attemptPath)).mtimeMs >= interval;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    return true;
  }
}

async function scheduleUpdate(tool: UpstreamTool): Promise<void> {
  if (
    process.platform !== "win32" ||
    process.env.AI_TOOLS_AUTO_UPDATE === "0" ||
    !(await due(join(directory, `${tool}-last-attempt`)))
  )
    return;
  const suffix = process.env.AI_TOOLS_SUFFIX ?? "ts";
  const script = join(import.meta.dir, `automatic.${suffix}`);
  if (!existsSync(script)) return;
  await mkdir(directory, { recursive: true });
  const log = openSync(join(directory, `${tool}.log`), "a", 0o600);
  try {
    const child = spawn(process.execPath, [script, tool], {
      detached: true,
      stdio: ["ignore", log, log],
      env: process.env,
    });
    child.on("error", () => {});
    child.unref();
  } finally {
    closeSync(log);
  }
}

export function scheduleCodexUpdate(): Promise<void> {
  return scheduleUpdate("codex");
}

export function scheduleClaudeUpdate(): Promise<void> {
  return scheduleUpdate("claude");
}

if (
  import.meta.main &&
  process.platform === "win32" &&
  process.env.AI_TOOLS_AUTO_UPDATE !== "0"
) {
  const tool = Bun.argv[2] ?? "codex";
  if (tool !== "codex" && tool !== "claude")
    throw new Error("Unknown automatic update target");
  const attemptPath = join(directory, `${tool}-last-attempt`);
  const lockPath = join(directory, tool);
  await mkdir(directory, { recursive: true });
  const lock = tryAcquireFileLock(lockPath);
  if (lock) {
    try {
      if (await due(attemptPath)) {
        await writeFile(attemptPath, new Date().toISOString(), { mode: 0o600 });
        // A background package update must not restart the active app-server daemon
        await setup(["--update", tool], { background: true });
      }
    } catch (error) {
      console.error(`${tool} auto-update: ${errorMessage(error)}`);
      process.exitCode = 1;
    } finally {
      lock.release();
    }
  }
}
