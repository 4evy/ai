#!/usr/bin/env bun
import {
  chmod,
  copyFile,
  mkdir,
  mkdtempDisposable,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { run } from "@ai/runtime/effect/effect";
import { executeCommand } from "@ai/runtime/effect/process/process";
import { object } from "@optique/core/constructs";
import { formatMessage } from "@optique/core/message";
import { optional } from "@optique/core/modifiers";
import { parseSync } from "@optique/core/parser";
import { option } from "@optique/core/primitives";
import { valibot } from "@optique/valibot";
import * as v from "valibot";

const pathValue = valibot(
  v.pipe(v.string(), v.nonEmpty(), v.excludes("\0", "NUL is not allowed")),
  { metavar: "PATH", placeholder: "" },
);

const root = resolve(import.meta.dir, "../../..");
const parsed = parseSync(
  object({
    from: optional(option("--from", pathValue)),
    "host-file": optional(option("--host-file", pathValue)),
    overrides: optional(option("--overrides", pathValue)),
    "print-host": option("--print-host"),
    help: option("--help"),
  }),
  Bun.argv.slice(2),
);
if (!parsed.success) throw new Error(formatMessage(parsed.error));
const values = parsed.value;

if (values.help) {
  console.log(
    "Usage: bun config/settings/generate/generate.ts [--from DIR | --host-file FILE] [--overrides FILE] [--print-host]",
  );
  process.exit(0);
}
if (values.from && (values.overrides || values["host-file"] || values["print-host"]))
  throw new Error(
    "--from installs an already rendered export; it cannot rebuild host settings or overrides",
  );

async function discoverHost() {
  const home = homedir();
  const codexHome = process.env.CODEX_HOME ?? join(home, ".codex");
  const darwin = process.platform === "darwin";
  const resources = await chatgptResources(darwin);
  const nodeRepl = resources ? join(resources, "cua_node/bin/node_repl") : "";
  const notify = join(
    codexHome,
    "computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
  );
  return {
    os: process.platform,
    homeDirectory: home,
    codexHome,
    chatgptResources: resources,
    nodeRepl: nodeRepl && (await Bun.file(nodeRepl).exists()) ? nodeRepl : "",
    notifyClient: darwin && (await Bun.file(notify).exists()) ? notify : "",
    codexCli: process.env.CODEX_CLI_PATH?.trim() || Bun.which("codex") || "",
    lldb: Boolean(Bun.which("lldb-mcp-launcher")),
    farstep: Bun.which("farstep") ?? "",
  };
}

async function chatgptResources(darwin: boolean): Promise<string> {
  if (process.env.CHATGPT_RESOURCES) return resolve(process.env.CHATGPT_RESOURCES);
  const chatgpt = Bun.which("chatgpt");
  const resources = darwin
    ? "/Applications/ChatGPT.app/Contents/Resources"
    : chatgpt
      ? join(dirname(dirname(await realpath(chatgpt))), "lib/chatgpt/resources")
      : "";
  return resources;
}

if (values["print-host"]) {
  console.log(JSON.stringify(await discoverHost(), null, 2));
  process.exit(0);
}

const manifestSchema = v.object({
  version: v.literal(1),
  files: v.array(v.object({ path: v.string(), private: v.boolean() })),
});
const cache = join(root, ".generated");
await mkdir(cache, { recursive: true });
await using work = await mkdtempDisposable(join(tmpdir(), "ai-configs-"));
await using staging = await mkdtempDisposable(join(cache, "configs-"));
let output = values.from ? resolve(values.from) : "";
if (!output) {
  const hostFile = values["host-file"]
    ? resolve(values["host-file"])
    : join(work.path, "host.json");
  if (!values["host-file"])
    await writeFile(hostFile, JSON.stringify(await discoverHost()), { mode: 0o600 });
  const system = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform}`;
  const command = [
    "nix",
    "build",
    "--impure",
    "--no-link",
    "--json",
    "--file",
    join(import.meta.dir, "build.nix"),
    "--argstr",
    "repository",
    root,
    "--argstr",
    "system",
    system,
    "--argstr",
    "hostFile",
    hostFile,
  ];
  if (values.overrides)
    command.push("--argstr", "overridesFile", resolve(values.overrides));
  const { stdout: result, code } = await run(
    executeCommand(command, { cwd: root, stderr: "inherit" }),
  );
  if (code !== 0) throw new Error("Nix config generation failed");
  const builds = v.parse(
    v.array(v.object({ outputs: v.object({ out: v.string() }) })),
    JSON.parse(result),
  );
  output = builds[0]?.outputs.out ?? "";
  if (!output) throw new Error("Nix returned no config export");
}
const manifest = v.parse(
  manifestSchema,
  JSON.parse(await readFile(join(output, "manifest.json"), "utf8")),
);
for (const file of manifest.files) {
  if (
    isAbsolute(file.path) ||
    file.path.split("/").some((part) => ["", ".", ".."].includes(part))
  )
    throw new Error(`Invalid config destination: ${file.path}`);
  const destination = join(staging.path, file.path);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(output, file.path), destination);
  await chmod(destination, file.private ? 0o600 : 0o644);
}
await writeFile(
  join(staging.path, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
// Replace the cache only after every file has been read successfully
const destination = join(cache, "ai-configs");
const backup = join(cache, "ai-configs.previous");
await rm(backup, { recursive: true, force: true });
let moved = false;
try {
  await rename(destination, backup);
  moved = true;
} catch (error) {
  if (
    !error ||
    typeof error !== "object" ||
    !("code" in error) ||
    error.code !== "ENOENT"
  )
    throw error;
}
try {
  await rename(staging.path, destination);
} catch (error) {
  if (moved) await rename(backup, destination);
  throw error;
}
await rm(backup, { recursive: true, force: true });
console.log(`Prepared ${manifest.files.length} configs in .generated/ai-configs`);
