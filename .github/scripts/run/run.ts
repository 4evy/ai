import { resolve } from "node:path";

export const root = resolve(import.meta.dir, "../../..");

export async function run(command: string[], stdin?: Uint8Array): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: root,
    stdin: stdin ?? "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
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
