#!/usr/bin/env bun
import { errorMessage } from "@ai/core/error/error";
import { object } from "@optique/core/constructs";
import { formatMessage } from "@optique/core/message";
import { multiple } from "@optique/core/modifiers";
import { parseSync } from "@optique/core/parser";
import { argument } from "@optique/core/primitives";
import { string } from "@optique/core/valueparser";
import { Synchronizer } from "./sync.ts";

async function main(): Promise<void> {
  const parsed = parseSync(
    object({
      source: argument(string()),
      marketplace: argument(string()),
      plugins: multiple(argument(string())),
    }),
    Bun.argv.slice(2),
  );
  if (!parsed.success) throw new Error(formatMessage(parsed.error));
  const { source, marketplace, plugins } = parsed.value;
  if (!source || !marketplace)
    throw new Error("Usage: ai chatgpt plugins sync SOURCE MARKETPLACE [PLUGIN ...]");
  const home = process.env.CODEX_HOME;
  if (home === undefined) throw new Error("CODEX_HOME is required");
  await new Synchronizer({
    source,
    home,
    marketplace,
    plugins,
    label: "codex-bundled-plugins",
    cli: () => {
      const cli = process.env.CODEX_CLI_PATH;
      if (cli === undefined) throw new Error("CODEX_CLI_PATH is required");
      return cli;
    },
  }).sync();
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`codex-bundled-plugins: error: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
