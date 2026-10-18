import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtempDisposable,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { run as runEffect } from "@ai/core/effect/effect";
import { executeCommand } from "@ai/core/effect/process/process";
import { errorCode } from "@ai/core/error/error";
import { packageJsonSchema } from "@ai/core/schema/package";
import { writeFile } from "atomically";
import {
  applyProfile,
  profileFingerprint,
  run,
  runtimeRoot,
} from "omp-agent-runtime/runtime/profile";
import { sourceSchema } from "omp-agent-runtime/runtime/source/source";
import * as v from "valibot";

import { downloadArchive, extractArchive } from "../../archive/archive";

const cacheRoot = join(
  process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
  "ai-tools/omp",
);
const sourceCli = "runtime/packages/coding-agent/src/cli.ts";

async function works(cli: string, version?: string): Promise<boolean> {
  if (!(await Bun.file(cli).exists())) return false;
  const { stdout, code } = await runEffect(
    executeCommand([process.execPath, cli, "--version"], { stderr: "ignore" }),
  );
  return code === 0 && (version === undefined || stdout.trim() === `omp/${version}`);
}

async function remember(cli: string): Promise<void> {
  await writeFile(join(cacheRoot, "last-working"), `${cli}\n`);
}

export async function lastWorking(): Promise<string> {
  const marker = Bun.file(join(cacheRoot, "last-working"));
  if (await marker.exists()) {
    const cli = (await marker.text()).trim();
    if (
      cli.endsWith(join("runtime", "packages", "coding-agent", "src", "cli.ts")) &&
      (await works(cli))
    )
      return cli;
  }
  const candidates = await workingCandidates();
  candidates.sort((a, b) => b.modified - a.modified);
  for (const { cli } of candidates) if (await works(cli)) return cli;
  throw new Error("No working patched OMP runtime is cached");
}

async function workingCandidates(): Promise<Array<{ cli: string; modified: number }>> {
  const candidates: Array<{ cli: string; modified: number }> = [];
  try {
    for (const entry of await readdir(cacheRoot)) {
      if (!/^[a-f0-9]{64}$/.test(entry)) continue;
      const cli = join(cacheRoot, entry, sourceCli);
      if (await Bun.file(cli).exists())
        candidates.push({ cli, modified: (await stat(cli)).mtimeMs });
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  return candidates;
}

async function extract(
  tree: string,
  version: string,
  checksum?: string,
): Promise<void> {
  const archive = `${tree}.tar.gz`;
  await downloadArchive(
    `https://codeload.github.com/can1357/oh-my-pi/tar.gz/refs/tags/v${version}`,
    archive,
  );
  if (checksum) {
    const digest = createHash("sha256")
      .update(new Uint8Array(await Bun.file(archive).arrayBuffer()))
      .digest("hex");
    if (digest !== checksum) throw new Error("OMP source archive checksum mismatch");
  }
  await extractArchive(archive, tree);
  await rm(archive);
  if (
    v.parse(
      packageJsonSchema,
      await Bun.file(join(tree, "packages/coding-agent/package.json")).json(),
    ).version !== version
  )
    throw new Error("OMP source version mismatch");
  await applyProfile(tree, "runtime");
}

async function installClosure(tree: string): Promise<void> {
  const manifest = join(tree, "package.json");
  const upstream = await readFile(manifest);
  await copyFile(join(runtimeRoot, "upstream/package.json"), manifest);
  await copyFile(join(runtimeRoot, "upstream/bun.lock"), join(tree, "bun.lock"));
  // Nix-store inputs are read-only; the cached working tree must remain writable
  await chmod(manifest, 0o644);
  await chmod(join(tree, "bun.lock"), 0o644);
  await run(
    [
      process.execPath,
      "install",
      "--frozen-lockfile",
      "--production",
      "--ignore-scripts",
      "--linker=hoisted",
      "--backend=copyfile",
    ],
    tree,
  );
  await Bun.write(manifest, upstream);
  async function installPackages(): Promise<void> {
    for (const directory of await readdir(join(tree, "packages"))) {
      const path = join(tree, "packages", directory);
      const metadata = Bun.file(join(path, "package.json"));
      if (!(await metadata.exists())) continue;
      const { name } = v.parse(packageJsonSchema, await metadata.json());
      if (typeof name !== "string" || !name.startsWith("@oh-my-pi/")) continue;
      const installed = join(tree, "node_modules", name);
      if (!(await Bun.file(join(installed, "package.json")).exists())) continue;
      await rm(installed, { recursive: true });
      if (process.platform === "win32") await cp(path, installed, { recursive: true });
      else await symlink(relative(dirname(installed), path), installed);
    }
  }
  if (process.platform !== "win32") await installPackages();
  const native = join(
    tree,
    "node_modules/@oh-my-pi",
    `pi-natives-${process.platform}-${process.arch}`,
  );
  const binaries = (await readdir(native)).filter((name) => name.endsWith(".node"));
  if (!binaries.length) throw new Error("Matching OMP native addon is missing");
  const nativeDirectory = join(tree, "packages/natives/native");
  for (const name of binaries)
    if (process.platform === "win32")
      await copyFile(join(native, name), join(nativeDirectory, name));
    else
      await symlink(
        relative(nativeDirectory, join(native, name)),
        join(nativeDirectory, name),
      );
  const omp = join(tree, "node_modules/.bin/omp");
  await rm(omp, { force: true });
  if (process.platform !== "win32") {
    await symlink(
      relative(dirname(omp), join(tree, "packages/coding-agent/src/cli.ts")),
      omp,
    );
  }
  await copyFile(join(runtimeRoot, "policy/policy.sh"), join(tree, "update-policy.sh"));
  await run(
    [process.execPath, "packages/collab-web/scripts/build-tool-views.ts"],
    tree,
  );
  await run([process.execPath, "--cwd=packages/stats", "run", "gen:stats"], tree);
  // Windows copies avoid requiring Developer Mode or administrator symlink
  // rights
  if (process.platform === "win32") await installPackages();
}

export async function buildPinnedRuntime(): Promise<string> {
  const pin = v.parse(
    sourceSchema,
    await Bun.file(join(runtimeRoot, "source.json")).json(),
  );
  if (
    v.parse(
      packageJsonSchema,
      await Bun.file(join(runtimeRoot, "upstream/package.json")).json(),
    ).version !== pin.version
  )
    throw new Error(
      "OMP dependency closure differs from the source pin; run just omp update",
    );
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify([
      process.platform,
      process.arch,
      Bun.version,
      await profileFingerprint("runtime"),
    ]),
  );
  for (const file of [
    import.meta.path,
    join(import.meta.dir, "../../archive/archive.ts"),
    ...[
      "source.json",
      "upstream/package.json",
      "upstream/bun.lock",
      "policy/policy.sh",
    ].map((path) => join(runtimeRoot, path)),
  ])
    hash.update(await readFile(file));
  const cache = join(cacheRoot, hash.digest("hex"));
  const cli = join(cache, sourceCli);
  await mkdir(cacheRoot, { recursive: true });
  if (await works(cli, pin.version)) {
    await remember(cli);
    return cli;
  }
  console.error(`omp: building pinned runtime ${pin.version}`);
  await using staging = await mkdtempDisposable(`${cache}.`);
  const tree = join(staging.path, "runtime");
  await extract(tree, pin.version, pin.sha256);
  await installClosure(tree);
  const stagedCli = join(staging.path, sourceCli);
  if (!(await works(stagedCli, pin.version)))
    throw new Error("Built OMP version check failed");
  await run([process.execPath, stagedCli, "--help"]);
  try {
    await rename(staging.path, cache);
  } catch (error) {
    if (
      !["EEXIST", "ENOTEMPTY"].includes(errorCode(error) ?? "") ||
      !(await works(cli, pin.version))
    )
      throw error;
  }
  await remember(cli);
  return cli;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const usage =
    "Usage: bun tools/scripts/omp/runtime/runtime.ts [--check-patches [VERSION] | --last-working]";
  switch (args[0]) {
    case undefined:
      console.log(await buildPinnedRuntime());
      break;
    case "--last-working":
      if (args.length !== 1) throw new Error(usage);
      console.log(await lastWorking());
      break;
    case "--check-patches": {
      if (args.length > 2) throw new Error(usage);
      const pin = v.parse(
        sourceSchema,
        await Bun.file(join(runtimeRoot, "source.json")).json(),
      );
      const version = args[1] ?? pin.version;
      if (!version || !/^\d+\.\d+\.\d+$/.test(version))
        throw new Error("Invalid OMP version");
      await using directory = await mkdtempDisposable(join(tmpdir(), "omp-check-"));
      await extract(
        join(directory.path, "source"),
        version,
        version === pin.version ? pin.sha256 : undefined,
      );
      console.error(`omp: runtime profile applies cleanly to ${version}`);
      break;
    }
    default:
      throw new Error(usage);
  }
}
