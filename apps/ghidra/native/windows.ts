import { join } from "node:path";
import type { NativePlatform } from "./platform.ts";

export const windows: NativePlatform = {
  name: "win32",
  home: (env, home) =>
    join(env.LOCALAPPDATA ?? join(home, "AppData/Local"), "ai-tools/ghidra"),
  state: (env, home) =>
    join(env.LOCALAPPDATA ?? join(home, "AppData/Local"), "ai-tools/ghidra-state"),
  javaHome: "jdk",
  python: "mcp/.venv/Scripts/python.exe",
  executableSuffix: ".exe",
};
