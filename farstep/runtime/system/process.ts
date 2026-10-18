import { run as runEffect } from "@ai/core/effect/effect";
import { executeBoundedCommand } from "@ai/core/effect/process/process";
import { SYSTEM_OUTPUT_BYTES } from "farstep/protocol/system";

export async function run(
  argv: string[],
  input?: string,
  signal?: AbortSignal,
  limit = SYSTEM_OUTPUT_BYTES,
) {
  const { code: exitCode, ...output } = await runEffect(
    executeBoundedCommand(argv, {
      stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
      env: { ...process.env, LC_ALL: "C" },
      maxOutputBytes: limit,
      pipeDrainTimeoutMs: 1000,
      terminationGraceMs: 1000,
    }),
    signal,
  );
  return { exitCode, ...output };
}
