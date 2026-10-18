import { realpathSync } from "node:fs";
import { delimiter, join } from "node:path";

function canonical(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

export function findBinary(
  name: "codex" | "claude" | "opencode",
  wrapper?: string,
): string {
  const variable = `${name.toUpperCase()}_REAL_BIN`;
  const explicit = process.env[variable];
  const excluded = new Set(
    [
      wrapper,
      process.env.AI_TOOLS_WRAPPER_BIN,
      join(import.meta.dir, `../../../apps/${name}/${name}.ts`),
      join(import.meta.dir, `../../../apps/${name}/${name}.js`),
    ]
      .filter((path): path is string => Boolean(path))
      .map(canonical),
  );
  const filename = process.platform === "win32" ? `${name}.exe` : name;
  const global = explicit ? undefined : bunBinary(name);
  const candidates = explicit
    ? [explicit]
    : [
        ...(global ? [global] : []),
        ...(process.env.LOCALAPPDATA
          ? [join(process.env.LOCALAPPDATA, "Microsoft/WinGet/Links", filename)]
          : []),
        ...(process.env.PATH ?? "")
          .split(delimiter)
          .filter(Boolean)
          .map((directory) => join(directory, filename)),
      ];
  for (const candidate of candidates) {
    const executable = Bun.which(candidate);
    const path = executable && canonical(executable);
    if (path && !excluded.has(path)) return path;
  }
  throw new Error(
    `${name}: upstream binary not found${explicit ? ` at ${explicit}` : `. Run ai setup ${name}`}`,
  );
}

export function bunBinary(name: "codex" | "claude" | "opencode"): string | undefined {
  const result = Bun.spawnSync([process.execPath, "pm", "bin", "--global"], {
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return undefined;
  const directory = result.stdout.toString().trim();
  if (!directory) return undefined;
  // OpenCode 2 also publishes opencode2, which can survive a conflicting bin link
  for (const command of name === "opencode" ? [name, "opencode2"] : [name]) {
    const executable = Bun.which(
      join(directory, process.platform === "win32" ? `${command}.exe` : command),
    );
    if (executable) return canonical(executable);
  }
  return undefined;
}
