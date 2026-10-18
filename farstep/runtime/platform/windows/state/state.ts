import { readFileSync as readResource } from "node:fs";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { attempt, run } from "@ai/core/effect/effect";
import { executeCommand } from "@ai/core/effect/process/process";
import { render } from "@ai/core/template/template";
import { Effect } from "effect";
import { atomicWriteEffect as write } from "../../posix/state";

const ownerScript = readResource(new URL("./owner.ps1", import.meta.url), "utf8");
const directoryScript = readResource(
  new URL("./directory.ps1", import.meta.url),
  "utf8",
);
const readScript = readResource(new URL("./read.ps1", import.meta.url), "utf8");

export const atomicWriteEffect = Effect.fnUntraced(function* (
  path: string,
  content: string,
  mode = 0o600,
) {
  yield* write(path, content, mode);
  yield* powershellEffect(render(ownerScript, { PATH: quote(path) }));
}, Effect.uninterruptible);

export function atomicWrite(path: string, content: string, mode = 0o600) {
  return run(atomicWriteEffect(path, content, mode));
}

export function paths() {
  const local = process.env.LOCALAPPDATA;
  if (!local || !isAbsolute(local)) throw new Error("LOCALAPPDATA must be absolute");
  const root = join(local, "Farstep");
  return {
    state: join(root, "state"),
    data: join(root, "data"),
    runtime: join(root, "runtime"),
    config: join(root, "config"),
  };
}
export const powershellEffect = Effect.fnUntraced(function* (script: string) {
  const { stdout, stderr, code } = yield* executeCommand([
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(
      `$ProgressPreference='SilentlyContinue'; ${script}`,
      "utf16le",
    ).toString("base64"),
  ]);
  if (code !== 0)
    return yield* Effect.fail(
      new Error(stderr.trim() || `PowerShell failed (${code})`),
    );
  return stdout.trim();
});

export function powershell(script: string) {
  return run(powershellEffect(script));
}
export const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
export const privateDirectoryEffect = Effect.fnUntraced(function* (path: string) {
  yield* attempt(() => mkdir(path, { recursive: true }), { awaitOnInterrupt: true });
  const info = yield* attempt(() => lstat(path));
  if (!info.isDirectory() || info.isSymbolicLink())
    return yield* Effect.fail(new Error(`Unsafe private directory: ${path}`));
  yield* powershellEffect(render(directoryScript, { PATH: quote(path) }));
});

export function privateDirectory(path: string) {
  return run(privateDirectoryEffect(path));
}
export const privateReadEffect = Effect.fnUntraced(function* (path: string) {
  const info = yield* attempt(() => lstat(path));
  if (!info.isFile() || info.isSymbolicLink())
    return yield* Effect.fail(new Error(`Unsafe private file: ${path}`));
  yield* powershellEffect(render(readScript, { PATH: quote(path) }));
  return yield* attempt((signal) => readFile(path, { encoding: "utf8", signal }), {
    awaitOnInterrupt: true,
  });
});

export function privateRead(path: string) {
  return run(privateReadEffect(path));
}
