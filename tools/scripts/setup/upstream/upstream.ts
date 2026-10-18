import { lstat, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "@ai/core/effect/effect";
import { executeCommand } from "@ai/core/effect/process/process";
import { errorCode } from "@ai/core/error/error";
import { processCommand } from "@ai/core/process/launch";
import { bunBinary } from "../binary";
import { acquireLock } from "../lock/lock";

const packages = {
  codex: "@openai/codex@alpha",
  claude: "@anthropic-ai/claude-code@latest",
  opencode: "@opencode/cli@latest",
};

async function command(argv: string[], dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log(JSON.stringify({ argv }));
    return;
  }
  const result = await run(
    executeCommand(argv, {
      env: { ...process.env },
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  if (result.code !== 0)
    throw new Error(`${argv.slice(1).join(" ")} failed (${result.code})`);
}

async function daemonInstalled(): Promise<boolean> {
  const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  for (const layout of ["app-server-daemon", "standalone"]) {
    try {
      await lstat(join(home, "packages", layout, "current"));
      return true;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  return false;
}

export async function installUpstream(
  tool: keyof typeof packages,
  update: boolean,
  dryRun: boolean,
  background: boolean,
): Promise<void> {
  if (dryRun) return install(tool, update, true, background);
  const directory = join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"),
    "ai-tools/updates",
  );
  await mkdir(directory, { recursive: true });
  // Bun's global install is shared by every tool and updater process
  const path = join(directory, "packages.lock");
  const lock = await acquireLock(path);
  if (!lock) throw new Error("Another AI package update is running. Try again later");
  try {
    await lock.writeFile(String(process.pid));
    await install(tool, update, false, background);
  } finally {
    await lock.close();
    await rm(path, { force: true });
  }
}

async function install(
  tool: keyof typeof packages,
  update: boolean,
  dryRun: boolean,
  background: boolean,
): Promise<void> {
  const specifier = packages[tool];
  const name = specifier.slice(0, specifier.lastIndexOf("@"));
  // Resolve the channel before removing the old package, so a failed registry
  // lookup leaves the current installation available
  await command([process.execPath, "info", specifier, "version"], dryRun);
  if (update) {
    const installed = dryRun
      ? true
      : (
          await run(
            executeCommand([process.execPath, "pm", "ls", "--global"], {
              env: { ...process.env },
            }),
          )
        ).stdout.includes(`${name}@`);
    if (installed)
      await command([process.execPath, "remove", "--global", name], dryRun);
  }
  await command(
    [process.execPath, "add", "--global", "--no-cache", "--trust", specifier],
    dryRun,
  );
  const executable = dryRun ? `<Bun ${tool} binary>` : bunBinary(tool);
  if (!executable) throw new Error(`${tool}: Bun did not install an executable`);
  await command(processCommand(executable, ["--version"]), dryRun);
  if (tool === "codex" && !background) {
    if (dryRun || (await daemonInstalled())) {
      await command(
        processCommand(executable, [
          "app-server",
          "daemon",
          "update",
          "--from-cli",
          "--yes",
        ]),
        dryRun,
      );
    } else console.log("codex: no daemon package is installed, nothing to update");
  }
  if (tool === "opencode" && !dryRun)
    console.log(
      "opencode: the next client connection will replace an outdated background service",
    );
}
