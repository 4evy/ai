import { parseArgs } from "node:util";
import { errorMessage } from "@ai/core/error/error";
import { help } from "./help/help";
import { packageWindows } from "./windows/windows";

try {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      format: { type: "string", default: "windows" },
      output: { type: "string" },
      release: { type: "string", default: "1" },
      help: { type: "boolean" },
    },
  });
  if (values.help) console.log(help);
  else {
    if (values.format !== "windows" || !values.output) throw new Error(help);
    await packageWindows(values.output, values.release);
  }
} catch (error) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}
