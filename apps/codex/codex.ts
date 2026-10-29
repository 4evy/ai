#!/usr/bin/env bun
import { flushObservability } from "@ai/runtime/effect/effect";
import { errorMessage } from "@ai/values/error/error";
import { scheduleCodexUpdate } from "../../tools/scripts/setup/automatic.ts";
import { findBinary } from "../../tools/scripts/setup/binary.ts";
import { execProcess, prepareLaunch } from "./lib/codex.ts";

const real = findBinary("codex", import.meta.path);
const args = Bun.argv.slice(2);
if (
  process.stdin.isTTY &&
  process.stdout.isTTY &&
  !process.env.CODEX_REAL_BIN &&
  !args.some((arg) => ["--version", "-V", "--help", "-h"].includes(arg))
) {
  try {
    await scheduleCodexUpdate();
  } catch (error) {
    console.error(`codex: could not schedule update: ${errorMessage(error)}`);
  }
}
const interactive = await prepareLaunch(real, args);
await flushObservability();
process.exitCode = await execProcess(real, [
  ...(interactive ? [] : ["--dangerously-bypass-hook-trust"]),
  ...args,
]);
