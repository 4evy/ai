import { fileURLToPath } from "node:url";
import { errorMessage } from "@ai/core/error/error";
import { launchProcess } from "@ai/core/process/launch";
import { buildPinnedRuntime, lastWorking } from "./runtime.ts";

const args = Bun.argv.slice(2);
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
