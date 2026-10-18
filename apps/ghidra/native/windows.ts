import { join } from "node:path";
import { command, type NativePlatform } from "./platform.ts";

export const windows: NativePlatform = {
  name: "win32",
  home: (env, home) =>
    join(env.LOCALAPPDATA ?? join(home, "AppData/Local"), "ai-tools/ghidra"),
  state: (env, home) =>
    join(env.LOCALAPPDATA ?? join(home, "AppData/Local"), "ai-tools/ghidra-state"),
  javaHome: "jdk",
  python: "mcp/.venv/Scripts/python.exe",
  executableSuffix: ".exe",
  extractZip: (archive, destination) =>
    command(
      [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:AI_GHIDRA_ARCHIVE -DestinationPath $env:AI_GHIDRA_DESTINATION",
      ],
      {
        env: {
          ...process.env,
          AI_GHIDRA_ARCHIVE: archive,
          AI_GHIDRA_DESTINATION: destination,
        },
      },
    ),
};
