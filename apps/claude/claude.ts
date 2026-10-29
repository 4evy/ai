#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { launchProcess } from "@ai/runtime/process/launch";
import * as v from "valibot";
import { scheduleClaudeUpdate } from "../../tools/scripts/setup/automatic.ts";
import { findBinary } from "../../tools/scripts/setup/binary.ts";

const home = homedir();
const configDir = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
if (!isAbsolute(configDir)) {
  console.error("claude: CLAUDE_CONFIG_DIR must be an absolute path");
  process.exit(1);
}
// Exporting the default would also relocate ~/.claude.json into ~/.claude

// Apply startup-only variables before the underlying CLI reads its settings
const settingsSchema = v.object({
  env: v.optional(
    v.record(
      v.pipe(v.string(), v.regex(/^[A-Za-z_][A-Za-z0-9_]*$/)),
      v.nullable(v.string()),
    ),
    {},
  ),
});
try {
  const settings = v.parse(
    settingsSchema,
    JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8").trim() || "{}"),
  );
  for (const [name, value] of Object.entries(settings.env)) {
    if (value !== null && name !== "CLAUDE_CONFIG_DIR") process.env[name] = value;
  }
} catch (error) {
  if (
    !error ||
    typeof error !== "object" ||
    !("code" in error) ||
    error.code !== "ENOENT"
  ) {
    console.error("claude: could not read the user settings environment");
    process.exit(1);
  }
}

const real = findBinary("claude", import.meta.path);
const args = Bun.argv.slice(2);
const updatesDisabled =
  [process.env.DISABLE_AUTOUPDATER, process.env.DISABLE_UPDATES].some((value) =>
    ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? ""),
  ) || Boolean(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC);
if (!process.env.CLAUDE_REAL_BIN && !updatesDisabled) {
  if (!args.some((arg) => ["--version", "-v", "--help", "-h"].includes(arg))) {
    try {
      await scheduleClaudeUpdate();
    } catch {
      console.error("claude: could not schedule the package update check");
    }
  }
  // Keep CLI package updates in the host's package manager
  // The host marker lets plugin updates follow their own settings instead
  process.env.DISABLE_AUTOUPDATER = "1";
  process.env.CLAUDE_CODE_AUTOUPDATER_DISABLED_BY_HOST = "1";
}
process.exitCode = await launchProcess(real, args);
