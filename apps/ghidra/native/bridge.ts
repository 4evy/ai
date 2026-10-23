import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyPatch, parsePatch } from "diff";
import mcpPin from "../mcp/source.json";

export type BridgeInputs = {
  patches: { name: string; contents: Buffer }[];
  lock: Buffer;
};

export async function readBridgeInputs(): Promise<BridgeInputs> {
  const directory = join(import.meta.dir, "../mcp");
  // Keep the fingerprint and installed source tied to the same payload bytes
  const [patches, lock] = await Promise.all([
    Promise.all(
      mcpPin.patches.map(async (name) => ({
        name,
        contents: await readFile(join(directory, name)),
      })),
    ),
    readFile(join(directory, "uv.lock")),
  ]);
  return { patches, lock };
}

export async function applyBridgePatches(
  directory: string,
  inputs: Pick<BridgeInputs, "patches">,
): Promise<void> {
  // Preserve the maintained patch order shared with the Nix package
  for (const { name, contents } of inputs.patches) {
    for (const patch of parsePatch(contents.toString("utf8"))) {
      const file = patch.newFileName?.startsWith("b/")
        ? patch.newFileName.slice(2)
        : undefined;
      if (!file || patch.oldFileName !== `a/${file}`)
        throw new Error(`Expected an in-place source patch in ${name}`);
      const path = join(directory, file);
      const updated = applyPatch(await readFile(path, "utf8"), patch, {
        fuzzFactor: 0,
        autoConvertLineEndings: false,
      });
      if (updated === false) throw new Error(`Patch ${name} does not apply to ${file}`);
      await writeFile(path, updated);
    }
  }
}
