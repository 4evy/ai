import { mkdtempDisposable, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as runEffect } from "@ai/runtime/effect/effect";
import { executeCommand } from "@ai/runtime/effect/process/process";
import { packageJsonSchema } from "@ai/values/schema/package";
import { formatMessage } from "@optique/core/message";
import { optional } from "@optique/core/modifiers";
import { parseSync } from "@optique/core/parser";
import { argument } from "@optique/core/primitives";
import { string } from "@optique/core/valueparser";
import { parsePatch } from "diff";
import * as Records from "effect/Record";
import { applyProfile } from "omp-agent-runtime/runtime/profile";
import { sourceSchema } from "omp-agent-runtime/runtime/source/source";
import * as v from "valibot";
import { downloadArchive, extractArchive } from "../archive/archive";
import { syncNixDependencies, writeJson } from "../renovate/process";
import { syncPatches } from "./patches/patches";

const parsed = parseSync(
  optional(argument(string({ metavar: "VERSION" }))),
  Bun.argv.slice(2),
);
if (!parsed.success) throw new Error(formatMessage(parsed.error));

const root = join(import.meta.dir, "../../..");
const sourcePath = join(root, "apps/omp/runtime/source.json");
const source = v.parse(sourceSchema, await Bun.file(sourcePath).json());
const version = parsed.value ?? source.version;
if (!/^\d+\.\d+\.\d+$/.test(version))
  throw new Error(`Invalid OMP release version: ${version}`);
const url = `https://codeload.github.com/can1357/oh-my-pi/tar.gz/refs/tags/v${version}`;

async function run(command: string[], cwd = root): Promise<string> {
  const { stdout: output, code } = await runEffect(
    executeCommand(command, { cwd, stderr: "inherit" }),
  );
  if (code !== 0)
    throw new Error(`Command failed: ${command.join(" ")}\n${output.trim()}`);
  return output.trim();
}

async function verifyInstalledPatches(): Promise<void> {
  for (const [name, patch] of [
    ["pi-coding-agent", "agent/agent.patch"],
    ["pi-tui", "tui/tui.patch"],
  ] as const) {
    await using workspace = await mkdtempDisposable(
      join(tmpdir(), "omp-published-check-"),
    );
    const expected = workspace.path;
    const archive = join(expected, "package.tgz");
    await downloadArchive(
      `https://registry.npmjs.org/@oh-my-pi/${name}/-/${name}-${version}.tgz`,
      archive,
    );
    await extractArchive(archive, expected);
    const patchPath = join(root, "apps/omp/runtime/npm", patch);
    await run(["patch", "-p1", "-f", "-F", "0", "-i", patchPath], expected);
    const files = parsePatch(await readFile(patchPath, "utf8")).flatMap(
      ({ newFileName }) =>
        newFileName?.startsWith("b/") ? [newFileName.slice(2)] : [],
    );
    // Bun can accept stale hunk offsets while placing edits incorrectly
    for (const packageRoot of ["apps/omp"]) {
      const installed = join(root, packageRoot, "node_modules/@oh-my-pi", name);
      const metadata = v.parse(
        packageJsonSchema,
        await Bun.file(join(installed, "package.json")).json(),
      );
      if (metadata.version !== version)
        throw new Error(`Installed ${name} version differs in ${packageRoot}`);
      for (const file of files) {
        if (
          !(await readFile(join(expected, file))).equals(
            await readFile(join(installed, file)),
          )
        )
          throw new Error(`Installed patch differs in ${packageRoot}: ${name}/${file}`);
      }
    }
  }
}

// Check every runtime patch before changing the dependency graph
let archiveHash: string;
{
  await using workspace = await mkdtempDisposable(join(tmpdir(), "omp-update-"));
  const staging = workspace.path;
  const archive = join(staging, "source.tar.gz");
  archiveHash = await downloadArchive(url, archive);
  await extractArchive(archive, staging);
  const upstream = v.parse(
    packageJsonSchema,
    await Bun.file(join(staging, "packages/coding-agent/package.json")).json(),
  );
  if (upstream.version !== version)
    throw new Error(`OMP source version does not match ${version}`);
  await applyProfile(staging, "runtime");
  await syncPatches({ version, archive });
}

await writeJson(sourcePath, {
  version,
  url,
  sha256: archiveHash,
});

for (const name of [
  "package.json",
  "apps/omp/package.json",
  "apps/omp/runtime/upstream/package.json",
  "farstep/package.json",
  "farstep/dependencies/package.json",
  "tools/runtime/package.json",
]) {
  const path = join(root, name);
  const manifest = v.parse(packageJsonSchema, await Bun.file(path).json());
  for (const group of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
  ] as const) {
    const dependencies = manifest[group];
    if (!dependencies) continue;
    for (const dependency of Object.keys(dependencies)) {
      if (dependency.startsWith("@oh-my-pi/")) dependencies[dependency] = version;
    }
  }
  if (name === "apps/omp/runtime/upstream/package.json") manifest.version = version;
  if (manifest.patchedDependencies)
    manifest.patchedDependencies = Records.mapKeys(
      manifest.patchedDependencies,
      (name) =>
        name.startsWith("@oh-my-pi/")
          ? `${name.slice(0, name.lastIndexOf("@"))}@${version}`
          : name,
    );
  await writeJson(path, manifest);
}

// Installing also checks the published-package patches against this release
await run(["bun", "install", "--ignore-scripts"]);
await run(["bun", "install", "--cwd", "farstep/dependencies", "--ignore-scripts"]);
await run([
  "bun",
  "install",
  "--cwd",
  "tools/runtime",
  "--ignore-scripts",
  "--lockfile-only",
]);
await run([
  "bun",
  "install",
  "--cwd",
  "apps/omp/runtime/upstream",
  "--ignore-scripts",
  "--lockfile-only",
]);
await verifyInstalledPatches();
await syncNixDependencies(run);
console.log(
  `OMP source, dependencies, patches, and Nix cache synchronized at ${version}`,
);
