import { readFileSync as readResource } from "node:fs";
import { quotePosixArgument } from "@ai/core/shell/shell";
import { render } from "@ai/core/template/template";
import type * as v from "valibot";
import {
  type ExecutionTarget,
  resolveRemoteCwd,
} from "../../client/execution/execution";
import type { createSudoParameters } from "../tools/schemas/sudo";

const boundedScript = readResource(new URL("./bounded.sh", import.meta.url), "utf8");
const privilegedScript = readResource(
  new URL("./privileged.sh", import.meta.url),
  "utf8",
);
const authenticateScript = readResource(
  new URL("./authenticate.sh", import.meta.url),
  "utf8",
);

export type SudoInput = Omit<
  v.InferInput<ReturnType<typeof createSudoParameters>["sudoParameters"]>,
  "connection"
>;

export const AUTH_SECONDS = 15;

function boundedShell(marker: string, announceTimeout: boolean): string {
  return render(boundedScript, {
    ANNOUNCE: announceTimeout
      ? `printf '%s' ${quotePosixArgument(`${marker}timeout\x1f`)}`
      : ":",
    REDIRECT: announceTimeout ? "2>/dev/null" : ">/dev/null 2>&1",
  });
}

export function sudoShell(
  connection: Pick<ExecutionTarget, "cwd" | "home" | "bash">,
  input: SudoInput,
  seconds: number,
  marker: string,
): string {
  const cwd = resolveRemoteCwd(connection, input.cwd);
  const command = `cd -- ${quotePosixArgument(cwd)} || exit\n${input.command}`;
  const privileged = render(privilegedScript, {
    BOUNDED: boundedShell(marker, true),
    SECONDS: String(seconds),
    BASH: quotePosixArgument(connection.bash),
    COMMAND: quotePosixArgument(command),
  });
  const script = render(authenticateScript, {
    BOUNDED: boundedShell(marker, false),
    AUTH_SECONDS: String(AUTH_SECONDS),
    CREDENTIALS: quotePosixArgument(`${marker}credentials\x1f`),
    REQUIRED: quotePosixArgument(`${marker}required\x1f`),
    REJECTED: quotePosixArgument(`${marker}rejected\x1f`),
    STARTED: quotePosixArgument(`${marker}started\x1f`),
    BASH: quotePosixArgument(connection.bash),
    PRIVILEGED: quotePosixArgument(privileged),
    DONE: quotePosixArgument(`${marker}done:`),
    END: quotePosixArgument("\x1f"),
  });
  return `set +x; set +v; unset BASH_ENV ENV; exec ${quotePosixArgument(
    connection.bash,
  )} --noprofile --norc -c ${quotePosixArgument(script)}`;
}
