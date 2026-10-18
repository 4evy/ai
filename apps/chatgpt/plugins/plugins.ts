#!/usr/bin/env bun
import { errorMessage } from "@ai/core/error/error";
import { Synchronizer } from "./sync.ts";

async function main(): Promise<void> {
  const [source, marketplace, ...plugins] = Bun.argv.slice(2);
  if (!source || !marketplace) {
    throw new Error("Usage: ai chatgpt plugins sync SOURCE MARKETPLACE [PLUGIN ...]");
  }
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
