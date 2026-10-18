import { updateSkylight } from "./checksums";
import { updateFlake } from "./flake";
import { updateNativeGhidra } from "./native";
import { run, syncNixDependencies } from "./process";
import { updateSources } from "./sources";

const changed = new Set(
  (await run(["git", "diff", "HEAD", "--name-only"])).split("\n"),
);

if (!Bun.argv.includes("--toolchain-refreshed")) {
  if (changed.has("flake.lock")) await updateFlake();
  for (const [path, name] of [
    ["tools/nix/javascript/runtime/runtime.nix", "bun"],
    ["tools/nix/fmt/analyzer.nix", "powershell-analyzer"],
  ] as const) {
    if (changed.has(path))
      await run(["nix", "run", `.#${name}.updateScript`, "--", "--version=skip"]);
  }
  if (
    changed.has("flake.lock") ||
    changed.has("tools/nix/javascript/runtime/runtime.nix") ||
    changed.has("tools/nix/fmt/analyzer.nix")
  ) {
    await run([
      "nix",
      "develop",
      "--command",
      "bash",
      "tools/scripts/renovate/artifacts.sh",
      "--toolchain-refreshed",
    ]);
    process.exit(0);
  }
}

if (changed.has("apps/omp/runtime/source.json"))
  await run(["bun", "tools/scripts/omp/update.ts"]);
if (changed.has("farstep/runtime/sky/runtime/pins.json")) await updateSkylight();
if (changed.has("apps/ghidra/native/source.json")) await updateNativeGhidra();
await updateSources(changed);

await run(["bun", "install", "--ignore-scripts"]);
for (const directory of [
  "farstep/dependencies",
  "tools/runtime",
  "tools/scripts/dependencies",
  "apps/omp/runtime/upstream",
]) {
  await run(["bun", "install", "--cwd", directory, "--ignore-scripts"]);
}

await syncNixDependencies(run);

await run(["bun", "run", "check"]);
