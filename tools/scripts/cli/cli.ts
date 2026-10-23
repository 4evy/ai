#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "@ai/core/effect/effect";
import { executeCommand } from "@ai/core/effect/process/process";
import { errorMessage } from "@ai/core/error/error";
import { launchProcess } from "@ai/core/process/launch";
import { installed } from "../../../apps/ghidra/native/common.ts";
import { launch } from "../../../apps/ghidra/native/runtime.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const suffix = process.env.AI_TOOLS_SUFFIX ?? "ts";
const GHIDRA_EXECUTABLES = {
  gui: "ghidra",
  analyzeHeadless: "ghidra-analyzeHeadless",
} as const;
const routes = [
  ...["setup", "update"].map((action) => ({
    path: [action],
    script: "tools/scripts/setup/setup",
    usage: "[codex|claude|opencode|omp ...] [--dry-run]",
  })),
  {
    path: ["ghidra", "install"],
    script: "apps/ghidra/native/install",
    usage: "[--directory PATH] [--force]",
  },
  ...["gui", "analyzeHeadless"].map((action) => ({
    path: ["ghidra", action],
    script: "apps/ghidra/native/runtime",
    usage: "[ARGUMENTS...]",
  })),
  {
    path: ["browser", "chromium", "user", "agent"],
    script: "apps/browser/chromium/chromium",
    usage: "[--browser EXECUTABLE] [--refresh] [-- ARGS...]",
  },
  {
    path: ["browser", "firefox", "user", "agent"],
    script: "apps/browser/firefox/firefox",
    usage: "[--browser EXECUTABLE] [--refresh] [-- ARGS...]",
  },
  {
    path: ["chatgpt", "configure"],
    script: "apps/chatgpt/configure/configure",
    usage: "",
  },
  {
    path: ["chatgpt", "policy", "patch"],
    script: "apps/chatgpt/policy/policy",
    usage: "[APP_PATH]",
  },
  {
    path: ["chatgpt", "plugins", "sync"],
    script: "apps/chatgpt/plugins/plugins",
    usage: "SOURCE MARKETPLACE [PLUGIN...]",
  },
  {
    path: ["codex", "node", "repl"],
    script: "apps/chatgpt/repl/repl",
    usage: "[ARGUMENTS...]",
  },
  {
    path: ["ghidra", "macos"],
    script: "apps/ghidra/macos/macos",
    usage: "find|extract|load IMAGE",
  },
  ...["bridge", "httpd", "headless"].map((action) => ({
    path: ["ghidra", "mcp", action],
    script: "",
    usage: "[ARGUMENTS...]",
  })),
];

function help(prefix: string[]): string {
  const selected = routes.filter((route) =>
    prefix.every((part, index) => route.path[index] === part),
  );
  if (!selected.length) throw new Error(`Unknown command: ai ${prefix.join(" ")}`);
  return selected
    .map((route) => `ai ${route.path.join(" ")}${route.usage ? ` ${route.usage}` : ""}`)
    .join("\n");
}

async function ghidraPackage(): Promise<string> {
  if (process.env.GHIDRA_MCP_PACKAGE) return process.env.GHIDRA_MCP_PACKAGE;
  const nix =
    process.env.AI_TOOLS_NIX ??
    Bun.which("nix") ??
    [
      join(homedir(), ".nix-profile/bin/nix"),
      "/nix/var/nix/profiles/default/bin/nix",
    ].find((path) => Bun.file(path).size > 0);
  if (!nix) throw new Error("Install Nix, then install Ghidra with ai ghidra install");
  const state =
    process.env.GHIDRA_MCP_STATE ??
    join(
      process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"),
      "ghidra-mcp-headless",
    );
  await mkdir(state, { recursive: true });
  const { stdout: output, code } = await run(
    executeCommand(
      [
        nix,
        "build",
        "--out-link",
        join(state, "package"),
        "--print-out-paths",
        `path:${root}#ghidra-mcp`,
      ],
      { stderr: "inherit" },
    ),
  );
  if (code !== 0) throw new Error("Ghidra MCP package build failed");
  const packagePath = output.trim();
  if (!packagePath.startsWith("/") || packagePath.includes("\n"))
    throw new Error("Ghidra MCP build did not return one package path");
  return packagePath;
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const helpIndex = args.findIndex((arg) => arg === "--help" || arg === "-h");
  const route = routes.find((route) =>
    route.path.every((part, index) => args[index] === part),
  );
  const leafHelp =
    route?.path[0] === "browser" ||
    (route?.path[0] === "ghidra" && ["macos", "install"].includes(route.path[1] ?? ""));
  if (!route || (helpIndex >= 0 && helpIndex === route.path.length && !leafHelp)) {
    const prefix = helpIndex >= 0 ? args.slice(0, helpIndex) : args;
    console.log(help(prefix));
    return;
  }
  const rest = args.slice(route.path.length);
  if (
    process.platform === "win32" &&
    route.path[0] === "ghidra" &&
    route.path[1] === "install"
  ) {
    const { install } = await import(
      new URL(`../../../apps/ghidra/native/install.${suffix}`, import.meta.url).href
    );
    await install(rest);
    return;
  }
  let executable = process.execPath;
  let forwarded: string[];
  if (
    route.path[0] === "ghidra" &&
    route.path[1] !== "macos" &&
    route.path[1] !== "install"
  ) {
    const native = process.platform === "win32" ? await installed() : undefined;
    const action = route.path[1] === "mcp" ? route.path[2] : route.path[1];
    if (native && process.platform === "win32") {
      process.exitCode = await launch(action ?? "", rest);
      return;
    }
    if (native)
      forwarded = [
        join(root, `apps/ghidra/native/runtime.${suffix}`),
        action ?? "",
        ...rest,
      ];
    else {
      if (process.env.GHIDRA_NATIVE_HOME)
        throw new Error(
          "Install the selected native runtime with ai ghidra install first",
        );
      const packagePath = await ghidraPackage();
      if (route.path[1] === "mcp")
        executable = join(packagePath, "libexec", `ghidra-mcp-${action}`);
      else {
        const name = action === "gui" ? "gui" : "analyzeHeadless";
        executable = join(packagePath, "bin", GHIDRA_EXECUTABLES[name]);
      }
      forwarded = rest;
    }
  } else {
    forwarded = [join(root, `${route.script}.${suffix}`), ...rest];
    if (route.path[0] === "update") forwarded.splice(1, 0, "--update");
    if (route.path[0] === "codex") {
      const resources =
        process.env.CHATGPT_RESOURCES ?? "/Applications/ChatGPT.app/Contents/Resources";
      forwarded.splice(
        1,
        0,
        resources,
        process.env.CODEX_HOME ?? join(homedir(), ".codex"),
      );
    }
  }
  process.exitCode = await launchProcess(executable, forwarded);
}

try {
  await main();
} catch (error) {
  console.error(`ai: ${errorMessage(error)}`);
  process.exitCode ||= 1;
}
