import { join } from "node:path";
import { run as runEffect } from "@ai/core/effect/effect";
import { executeCommand } from "@ai/core/effect/process/process";
import { writeFile } from "atomically";

export const root = join(import.meta.dir, "../../..");

export async function execute(command: string[], cwd = root, env = process.env) {
  const { stdout, stderr, code } = await runEffect(
    executeCommand(command, { cwd, env }),
  );
  return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}

export async function run(command: string[], cwd = root, env = process.env) {
  const result = await execute(command, cwd, env);
  if (result.code !== 0)
    throw new Error(
      `${command.join(" ")} failed (${result.code}):\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout;
}

export async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function syncNixDependencies(
  runCommand: (command: string[]) => Promise<unknown>,
): Promise<void> {
  for (const { lock, prefix, output } of [
    { lock: "bun.lock", prefix: "../../../", output: "tools/nix/javascript/bun.nix" },
  ]) {
    await runCommand([
      "nix",
      "run",
      ".#bun2nix",
      "--",
      "--lock-file",
      lock,
      "--copy-prefix",
      prefix,
      "--output-file",
      output,
    ]);
    await runCommand(["deadnix", "--edit", output]);
    await runCommand(["nixfmt", output]);
  }
}
