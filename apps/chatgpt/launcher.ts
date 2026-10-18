#!/usr/bin/env bun
import { execProcess, prepareLaunch } from "../codex/lib/codex.ts";

const real = process.env.CODEX_REAL_BIN;
if (!real) throw new Error("CODEX_REAL_BIN is required");
const args = Bun.argv.slice(2);
const interactive = await prepareLaunch(real, args);
// Automation's hook bypass selects embedded mode instead of the shared server
process.exitCode = await execProcess(real, [
  ...(interactive ? [] : ["--dangerously-bypass-hook-trust"]),
  ...args,
]);
