#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchProcess } from "@ai/runtime/process/launch";
import { errorMessage } from "@ai/values/error/error";
import { object, or, seq } from "@optique/core/constructs";
import { formatMessage } from "@optique/core/message";
import { map, withDefault } from "@optique/core/modifiers";
import { type Parser, parseSync } from "@optique/core/parser";
import { command, constant, flag, passThrough } from "@optique/core/primitives";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const suffix = process.env.AI_TOOLS_SUFFIX ?? "ts";
const routes = [
  ...["setup", "update"].map((action) => ({
    path: [action],
    script: "tools/scripts/setup/setup",
    usage: "[codex|claude|opencode|omp ...] [--dry-run]",
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
];

type Route = (typeof routes)[number];
type Selection =
  | { kind: "help"; prefix: string[] }
  | { kind: "run"; route: Route; args: readonly string[] };

function commandParser(prefix: string[] = []): Parser<"sync", Selection> {
  const selected = routes.filter((route) =>
    prefix.every((part, index) => route.path[index] === part),
  );
  const route = selected.find((route) => route.path.length === prefix.length);
  const forwarded = withDefault(passThrough({ format: "greedy" }), []);
  if (route) {
    const parser = object({
      kind: constant("run"),
      route: constant(route),
      args: forwarded,
    });
    if (prefix[0] === "browser") return parser;
    return withDefault(
      or(
        map(seq(flag("-h", "--help"), forwarded), () => ({
          kind: "help" as const,
          prefix,
        })),
        parser,
      ),
      { kind: "run", route, args: [] },
    );
  }
  const names = new Set(
    selected
      .map((route) => route.path[prefix.length])
      .filter((name) => name !== undefined),
  );
  return withDefault(
    or(
      ...[...names].map((name) => command(name, commandParser([...prefix, name]))),
      map(flag("-h", "--help"), () => ({ kind: "help" as const, prefix })),
    ),
    { kind: "help", prefix },
  );
}

const parser = commandParser();

function help(prefix: string[]): string {
  const selected = routes.filter((route) =>
    prefix.every((part, index) => route.path[index] === part),
  );
  if (!selected.length) throw new Error(`Unknown command: ai ${prefix.join(" ")}`);
  return selected
    .map((route) => `ai ${route.path.join(" ")}${route.usage ? ` ${route.usage}` : ""}`)
    .join("\n");
}

async function main(): Promise<void> {
  const parsed = parseSync(parser, Bun.argv.slice(2));
  if (!parsed.success) throw new Error(formatMessage(parsed.error));
  if (parsed.value.kind === "help") {
    console.log(help(parsed.value.prefix));
    return;
  }
  const { route, args } = parsed.value;
  const forwarded = [join(root, `${route.script}.${suffix}`), ...args];
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
  process.exitCode = await launchProcess(process.execPath, forwarded);
}

try {
  await main();
} catch (error) {
  console.error(`ai: ${errorMessage(error)}`);
  process.exitCode ||= 1;
}
