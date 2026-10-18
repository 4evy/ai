#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { parseArgs } from "node:util";
import { writeFile as atomicWrite } from "atomically";
import { Struct } from "effect";
import * as v from "valibot";
import { installNixPackage } from "../../../tools/scripts/setup/nix/nix";
import applePin from "../extensions/apple-api-types/source.json";
import profiles from "../extensions/profiles.json";
import windowsPin from "../extensions/windows-api-types/source.json";
import mcpPin from "../mcp/source.json";
import { download, extract, replaceFile } from "./archive";
import { installationHome, installed, platform } from "./common.ts";
import { headers } from "./headers";
import { command } from "./platform.ts";
import source from "./source.json";

export async function install(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      directory: { type: "string" },
      force: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(
      "ai ghidra install [--force]\nUnix installs the Nix Ghidra MCP package. Windows also accepts --directory PATH for its private runtime",
    );
    return;
  }
  if (process.platform !== "win32") {
    if (values.directory) throw new Error("Unix Ghidra paths are managed by Nix");
    return installNixPackage("ghidra-mcp", values.force ?? false, false);
  }
  const key = `${process.platform}-${process.arch}`;
  if (!v.is(v.picklist(Struct.keys(source.platforms)), key))
    throw new Error(`Unsupported Ghidra host: ${key}`);
  const binaries = source.platforms[key];
  const host = platform();
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        installerVersion: 2,
        key,
        binaries,
        ghidra: source.ghidra,
        gradle: source.gradle,
        mcp: mcpPin,
        apple: applePin,
        windows: windowsPin,
        profiles,
      }),
    )
    .digest("hex");
  const home = installationHome();
  await mkdir(home, { recursive: true });
  const lock = join(home, ".install-lock");
  await mkdir(lock).catch(() => {
    throw new Error(`Another installation is active; lock: ${lock}`);
  });
  let staging: string | undefined;
  const controller = new AbortController();
  const stop = (signal: NodeJS.Signals) => {
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    controller.abort(new Error("Ghidra installation interrupted"));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const current = await installed();
    if (
      !values.force &&
      current?.fingerprint === fingerprint &&
      (
        await Promise.all(
          [
            host.python,
            join(host.javaHome, "bin", `java${host.executableSuffix}`),
            "ghidra/support/LaunchSupport.jar",
            `ghidra/Ghidra/Extensions/GhidraMCP/lib/GhidraMCP-${mcpPin.upstreamVersion}.jar`,
            ...[profiles.apple, profiles.windows].map(
              (spec) =>
                `ghidra/Ghidra/Extensions/${spec.extensionName}/extension.properties`,
            ),
          ].map((path) => Bun.file(join(current.directory, path)).exists()),
        )
      ).every(Boolean)
    ) {
      console.error(`Ghidra is already installed at ${current.directory}`);
      return;
    }
    const cache = join(home, "downloads");
    await mkdir(cache, { recursive: true });
    const generations = join(home, "versions");
    await mkdir(generations, { recursive: true });
    staging = await mkdtemp(join(home, ".install-"));
    const finalDirectory = join(
      generations,
      `${fingerprint.slice(0, 16)}-${randomUUID()}`,
    );
    for (const [directory, artifact] of [
      ["ghidra", source.ghidra],
      ["jdk", binaries.jdk],
      ["uv", binaries.uv],
      ["gradle", source.gradle],
    ] as const)
      await extract(
        await download(artifact, cache, controller.signal),
        join(staging, directory),
        directory !== "uv",
      );
    const javaHome = join(staging, host.javaHome);
    const java = join(javaHome, "bin", `java${host.executableSuffix}`);
    const uv = join(staging, "uv", `uv${host.executableSuffix}`);
    const env = {
      ...process.env,
      JAVA_HOME: javaHome,
      PATH: `${join(javaHome, "bin")}${delimiter}${process.env.PATH ?? ""}`,
    };
    const gradleLib = join(staging, "gradle/lib");
    const launcher = (await readdir(gradleLib)).find((name) =>
      /^gradle-(launcher|gradle-cli-main)-[\d.]+\.jar$/.test(name),
    );
    if (!launcher) throw new Error("Gradle launcher jar is missing");
    const gradle = [
      java,
      "-cp",
      join(gradleLib, launcher),
      "org.gradle.launcher.GradleMain",
    ];
    const ghidra = join(staging, "ghidra");
    const mcp = join(staging, "mcp");
    await extract(
      await download(
        {
          url: `https://codeload.github.com/bethington/ghidra-mcp/tar.gz/${mcpPin.rev}`,
        },
        cache,
        controller.signal,
      ),
      mcp,
    );
    await replaceFile(
      join(mcp, "python/bridge_mcp_ghidra/static_tools.py"),
      "    # Try UDS first\n    instances = discovery.discover_instances()",
      '    # A configured backend takes priority over unrelated local instances\n    instances = ([] if os.getenv("GHIDRA_MCP_URL")\n                 else discovery.discover_instances())',
    );
    console.error("Building the Ghidra MCP extension");
    await command(
      [...gradle, "--no-daemon", "buildExtension", `-PGHIDRA_INSTALL_DIR=${ghidra}`],
      { cwd: mcp, env },
    );
    await extract(
      join(mcp, `build/distributions/GhidraMCP-${mcpPin.upstreamVersion}.zip`),
      join(ghidra, "Ghidra/Extensions/GhidraMCP"),
    );
    console.error("Installing the Python MCP bridge");
    await command(
      [
        uv,
        "sync",
        "--locked",
        "--no-dev",
        "--no-default-groups",
        "--no-editable",
        "--python",
        "3.12",
        "--python-preference",
        "only-managed",
      ],
      { cwd: mcp, env },
    );
    for (const [name, owner, repo, pin, spec] of [
      ["apple", "PoomSmart", "IDAObjcTypes", applePin, profiles.apple],
      ["windows", "winsiderss", "systeminformer", windowsPin, profiles.windows],
    ] as const) {
      const headerSource = join(staging, `${name}-source`);
      await extract(
        await download(
          { url: `https://codeload.github.com/${owner}/${repo}/tar.gz/${pin.rev}` },
          cache,
          controller.signal,
        ),
        headerSource,
      );
      if (name === "apple") {
        // Apple uses LP64, while upstream's int32 aliases use C long
        await replaceFile(
          join(headerSource, "BaseTypes.h"),
          "typedef signed long int32;",
          "typedef signed int int32;",
        );
        await replaceFile(
          join(headerSource, "BaseTypes.h"),
          "typedef unsigned long uint32;",
          "typedef unsigned int uint32;",
        );
      }
      await headers(headerSource, ghidra, join(finalDirectory, "ghidra"), spec);
      await rm(headerSource, { recursive: true });
    }
    controller.signal.throwIfAborted();
    await rename(staging, finalDirectory);
    staging = undefined;
    await atomicWrite(
      join(home, "installation.json"),
      `${JSON.stringify({ version: 1, fingerprint, platform: process.platform, architecture: process.arch, directory: finalDirectory }, null, 2)}\n`,
    );
    console.error(
      `Installed Ghidra at ${finalDirectory}\nLaunch: ai ghidra gui\nMCP backend: ai ghidra mcp httpd\nMCP client: ai ghidra mcp headless`,
    );
    if (values.directory)
      console.error(`Set GHIDRA_NATIVE_HOME=${home} when launching this installation`);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (staging) await rm(staging, { recursive: true, force: true });
    await rm(lock, { recursive: true });
  }
}

if (import.meta.main) {
  try {
    await install(Bun.argv.slice(2));
  } catch (error) {
    console.error(
      `ai ghidra install: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode ||= 1;
  }
}
