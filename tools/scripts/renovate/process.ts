import { join } from "node:path";
import { run as runEffect } from "@ai/runtime/effect/effect";
import { executeCommand } from "@ai/runtime/effect/process/process";
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
    const { packages } = Bun.JSONC.parse(await Bun.file(join(root, lock)).text()) as {
      packages: Record<
        string,
        [string, unknown, { os?: string | string[]; cpu?: string | string[] }?]
      >;
    };
    const platforms: Record<string, { os?: string[]; cpu?: string[] }> = {};
    for (const [name, , metadata] of Object.values(packages)) {
      const { os, cpu } = metadata ?? {};
      if (os === undefined && cpu === undefined) continue;
      platforms[name] = {
        ...(os === undefined ? {} : { os: typeof os === "string" ? [os] : os }),
        ...(cpu === undefined ? {} : { cpu: typeof cpu === "string" ? [cpu] : cpu }),
      };
    }
    const platformOutput = output.replace(/bun\.nix$/, "platforms.json");
    await writeJson(join(root, platformOutput), platforms);
    await runCommand([
      "bun",
      "x",
      "--no-install",
      "biome",
      "format",
      "--write",
      platformOutput,
    ]);
    await runCommand(["deadnix", "--edit", output]);
    await runCommand(["nixfmt", output]);
  }
}
