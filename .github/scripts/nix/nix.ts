import { join } from "node:path";
import { choice, run } from "../run/run.ts";

const system = choice("NIX_SYSTEM", [
  "x86_64-linux",
  "aarch64-linux",
  "aarch64-darwin",
]);
const task = choice("TASK", [
  "evaluate",
  "just",
  "github",
  "format",
  "native-lint",
  "native-tests",
  "package",
]);
const shell = ["nix", "shell", "--inputs-from", ".", "--no-update-lock-file"];
const develop = [
  "nix",
  "develop",
  ".#native",
  "--no-update-lock-file",
  "--ignore-environment",
  "--keep",
  "HOME",
  "--keep",
  "CI",
  "--command",
];

switch (task) {
  case "evaluate":
    await run([
      "nix",
      "flake",
      "check",
      "--all-systems",
      "--no-build",
      "--no-update-lock-file",
    ]);
    break;
  case "just":
    await run([...shell, "nixpkgs#just", "--command", "just", "check", "just"]);
    break;
  case "github":
    await run([
      ...shell,
      "nixpkgs#actionlint",
      "nixpkgs#zizmor",
      "--command",
      process.execPath,
      "run",
      "check:github",
    ]);
    break;
  case "format":
    await run([
      "nix",
      "build",
      "--no-link",
      "--no-update-lock-file",
      "--print-build-logs",
      `.#checks.${system}.treefmt`,
    ]);
    break;
  case "native-lint":
    await run([...develop, "just", "install"]);
    await run([...develop, "just", "check", "rust"]);
    break;
  case "native-tests":
    await run([...develop, "bun", ".github/scripts/native/native.ts", "tests"]);
    break;
  case "package": {
    const name = choice("PACKAGE", [
      "ai-javascript",
      "ai-shared",
      "farstep-modules",
      "farstep-javascript",
      "farstep-desktop",
      "farstep-service",
      "farstep-extensions",
      "farstep-kde-bridge",
      "ai-configs",
      "farstep",
    ]);
    const temporary = process.env.RUNNER_TEMP;
    if (!temporary) throw new Error("RUNNER_TEMP is required for package builds");
    const artifact = join(temporary, "ci-package");
    await run([
      "nix",
      "build",
      "--no-update-lock-file",
      "--print-build-logs",
      "--out-link",
      artifact,
      `.#packages.${system}.${name}`,
    ]);
    if (name === "farstep-desktop" || name === "farstep-service") {
      await run([join(artifact, "bin", name), "--help"]);
    } else if (name === "ai-configs") {
      const manifest = await Bun.file(join(artifact, "manifest.json")).json();
      if (
        manifest?.version !== 1 ||
        !Array.isArray(manifest.files) ||
        !manifest.files.length
      )
        throw new Error("Invalid configuration manifest");
      for (const file of manifest.files) {
        if (typeof file?.path !== "string" || typeof file.private !== "boolean")
          throw new Error("Invalid configuration manifest entry");
        if (!(await Bun.file(join(artifact, file.path)).exists()))
          throw new Error(`Missing configuration artifact: ${file.path}`);
      }
    }
    break;
  }
}
