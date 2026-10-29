import { cp, mkdtempDisposable, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatMessage } from "@optique/core/message";
import { parseSync } from "@optique/core/parser";
import { argument } from "@optique/core/primitives";
import { string } from "@optique/core/valueparser";
import { run, writeJson } from "../../../tools/scripts/renovate/process";
import { applyBridgePatches, readBridgeInputs } from "../native/bridge";
import type pinned from "./source.json";

export async function updateBridgeLock(source: string): Promise<void> {
  const pinPath = join(import.meta.dir, "source.json");
  const pin: typeof pinned = await Bun.file(pinPath).json();
  const sdk = JSON.parse(
    await run([
      "nix",
      "store",
      "prefetch-file",
      "--unpack",
      "--json",
      `https://github.com/modelcontextprotocol/python-sdk/archive/refs/tags/v${pin.sdk.version}.tar.gz`,
    ]),
  );
  pin.sdk.hash = sdk.hash;
  await writeJson(pinPath, pin);
  await using workspace = await mkdtempDisposable(join(tmpdir(), "ghidra-bridge-"));
  await cp(source, workspace.path, { recursive: true });
  // Nix store sources retain read-only permissions when copied
  await run(["chmod", "-R", "u+w", workspace.path]);
  await applyBridgePatches(workspace.path, await readBridgeInputs());
  await run(
    ["uv", "lock", "--upgrade", "--upgrade-package", `mcp==${pin.sdk.version}`],
    workspace.path,
  );
  await writeFile(
    join(import.meta.dir, "uv.lock"),
    await readFile(join(workspace.path, "uv.lock")),
  );
}

if (import.meta.main) {
  const parsed = parseSync(argument(string()), Bun.argv.slice(2));
  if (!parsed.success) throw new Error(formatMessage(parsed.error));
  const source = parsed.value;
  if (!source) throw new Error("Usage: bun apps/ghidra/mcp/update.ts SOURCE");
  await updateBridgeLock(source);
}
