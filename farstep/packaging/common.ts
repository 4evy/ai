import { run as runEffect } from "@ai/core/effect/effect";
import { executeCommand } from "@ai/core/effect/process/process";
import { Effect } from "effect";
export const commandEffect = Effect.fnUntraced(function* (
  args: string[],
  cwd: string,
  env = process.env,
) {
  const { code } = yield* executeCommand(args, {
    cwd,
    env,
    stdout: 2,
    stderr: "inherit",
  });
  if (code !== 0)
    return yield* Effect.fail(new Error(`${args.join(" ")} failed (${code})`));
});

export function run(args: string[], cwd: string, env = process.env): Promise<void> {
  return runEffect(commandEffect(args, cwd, env));
}
