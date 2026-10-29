import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { run } from "@ai/runtime/effect/effect";
import { executeCommand } from "@ai/runtime/effect/process/process";
import * as v from "valibot";
import { PROTOCOL_MAJOR } from "#farstep/runtime/state";

const storePath = v.pipe(
  v.string(),
  v.regex(/^\/nix\/store\/[a-z0-9]{32}-[A-Za-z0-9+._?=-]+$/u),
);
export const generationSchema = v.strictObject({
  manager: v.literal("nix"),
  packagePath: storePath,
  version: v.string(),
});
export type Generation = v.InferOutput<typeof generationSchema>;

export async function retain(root: string, packagePath: string): Promise<void> {
  v.parse(storePath, packagePath);
  const result = await run(
    executeCommand([
      "nix-store",
      "--add-root",
      root,
      "--indirect",
      "--realise",
      packagePath,
    ]),
  );
  if (result.code !== 0)
    throw new Error(`Cannot retain Farstep Nix output: ${result.stderr}`);
}

export async function artifact(packagePath: string): Promise<Generation> {
  v.parse(storePath, packagePath);
  if ((await realpath(packagePath)) !== packagePath)
    throw new Error("packagePath must identify a canonical Nix store output");
  const result = await run(
    executeCommand(["nix-store", "--query", "--hash", packagePath]),
  );
  if (result.code !== 0)
    throw new Error("Farstep output is not registered in the Nix store");
  const manifest = v.parse(
    v.strictObject({
      protocolMajor: v.literal(PROTOCOL_MAJOR),
      version: v.pipe(v.string(), v.regex(/^\d+\.\d+\.\d+$/u)),
      platform: v.literal("darwin"),
      desktopExecutable: v.literal("bin/farstep-desktop"),
    }),
    JSON.parse(
      await readFile(join(packagePath, "share/farstep/manifest.json"), "utf8"),
    ),
  );
  for (const name of [
    "bin/farstep",
    "bin/bun",
    "share/Farstep.app/Contents/MacOS/Farstep",
  ]) {
    const info = await lstat(join(packagePath, name));
    if ((!info.isFile() && !info.isSymbolicLink()) || (info.mode & 0o111) === 0)
      throw new Error(`Payload lacks executable ${name}`);
  }
  return { manager: "nix", packagePath, version: manifest.version };
}
