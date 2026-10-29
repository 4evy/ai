import { extname } from "node:path";

export function processCommand(executable: string, args: readonly string[]): string[] {
  return [".js", ".mjs", ".cjs", ".ts"].includes(extname(executable))
    ? [process.execPath, executable, ...args]
    : [executable, ...args];
}

export async function launchProcess(
  executable: string,
  args: readonly string[],
  env = process.env,
): Promise<number> {
  const command = processCommand(executable, args);
  const program = command[0];
  if (!program) throw new Error("Missing executable");
  if (process.platform !== "win32" && process.execve)
    process.execve(program, command, env);
  const child = Bun.spawn(command, {
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const stop = () => child.kill();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    return await child.exited;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
