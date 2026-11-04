import { Data } from "effect";
import { ProcessOutput } from "zx";

export class CommandError extends Data.TaggedError("CommandError")<{
  readonly message: string;
  readonly phase: "input" | "execute" | "exit" | "decode";
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly cause: unknown;
}> {}

export function commandError(
  argv: readonly string[],
  phase: CommandError["phase"],
  cause: unknown,
): CommandError {
  if (cause instanceof CommandError) return cause;
  const result = cause instanceof ProcessOutput ? cause : undefined;
  return new CommandError({
    message: cause instanceof Error ? cause.message : String(cause),
    phase,
    argv,
    exitCode: result?.exitCode ?? null,
    signal: result?.signal ?? null,
    stdout: result?.stdout ?? "",
    stderr: result?.stderr ?? "",
    cause,
  });
}
