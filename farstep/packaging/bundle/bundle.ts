import { readFileSync as readResource } from "node:fs";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { formatMessage } from "@optique/core/message";
import { withDefault } from "@optique/core/modifiers";
import { parseSync } from "@optique/core/parser";
import { argument } from "@optique/core/primitives";
import { string } from "@optique/core/valueparser";
import { build, parse } from "plist";
import { run } from "../common";

const infoTemplate = readResource(new URL("./Info.plist", import.meta.url), "utf8");

export async function stageBundle(repo: string, payload: string, version: string) {
  const info = parse(infoTemplate);
  if (!info || typeof info !== "object" || !("CFBundleVersion" in info))
    throw new Error("Farstep bundle metadata must be a plist dictionary");
  await run(
    [
      "cargo",
      "build",
      "--locked",
      "--release",
      "-p",
      "farstep-desktop",
      "-p",
      "farstep-service",
    ],
    repo,
  );
  await mkdir(join(payload, "bin"), { recursive: true });
  const service = join(payload, "bin/farstep-service");
  await copyFile(join(repo, "target/release/farstep-service"), service);
  await chmod(service, 0o755);
  const bundle = join(payload, "share/Farstep.app");
  const contents = join(bundle, "Contents");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await copyFile(
    join(repo, "target/release/farstep-desktop"),
    join(contents, "MacOS/Farstep"),
  );
  await chmod(join(contents, "MacOS/Farstep"), 0o755);
  await writeFile(
    join(contents, "Info.plist"),
    `${build({
      ...info,
      CFBundleShortVersionString: version,
      CFBundleVersion: version,
    })}\n`,
  );
  const identity = process.env.FARSTEP_SIGNING_IDENTITY || "-";
  await run(
    [
      "codesign",
      "--force",
      "--sign",
      identity,
      ...(identity === "-" ? [] : ["--options", "runtime", "--timestamp"]),
      service,
    ],
    repo,
  );
  await run(
    [
      "codesign",
      "--force",
      "--sign",
      identity,
      ...(identity === "-"
        ? ["--requirements", '=designated => identifier "org.farstep.Farstep"']
        : ["--options", "runtime", "--timestamp"]),
      bundle,
    ],
    repo,
  );
  await run(["codesign", "--verify", "--strict", bundle], repo);
  return bundle;
}

if (import.meta.main) {
  if (process.platform !== "darwin") throw new Error("Build Farstep.app on macOS");
  const parsed = parseSync(
    withDefault(argument(string()), ".generated/farstep-darwin"),
    process.argv.slice(2),
  );
  if (!parsed.success) throw new Error(formatMessage(parsed.error));
  const payload = resolve(parsed.value || ".generated/farstep-darwin");
  const repo = resolve(import.meta.dir, "../../..");
  await stageBundle(repo, payload, "1.0.0");
  console.log(join(payload, "share/Farstep.app"));
}
