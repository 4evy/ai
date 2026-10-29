import { errorMessage } from "@ai/core/error/error";
import { object } from "@optique/core/constructs";
import { formatMessage } from "@optique/core/message";
import { optional, withDefault } from "@optique/core/modifiers";
import { parseSync } from "@optique/core/parser";
import { flag, option } from "@optique/core/primitives";
import { string } from "@optique/core/valueparser";
import { help } from "./help/help";
import { packageWindows } from "./windows/windows";

try {
  const parsed = parseSync(
    object({
      format: withDefault(option("--format", string()), "windows"),
      output: optional(option("--output", string())),
      release: withDefault(option("--release", string()), "1"),
      help: withDefault(flag("--help"), false),
    }),
    Bun.argv.slice(2),
  );
  if (!parsed.success) throw new Error(formatMessage(parsed.error));
  const values = parsed.value;
  if (values.help) console.log(help);
  else {
    if (values.format !== "windows" || !values.output) throw new Error(help);
    await packageWindows(values.output, values.release);
  }
} catch (error) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}
