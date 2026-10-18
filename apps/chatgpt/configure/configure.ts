#!/usr/bin/env bun
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { run } from "@ai/core/effect/effect";
import { executeCommand } from "@ai/core/effect/process/process";
import { errorMessage } from "@ai/core/error/error";
import { Effect } from "effect";
import { MARKETPLACE } from "../plugins/marketplace.ts";
import { directory, Synchronizer } from "../plugins/sync.ts";

const LABEL = "ai chatgpt configure";
const PLUGINS = [
  "codex-app-tools",
  "browser",
  "chrome",
  "computer-use",
  "deep-research",
  "visualize",
  "latex",
] as const;

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function codexCli(resources: string): string {
  const candidates = [
    process.env.CODEX_CLI_PATH,
    Bun.which("codex"),
    join(resources, "codex-cli/bin/codex"),
  ];
  for (const candidate of candidates) {
    const path = candidate?.trim();
    if (path && executable(path) && statSync(path).isFile()) return path;
  }
  throw new Error("No executable Codex CLI found");
}

const patchComputerUse = Effect.fnUntraced(function* (app: string) {
  const patcher =
    process.env.PATCH_CHATGPT_COMPUTER_USE ??
    process.env.AI_TOOLS_WRAPPER_BIN ??
    (process.env.PATH ?? "")
      .split(delimiter)
      .map((path) => join(path, "ai"))
      .find(executable) ??
    "";
  if (!(yield* directory(app))) {
    console.error(`${LABEL}: ChatGPT is absent; skipping Computer Use patch`);
    return false;
  }
  if (!executable(patcher)) {
    console.error(`${LABEL}: Computer Use patcher is absent; skipping`);
    return false;
  }
  return yield* executeCommand(
    [
      patcher,
      ...(process.env.PATCH_CHATGPT_COMPUTER_USE ? [] : ["chatgpt", "policy", "patch"]),
      app,
    ],
    {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  ).pipe(
    Effect.map(({ code }) => {
      if (code === 0) return true;
      console.error(`${LABEL}: Computer Use patch failed (exit ${code})`);
      return false;
    }),
    Effect.catch(() =>
      Effect.sync(() => {
        console.error(`${LABEL}: Computer Use patch failed`);
        return false;
      }),
    ),
  );
});

const main = Effect.fnUntraced(function* () {
  const args = Bun.argv.slice(2);
  if (args.length) {
    return yield* Effect.fail(new Error("Usage: ai chatgpt configure"));
  }
  const resources =
    process.env.CHATGPT_RESOURCES ?? "/Applications/ChatGPT.app/Contents/Resources";
  const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  yield* new Synchronizer({
    source: join(resources, "plugins/openai-bundled"),
    home,
    marketplace: MARKETPLACE,
    plugins: PLUGINS,
    label: LABEL,
    cli: () => codexCli(resources),
    requireMaterialized: true,
  }).syncEffect();
  yield* patchComputerUse(dirname(dirname(resources)));
});

if (import.meta.main) {
  try {
    await run(main());
  } catch (error) {
    console.error(`${LABEL}: error: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
