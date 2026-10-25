export interface NativePlatform {
  name: "win32";
  home(environment: NodeJS.ProcessEnv, home: string): string;
  state(environment: NodeJS.ProcessEnv, home: string): string;
  javaHome: string;
  python: string;
  executableSuffix: string;
}

export async function command(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const child = Bun.spawn(args, { ...options, stdout: "inherit", stderr: "inherit" });
  const stop = () => child.kill();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const code = await child.exited;
    if (code !== 0) throw new Error(`${args[0]} failed with exit code ${code}`);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
