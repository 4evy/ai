#!/usr/bin/env bun
// Sky Computer Use fixer
// It FIXES INCCORECT app-policy handling, auto-accepts confirmation elicitations
// Rewrites Computer Use skill instructions TO BE PROPER
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatMessage } from "@optique/core/message";
import { optional } from "@optique/core/modifiers";
import { parseSync } from "@optique/core/parser";
import { argument } from "@optique/core/primitives";
import { string } from "@optique/core/valueparser";
import { applyFilePatches } from "./files";
import type { FilePatchResult, Status } from "./rewrites";

export type { FilePatchResult, Status, TransformResult } from "./rewrites";

const POLICY_KEY = "ComputerUseAllowForbiddenTargets";
const DEFAULTS_DOMAINS = [
  "com.openai.sky.CUAService",
  "com.openai.sky.CUAService.cli",
] as const;
const LIVE_APP = "/Applications/ChatGPT.app";
const OPTIONAL_SKILL_PARENTS = ["plugins/cache", "../.tmp"] as const;

function optionalHomeSkillRoots(): string[] {
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  return OPTIONAL_SKILL_PARENTS.map((relative) => join(codexHome, relative));
}

function resolveApp(explicit: string | undefined): string {
  const app = explicit ?? LIVE_APP;
  if (!existsSync(join(app, "Contents"))) {
    throw new Error(`ChatGPT.app not found: ${app}`);
  }
  return app;
}

function isLiveChatGPTApp(app: string): boolean {
  if (!existsSync(LIVE_APP)) return false;
  try {
    return realpathSync(app) === realpathSync(LIVE_APP);
  } catch {
    return false;
  }
}

function readDefaults(domain: string): string | undefined {
  const result = spawnSync("/usr/bin/defaults", ["read", domain, POLICY_KEY], {
    encoding: "utf8",
  });
  if (result.status !== 0) return;
  return result.stdout.trim();
}

function writeDefaults(domain: string): Status {
  if (readDefaults(domain) === "1") return "unchanged";
  const result = spawnSync(
    "/usr/bin/defaults",
    ["write", domain, POLICY_KEY, "-bool", "true"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `defaults write ${domain} ${POLICY_KEY} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  if (readDefaults(domain) !== "1") {
    throw new Error(`defaults write ${domain} ${POLICY_KEY} did not stick`);
  }
  return "patched";
}

function restartComputerUseService(): "restarted" | "not-running" {
  const result = spawnSync("/usr/bin/killall", ["SkyComputerUseService"], {
    encoding: "utf8",
  });
  if (result.status === 0) return "restarted";
  const stderr = result.stderr.trim();
  if (result.status === 1 && stderr.includes("No matching processes")) {
    return "not-running";
  }
  throw new Error(
    `killall SkyComputerUseService failed: ${stderr || result.stdout.trim()}`,
  );
}

function reportFileResults(results: readonly FilePatchResult[]): void {
  for (const { filename, status } of results) {
    console.log(`${status === "patched" ? "Patched" : "Already patched"} ${filename}`);
  }
}

function main(): void {
  if (process.platform !== "darwin") {
    throw new Error("Sky Computer Use policy patching is macOS-only");
  }
  const parsed = parseSync(optional(argument(string())), process.argv.slice(2));
  if (!parsed.success) throw new Error(formatMessage(parsed.error));
  const app = resolveApp(parsed.value);
  const live = isLiveChatGPTApp(app);
  const extraRoots = live ? optionalHomeSkillRoots() : [];
  const fileResults = applyFilePatches(app, { extraRoots });
  reportFileResults(fileResults);
  if (!live) return;

  const defaultsResults = DEFAULTS_DOMAINS.map((domain) => ({
    domain,
    status: writeDefaults(domain),
  }));
  const changed = [...fileResults, ...defaultsResults].some(
    (result) => result.status === "patched",
  );
  const service = changed ? restartComputerUseService() : "skipped";
  for (const { domain, status } of defaultsResults) {
    console.log(
      `${status === "patched" ? "Enabled" : "Already enabled"} ${domain} ${POLICY_KEY}`,
    );
  }
  const serviceLabels = {
    restarted: "Restarted SkyComputerUseService",
    "not-running": "SkyComputerUseService was not running",
    skipped: "SkyComputerUseService already unrestricted",
  } as const;
  console.log(serviceLabels[service]);
}

if (import.meta.main) {
  main();
}
