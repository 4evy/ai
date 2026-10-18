import { readText } from "@ai/core/text/text";
export interface SudoDetails {
  timeoutSeconds: number;
  wallTimeMs?: number;
  exitCode?: number;
  timedOut?: boolean;
}

export function sudoState() {
  return {
    commandStarted: false,
    authRequired: false,
    authRejected: false,
    promptCancelled: false,
    invalidPrompt: false,
    timedOut: false,
    localDeadline: false,
    outputLost: false,
    stopConfirmed: false,
    exitCode: undefined as number | undefined,
  };
}

export function sudoStatus(
  state: ReturnType<typeof sudoState>,
  details: SudoDetails,
  seconds: number,
  aborted: boolean,
): { status: string; failed: boolean } {
  const result =
    state.exitCode !== undefined
      ? exitedStatus(state, details, seconds, state.exitCode)
      : {
          status:
            authenticationStatus(state) ??
            pendingStatus(state, details, seconds, aborted),
          failed: true,
        };
  if (state.outputLost)
    result.status += "; raw output continuity was lost to log rotation";
  return result;
}

type SudoState = ReturnType<typeof sudoState>;

function exitedStatus(
  state: SudoState,
  details: SudoDetails,
  seconds: number,
  exitCode: number,
): { status: string; failed: boolean } {
  details.exitCode = exitCode;
  if (state.timedOut || state.localDeadline) details.timedOut = true;
  const failed = exitCode !== 0 || state.timedOut || state.localDeadline;
  const status = state.timedOut
    ? `Sudo exceeded its ${seconds}-second command budget and exited with code ${exitCode}`
    : `Sudo invocation exited with code ${exitCode}${state.localDeadline ? "; the observation budget also elapsed" : ""}`;
  return { status, failed };
}

function authenticationStatus(state: SudoState): string | undefined {
  if (state.authRejected)
    return readText(new URL("./result/result.md", import.meta.url), "authentication");
  if (state.invalidPrompt)
    return "Sudo passwords must be single-line values without NUL characters";
  if (state.promptCancelled)
    return readText(new URL("./result/result.md", import.meta.url), "cancelled", {
      STOP: state.stopConfirmed
        ? "the waiting job was stopped"
        : "the identity-checked stop was attempted but its outcome is unknown",
    });
  if (state.authRequired)
    return readText(new URL("./result/result.md", import.meta.url), "required", {
      STOP: state.stopConfirmed
        ? "The waiting job was stopped"
        : "The identity-checked stop was attempted but its outcome is unknown",
    });
  return undefined;
}

function pendingStatus(
  state: SudoState,
  details: SudoDetails,
  seconds: number,
  aborted: boolean,
): string {
  if (state.timedOut || state.localDeadline) {
    details.timedOut = true;
    return state.commandStarted
      ? `Sudo exceeded its ${seconds}-second command budget; the final command exit is unknown`
      : "Sudo authentication or credential entry exceeded its bounded budget; no command execution was observed";
  }
  if (aborted)
    return state.commandStarted
      ? "Sudo was cancelled; the remote command's final exit is unknown"
      : "Sudo was cancelled before command execution was observed";
  return state.commandStarted
    ? readText(new URL("./result/result.md", import.meta.url), "unknown")
    : "The remote sudo channel ended before command execution was observed; the outcome is unknown";
}
