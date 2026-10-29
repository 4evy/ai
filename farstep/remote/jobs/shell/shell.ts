import { shellFlags } from "@ai/values/shell/flags";
import { quotePosixArgument } from "@ai/values/shell/shell";
import * as v from "valibot";
import {
  type ExecutionTarget,
  resolveExecutionCwd,
} from "#farstep/client/execution/execution";
import type { ScriptRunner } from "#farstep/protocol/jobs/gateway";
import { checkScriptInput, scriptInputSchema } from "../../../protocol/script/script";
import type { createJobParameters } from "../../tools/schemas/jobs";
import { compileEnvironment } from "./bindings";

type RunInput = Pick<
  v.InferInput<ReturnType<typeof createJobParameters>["runParameters"]>,
  | "script"
  | "params"
  | "captureBytes"
  | "shell"
  | "environment"
  | "envFiles"
  | "env"
  | "login"
>;

export function scriptShell(
  connection: ExecutionTarget,
  input: RunInput,
  runner: ScriptRunner,
) {
  const shell = input.shell ?? "bash";
  if (shell !== "bash" && shell !== "zsh") throw new Error("shell must be bash or zsh");
  const application = shell === "bash" ? connection.bash : connection.zsh;
  if (!application)
    throw new Error(
      `${connection.backend === "local" ? "Local" : "Remote"} ${shell} is unavailable; refresh target shell facts`,
    );
  const setup = shellEnvironment(connection, input, shell);
  checkScriptInput(input);
  const parsed = v.parse(scriptInputSchema, {
    script: input.script,
    params: input.params,
    captureBytes: input.captureBytes,
  });
  const payload = JSON.stringify(parsed);
  // Leave headroom below Linux's per-argument limit after JSON escaping
  if (Buffer.byteLength(payload) > 96 * 1024)
    throw new Error("Encoded script and params exceed 96 KiB");
  // Pass the payload as a positional argument so the shell never parses source
  setup.push('exec "$1" --no-install "$2" --script "$3" "$4" "$5"');
  const command = setup.join("\n");
  const flags = shellFlags(shell, input.login);
  return {
    application,
    command: input.script,
    args: [
      ...flags,
      "-c",
      command,
      "farstep-script",
      runner.application,
      runner.script,
      shell,
      application,
      payload,
    ],
  };
}

function shellEnvironment(
  connection: ExecutionTarget,
  input: RunInput,
  shell: "bash" | "zsh",
): string[] {
  const setup: string[] = [];
  const environment = input.environment ?? "shared";
  if (environment !== "shared" && environment !== "inherit")
    throw new Error("environment must be shared or inherit");
  if (environment === "shared") {
    const file = `${connection.home}/.config/shell/environment.sh`;
    const path = quotePosixArgument(resolveExecutionCwd(connection, file));
    const message = quotePosixArgument(
      `Shared environment file is missing or unreadable: ${file}`,
    );
    setup.push(
      `if [ ! -r ${path} ]; then printf '%s\\n' ${message} >&2; exit 1; fi`,
      "unset _dotfiles_environment_loaded",
      `. ${path} || exit $?`,
    );
  }
  if (input.envFiles?.length) {
    if (input.envFiles.length > 16) throw new Error("At most 16 envFiles are allowed");
    setup.push("set -a");
    for (const file of input.envFiles) {
      const path = quotePosixArgument(resolveExecutionCwd(connection, file));
      setup.push(`. ${path} || exit $?`);
    }
    setup.push("set +a");
  }
  setup.push(...compileEnvironment(input.env ?? {}, shell));
  return setup;
}
