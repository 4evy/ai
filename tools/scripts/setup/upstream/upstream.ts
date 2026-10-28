import { lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { attempt, run } from "@ai/core/effect/effect";
import { executeCommand } from "@ai/core/effect/process/process";
import { errorCode } from "@ai/core/error/error";
import { processCommand } from "@ai/core/process/launch";
import { tryAcquireFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { Effect } from "effect";
import { bunBinary } from "../binary";

const packages = {
  codex: "@openai/codex@alpha",
  claude: "@anthropic-ai/claude-code@latest",
  opencode: "@opencode/cli@latest",
};

const command = Effect.fnUntraced(function* (argv: string[], dryRun: boolean) {
  if (dryRun) {
    console.log(JSON.stringify({ argv }));
    return;
  }
  const result = yield* executeCommand(argv, {
    env: { ...process.env },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.code !== 0)
    return yield* Effect.fail(
      new Error(`${argv.slice(1).join(" ")} failed (${result.code})`),
    );
});

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
  await run(
    Effect.gen(function* () {
      if (dryRun) return yield* install(tool, update, true, background);
      const directory = join(
        process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"),
        "ai-tools/updates",
      );
      yield* attempt(() => mkdir(directory, { recursive: true }), {
        awaitOnInterrupt: true,
      });
      // Bun's global install is shared by every tool and updater process
      const path = join(directory, "packages");
      yield* Effect.acquireUseRelease(
        Effect.sync(() => tryAcquireFileLock(path)),
        (lock) =>
          Effect.gen(function* () {
            if (!lock)
              return yield* Effect.fail(
                new Error("Another AI package update is running. Try again later"),
              );
            yield* install(tool, update, false, background);
          }),
        (lock) => Effect.sync(() => lock?.release()),
      );
    }),
  );
}

const install = Effect.fnUntraced(function* (
  tool: keyof typeof packages,
  update: boolean,
  dryRun: boolean,
  background: boolean,
) {
  const specifier = packages[tool];
  const name = specifier.slice(0, specifier.lastIndexOf("@"));
  // Resolve the channel before removing the old package, so a failed registry
  // lookup leaves the current installation available
  yield* command([process.execPath, "info", specifier, "version"], dryRun);
  if (update) {
    const installed = dryRun
      ? true
      : (yield* executeCommand([process.execPath, "pm", "ls", "--global"], {
          env: { ...process.env },
        })).stdout.includes(`${name}@`);
    if (installed)
      yield* command([process.execPath, "remove", "--global", name], dryRun);
  }
  yield* command(
    [process.execPath, "add", "--global", "--no-cache", "--trust", specifier],
    dryRun,
  );
  const executable = dryRun ? `<Bun ${tool} binary>` : bunBinary(tool);
  if (!executable)
    return yield* Effect.fail(new Error(`${tool}: Bun did not install an executable`));
  yield* command(processCommand(executable, ["--version"]), dryRun);
  if (tool === "codex" && !background) {
    if (dryRun || (yield* attempt(() => daemonInstalled()))) {
      yield* command(
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
});
