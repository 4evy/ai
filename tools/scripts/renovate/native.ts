import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import type pinned from "../../../apps/ghidra/native/source.json";
import { downloadArchive } from "../archive/archive";
import { root, run, writeJson } from "./process";

const releaseSchema = v.pipe(
  v.string(),
  v.parseJson(),
  v.object({
    assets: v.array(
      v.object({
        name: v.string(),
        browser_download_url: v.pipe(v.string(), v.url()),
        digest: v.optional(v.nullable(v.string())),
      }),
    ),
  }),
);
type Asset = v.InferOutput<typeof releaseSchema>["assets"][number];

async function release(repository: string, tag: string): Promise<Asset[]> {
  const result = v.parse(
    releaseSchema,
    await run([
      "gh",
      "api",
      `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
    ]),
  );
  return result.assets;
}

async function artifact(assets: Asset[], match: (name: string) => boolean) {
  const matches = assets.filter((asset) => match(asset.name));
  const asset = matches[0];
  if (matches.length !== 1 || !asset)
    throw new Error(`Expected one release asset, found ${matches.length}`);
  let sha256 = asset.digest?.match(/^sha256:([a-f0-9]{64})$/)?.[1];
  if (!sha256) {
    await using staging = await mkdtempDisposable(join(tmpdir(), "renovate-native-"));
    const archive = join(staging.path, "archive");
    sha256 = await downloadArchive(asset.browser_download_url, archive);
  }
  return { url: asset.browser_download_url, sha256 };
}

export async function updateNativeGhidra(): Promise<void> {
  const path = join(root, "apps/ghidra/native/source.json");
  const pin: typeof pinned = await Bun.file(path).json();
  const ghidra = await release(
    "NationalSecurityAgency/ghidra",
    `Ghidra_${pin.ghidra.version}_build`,
  );
  Object.assign(
    pin.ghidra,
    await artifact(
      ghidra,
      (name) =>
        name.startsWith(`ghidra_${pin.ghidra.version}_PUBLIC_`) &&
        name.endsWith(".zip"),
    ),
  );
  pin.gradle.url = `https://downloads.gradle.org/distributions/gradle-${pin.gradle.version}-bin.zip`;
  const checksum = await fetch(`${pin.gradle.url}.sha256`);
  if (!checksum.ok) throw new Error(`Gradle checksum returned ${checksum.status}`);
  const sha256 = (await checksum.text()).trim();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid Gradle checksum");
  pin.gradle.sha256 = sha256;
  const uv = await release("astral-sh/uv", pin.uvVersion);
  const jdks = new Map<string, Asset[]>();
  for (const [platform, target] of Object.entries(pin.platforms)) {
    const jdkMajor = /^jdk-(\d+)/.exec(target.jdk.version)?.[1];
    if (!jdkMajor) throw new Error(`Invalid JDK release: ${target.jdk.version}`);
    let jdk = jdks.get(target.jdk.version);
    if (!jdk) {
      jdk = await release(`adoptium/temurin${jdkMajor}-binaries`, target.jdk.version);
      jdks.set(target.jdk.version, jdk);
    }
    const [os, arch] = platform.split("-");
    const jdkOS = os === "darwin" ? "mac" : os === "win32" ? "windows" : os;
    const jdkArch = arch === "arm64" ? "aarch64" : arch;
    Object.assign(
      target.jdk,
      await artifact(
        jdk,
        (name) =>
          name.startsWith(`OpenJDK${jdkMajor}U-jdk_${jdkArch}_${jdkOS}_hotspot_`) &&
          name.endsWith(os === "win32" ? ".zip" : ".tar.gz"),
      ),
    );
    const uvTarget = {
      "win32-x64": "x86_64-pc-windows-msvc.zip",
    }[platform];
    if (!uvTarget) throw new Error(`Unsupported native Ghidra platform: ${platform}`);
    Object.assign(target.uv, await artifact(uv, (name) => name === `uv-${uvTarget}`));
  }
  await writeJson(path, pin);
}
