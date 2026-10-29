#!/usr/bin/env bun
import { launchProcess } from "@ai/runtime/process/launch";
import { findBinary } from "../../tools/scripts/setup/binary.ts";

process.exitCode = await launchProcess(
  findBinary("opencode", import.meta.path),
  Bun.argv.slice(2),
);
