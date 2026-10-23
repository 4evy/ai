import { resolve } from "node:path";
import { run as runEffect } from "@ai/core/effect/effect";
import { executeCommand } from "@ai/core/effect/process/process";

export const root = resolve(import.meta.dir, "../../..");

export async function run(command: string[], stdin?: Uint8Array): Promise<void> {
  const { code } = await runEffect(
    executeCommand(command, {
      cwd: root,
      stdin: stdin ?? "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  if (code !== 0) throw new Error(`${command.join(" ")} failed (${code})`);
}

export function choice<const Values extends readonly string[]>(
  name: string,
  values: Values,
): Values[number] {
  const input = process.env[name];
  const value = values.find((value) => value === input);
  if (!value) throw new Error(`Unknown ${name}: ${input ?? "(unset)"}`);
  return value;
}
