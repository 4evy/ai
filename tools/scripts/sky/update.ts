import { mkdtempDisposable, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import {
  downloadRuntime,
  extractRuntime,
  validateRuntime,
} from "farstep/runtime/sky/runtime/install";
import { runtimePaths } from "farstep/runtime/sky/runtime/paths";
import type pinned from "farstep/runtime/sky/runtime/pins.json";
import { execute, root, writeJson } from "../renovate/process";
import { checkDeclarations, destination, readPackage, writePackage } from "./sky";

const path = join(root, "farstep/runtime/sky/runtime/pins.json");
const pins: typeof pinned = await Bun.file(path).json();
const check = Bun.argv.includes("--check");
const SKY_TARGETS = ["darwin-arm64", "linux-x64", "win32-x64", "win32-arm64"] as const;
async function run(command: string[], cwd = root) {
  const result = await execute(command, cwd);
  if (result.code !== 0) {
    throw new Error(`${command.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
}
const linux = pins.artifacts.find(({ platform }) => platform === "linux");
const version =
  /^https:\/\/persistent\.oaistatic\.com\/codex-app-prod\/linux\/rpm\/x86_64\/chatgpt-(\d+\.\d+\.\d+)-\d+\.x86_64\.rpm$/.exec(
    linux?.url ?? "",
  )?.[1];
if (!version) throw new Error("Unsupported Skylight RPM URL");
if (check && pins.version !== version)
  throw new Error("The Skylight version differs from its Linux artifact");
pins.version = version;
await using workspace = await mkdtempDisposable(join(tmpdir(), "sky-update-"));
const staging = workspace.path;
let generated: Awaited<ReturnType<typeof readPackage>> | undefined;
const platforms = new Set<string>();
const packages: {
  platform: string;
  current: Awaited<ReturnType<typeof readPackage>>;
}[] = [];
for (const artifact of pins.artifacts) {
  const target = `${artifact.platform}-${artifact.arch}`;
  if (platforms.has(target)) throw new Error(`Duplicate Skylight artifact: ${target}`);
  platforms.add(target);
  switch (target) {
    case "linux-x64":
      break;
    case "win32-x64":
    case "win32-arm64":
      if (
        artifact.url !==
        `https://persistent.oaistatic.com/codex-app-prod/ChatGPT-${artifact.arch}.msix`
      )
        throw new Error(`Unsupported Skylight MSIX URL: ${artifact.url}`);
      break;
    case "darwin-arm64":
      if (
        !/^https:\/\/persistent\.oaistatic\.com\/codex-app-prod\/ChatGPT-darwin-arm64-\d+\.\d+\.\d+\.zip$/.test(
          artifact.url,
        )
      )
        throw new Error(`Unsupported Skylight artifact: ${target}`);
      break;
    default:
      throw new Error(`Unsupported Skylight artifact: ${target}`);
  }
  const archive = join(staging, `${target}${extname(artifact.url)}`);
  const sha256 = await downloadRuntime(artifact.url, archive);
  if (check && artifact.sha256 !== sha256) {
    throw new Error(`ChatGPT ${target} checksum differs from the pin`);
  }
  artifact.sha256 = sha256;
  const unpacked = join(staging, target);
  await extractRuntime(archive, unpacked);
  const current = await readPackage(
    join(
      runtimePaths(join(unpacked, artifact.resources), artifact.platform, artifact.arch)
        .modules,
      "@oai/sky",
    ),
    pins,
  );
  if (check && artifact.skyVersion !== current.version) {
    throw new Error(`ChatGPT ${target} Sky version differs from the pin`);
  }
  artifact.skyVersion = current.version;
  await validateRuntime(unpacked, artifact);
  packages.push({ platform: artifact.platform, current });
  if (artifact.platform !== "win32") generated = current;
  await rm(unpacked, { recursive: true, force: true });
  await rm(archive);
  console.log(`Verified ChatGPT ${target}: @oai/sky ${current.version}`);
}
if (
  !generated ||
  platforms.size !== SKY_TARGETS.length ||
  !SKY_TARGETS.every((target) => platforms.has(target))
) {
  throw new Error(
    "Skylight requires macOS arm64, Linux x64, and Windows x64 and arm64 artifacts",
  );
}
for (const { platform, current } of packages) {
  checkDeclarations(generated, current, platform);
}
const windows = packages.filter(({ platform }) => platform === "win32");
if (windows[0] && windows[1]) {
  checkDeclarations(windows[0].current, windows[1].current, "Windows architectures");
}
if (check && pins.skyVersion !== generated.version) {
  throw new Error("The pinned Sky version differs from the downloaded packages");
}
pins.skyVersion = generated.version;
const manifest = JSON.parse(generated.contents.get("package.json") ?? "");
manifest.skylight.archives = pins.artifacts.map(
  ({
    platform,
    arch,
    sha256,
    skyVersion,
  }: {
    platform: string;
    arch: string;
    sha256: string;
    skyVersion: string;
  }) => ({
    platform,
    arch,
    sha256,
    skyVersion,
  }),
);
generated.contents.set("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
await writePackage(generated.contents, destination, check);
if (!check) {
  await writeJson(path, pins);
  await run(["bun", "install", "--ignore-scripts", "--force"]);
}
await run(["bun", "run", "--cwd", "apps/omp", "typecheck"]);
await run([
  process.execPath,
  "x",
  "--no-install",
  "tsc",
  "--ignoreConfig",
  "--noEmit",
  "--module",
  "Preserve",
  "--moduleResolution",
  "bundler",
  "--target",
  "ESNext",
  "--types",
  "bun",
  join(destination, "upstream/index.d.ts"),
  join(destination, "upstream/service.d.ts"),
]);
console.log(
  `Sky ${pins.skyVersion} and all ${platforms.size} pinned runtimes are synchronized`,
);
