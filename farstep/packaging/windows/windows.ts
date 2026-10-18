import { readFileSync } from "node:fs";
import { copyFile, cp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { run } from "../common";
import { packageMsi } from "./msi/msi";

const launcher = readFileSync(new URL("./launcher.cmd", import.meta.url), "utf8");

export async function packageWindows(output: string, release = "1") {
  if (process.platform !== "win32")
    throw new Error("Build the Windows payload on Windows");
  if (!["x64", "arm64"].includes(process.arch))
    throw new Error("Windows packages support x64 and arm64");
  if (!/^[1-9]\d*$/u.test(release) || Number(release) > 65535)
    throw new Error("Windows package releases must be between 1 and 65535");
  const repo = resolve(import.meta.dir, "../../..");
  const payload = resolve(output);
  const metadata = await Bun.file(join(repo, "farstep/package.json")).json();
  const version = `${metadata.version}.${release}`;
  if (
    !/^\d+\.\d+\.\d+\.\d+$/u.test(version) ||
    version.split(".").some((part, index) => Number(part) > (index < 2 ? 255 : 65535))
  )
    throw new Error("Windows packages require a four-part numeric version");
  const compiler =
    process.env.FARSTEP_WIX ??
    Bun.which("wix.exe") ??
    (process.env.USERPROFILE
      ? join(process.env.USERPROFILE, ".dotnet/tools/wix.exe")
      : undefined);
  if (!compiler)
    throw new Error(
      "Install WiX 7 (dotnet tool install --global wix --version 7.0.0 --allow-roll-forward) or set FARSTEP_WIX",
    );
  if (!(await Bun.file(compiler).exists()))
    throw new Error("Cannot find the WiX compiler, check FARSTEP_WIX");
  await run(
    [
      "cargo",
      "build",
      "--release",
      "--locked",
      "-p",
      "farstep-desktop",
      "-p",
      "farstep-service",
    ],
    repo,
  );
  for (const path of [
    "bin",
    "share/farstep",
    "lib/farstep/farstep/dependencies",
    "lib/farstep/omp/runtime",
  ])
    await mkdir(join(payload, path), { recursive: true });
  await copyFile(
    join(repo, "target/release/farstep-desktop.exe"),
    join(payload, "bin/farstep-desktop.exe"),
  );
  await copyFile(
    join(repo, "target/release/farstep-service.exe"),
    join(payload, "bin/farstep-service.exe"),
  );
  await copyFile(process.execPath, join(payload, "bin/bun.exe"));
  await cp(
    join(repo, "farstep/runtime"),
    join(payload, "lib/farstep/farstep/runtime"),
    { recursive: true },
  );
  await cp(join(repo, "farstep/client"), join(payload, "lib/farstep/farstep/client"), {
    recursive: true,
  });
  await cp(
    join(repo, "apps/omp/runtime/npm"),
    join(payload, "lib/farstep/omp/runtime/npm"),
    {
      recursive: true,
    },
  );
  await copyFile(
    join(import.meta.dir, "install.ps1"),
    join(payload, "share/farstep/install.ps1"),
  );
  await cp(join(import.meta.dir, "install"), join(payload, "share/farstep/install"), {
    recursive: true,
  });
  for (const name of ["protocol", "transport", "remote", "skylight", "farstep.ts"]) {
    await cp(join(repo, "farstep", name), join(payload, "lib/farstep/farstep", name), {
      recursive: true,
    });
  }
  const target = join(payload, "lib/farstep/farstep");
  const dependencies = join(target, "dependencies");
  await copyFile(join(repo, "farstep/package.json"), join(target, "package.json"));
  for (const name of ["package.json", "bun.lock"])
    await copyFile(join(repo, "farstep/dependencies", name), join(dependencies, name));
  await run(
    [
      join(payload, "bin/bun.exe"),
      "install",
      "--production",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--linker=hoisted",
      "--backend=copyfile",
    ],
    dependencies,
  );
  await rename(join(dependencies, "node_modules"), join(target, "node_modules"));
  await rm(dependencies, { recursive: true });
  await rm(join(payload, "lib/farstep/omp"), { recursive: true });
  await mkdir(join(target, "node_modules/@ai"), { recursive: true });
  await cp(join(repo, "packages/core"), join(target, "node_modules/@ai/core"), {
    recursive: true,
    filter: (source) => !source.split(/[\\/]/u).includes("node_modules"),
  });
  await writeFile(join(payload, "bin/farstep.cmd"), launcher);
  await run(
    [join(payload, "bin/bun.exe"), join(target, "runtime/main.ts"), "--help"],
    payload,
  );
  const artifact = await packageMsi(payload, version, process.arch, compiler);
  const sha256 = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(artifact).arrayBuffer())
    .digest("hex");
  console.log(
    JSON.stringify({
      payload,
      artifact,
      sha256,
      version,
      platform: "win32",
      architecture: process.arch,
    }),
  );
}

if (import.meta.main)
  await packageWindows(process.argv[2] || ".generated/farstep-windows");
