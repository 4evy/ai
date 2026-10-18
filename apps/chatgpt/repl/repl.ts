#!/usr/bin/env bun
import { delimiter, dirname, join, resolve } from "node:path";
import { isRecord } from "@ai/core/value/value";
import { execProcess } from "../../codex/lib/codex.ts";
import { MARKETPLACE } from "../plugins/marketplace.ts";

const [resources, defaultHome, ...args] = Bun.argv.slice(2);
if (!resources || !defaultHome)
  throw new Error("Usage: bun repl.ts RESOURCES CODEX_HOME [ARGUMENTS...]");
const codexHome = process.env.CODEX_HOME ?? defaultHome;
let services: unknown;
try {
  services = JSON.parse(process.env.NODE_REPL_TRUSTED_SERVICES ?? "{}");
} catch {
  services = {};
}
const browser = isRecord(services) ? services.browser : undefined;
if (typeof browser === "string") {
  const service = resolve(browser);
  const bundled = resolve(
    resources,
    "plugins/openai-bundled/plugins/browser/scripts/browser-service.mjs",
  );
  const scripts = dirname(service);
  const version = dirname(scripts);
  const browserRoot = dirname(version);
  const cached = ["openai-bundled", MARKETPLACE].some(
    (marketplace) =>
      browserRoot === resolve(codexHome, "plugins/cache", marketplace, "browser"),
  );
  if (
    service === bundled ||
    (cached && scripts.endsWith("/scripts") && service.endsWith("/browser-service.mjs"))
  ) {
    // ChatGPT can replace the bundled browser service with a cached plugin
    const roots = [scripts, process.env.NODE_REPL_NODE_MODULE_DIRS]
      .filter(Boolean)
      .join(delimiter);
    process.env.NODE_REPL_NODE_MODULE_DIRS = roots;
    process.env.NODE_REPL_TRUSTED_CODE_PATHS = roots;
  }
}
process.exitCode = await execProcess(join(resources, "cua_node/bin/node_repl"), args);
