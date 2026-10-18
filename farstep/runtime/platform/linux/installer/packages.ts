import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@ai/core/error/error";
import * as v from "valibot";
import { command } from "./command";
import { type Generation, manifestSchema, storePath } from "./schemas";

export async function artifact(path: string) {
  v.parse(storePath, path);
  if ((await realpath(path)) !== path)
    throw new Error("packagePath must identify a canonical Nix store output");
  await command(["nix-store", "--query", "--hash", path]);
  const manifest = v.parse(
    manifestSchema,
    JSON.parse(await readFile(join(path, "share/farstep/manifest.json"), "utf8")),
  );
  for (const executable of ["farstep", "farstep-desktop"]) {
    const info = await lstat(join(path, "bin", executable));
    if ((!info.isFile() && !info.isSymbolicLink()) || (info.mode & 0o111) === 0)
      throw new Error(`Artifact lacks executable ${executable}`);
  }
  return { ...manifest, manager: "nix" as const };
}

export async function packageOwnership(generation: Generation) {
  try {
    const checked = await artifact(generation.packagePath);
    if (checked.version !== generation.version)
      throw new Error("Recorded generation no longer matches its package");
    return { manager: "nix", owned: true as const };
  } catch (error) {
    return { manager: "nix", owned: false as const, error: errorMessage(error) };
  }
}
