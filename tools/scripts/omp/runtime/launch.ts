import { fileURLToPath } from "node:url";
import { launchProcess } from "@ai/runtime/process/launch";
import { errorMessage } from "@ai/values/error/error";
import { formatMessage } from "@optique/core/message";
import { withDefault } from "@optique/core/modifiers";
import { parseSync } from "@optique/core/parser";
import { passThrough } from "@optique/core/primitives";
import { buildPinnedRuntime, lastWorking } from "./runtime.ts";

const parsed = parseSync(
  withDefault(passThrough({ format: "greedy" }), []),
  Bun.argv.slice(2),
);
if (!parsed.success) throw new Error(formatMessage(parsed.error));
const args = parsed.value;
if (
  args[0] === "update" &&
  !args.some((arg) =>
    ["--check", "-c", "--plugins", "-l", "--help", "-h"].includes(arg),
  )
) {
  console.error("omp: this runtime keeps our patched pin; use just omp update VERSION");
  process.exit(1);
}

process.env.AI_TOOLS_REPO ??= fileURLToPath(new URL("../../../../", import.meta.url));
let cli: string;
try {
  cli = await buildPinnedRuntime();
} catch (error) {
  console.error(`omp: ${errorMessage(error)}`);
  cli = await lastWorking();
  console.error("omp: rebuild failed; starting the last working patched version");
}
process.exitCode = await launchProcess(process.execPath, [cli, ...args]);
