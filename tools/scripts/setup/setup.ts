#!/usr/bin/env bun
import { errorMessage } from "@ai/values/error/error";
import { object } from "@optique/core/constructs";
import { formatMessage } from "@optique/core/message";
import { multiple } from "@optique/core/modifiers";
import { parseSync } from "@optique/core/parser";
import { argument, option } from "@optique/core/primitives";
import { valibot } from "@optique/valibot";
import * as v from "valibot";
import { installNixPackage } from "./nix/nix";
import { installUpstream } from "./upstream/upstream";

const tools = ["codex", "claude", "opencode", "omp"] as const;
const parser = object({
  help: multiple(option("-h", "--help")),
  update: multiple(option("--update")),
  dryRun: multiple(option("--dry-run")),
  tools: multiple(
    argument(
      valibot<(typeof tools)[number]>(v.picklist(tools), { placeholder: "codex" }),
    ),
  ),
});

export async function setup(
  args: string[],
  { background = false }: { background?: boolean } = {},
): Promise<void> {
  const parsed = parseSync(parser, args);
  if (!parsed.success) throw new Error(formatMessage(parsed.error));
  if (parsed.value.help.length > 0) {
    console.log("Usage: ai setup|update [codex|claude|opencode|omp ...] [--dry-run]");
    console.log(
      "Codex uses Bun's alpha channel. Claude and OpenCode use Bun's latest releases",
    );
    console.log(
      "Unix setup also installs the Nix launcher bundle. OMP keeps its patched pin",
    );
    return;
  }
  const update = parsed.value.update.length > 0;
  const dryRun = parsed.value.dryRun.length > 0;
  if (process.platform !== "win32" && !update)
    await installNixPackage("ai-tools", false, dryRun);
  for (const tool of new Set(parsed.value.tools.length ? parsed.value.tools : tools)) {
    if (tool === "omp") {
      if (dryRun) console.log("omp: prepare the pinned checkout runtime");
      else {
        const { buildPinnedRuntime } = await import("../omp/runtime/runtime");
        await buildPinnedRuntime();
      }
      continue;
    }
    await installUpstream(tool, update, dryRun, background);
  }
}

if (import.meta.main) {
  try {
    await setup(Bun.argv.slice(2));
  } catch (error) {
    console.error(`ai setup: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
