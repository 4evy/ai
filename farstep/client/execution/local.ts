import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { attempt, run } from "@ai/core/effect/effect";
import { readText } from "@ai/core/text/text";
import { isFsError } from "@oh-my-pi/pi-utils";
import { Effect } from "effect";
import { type ExecutionTarget, pathValue } from "./execution";

export interface LocalTarget extends ExecutionTarget {
  backend: "local";
  id: "local";
  zsh?: string | undefined;
  info: { os: "linux" | "macos"; shell: "bash" };
  arch: string;
}

const LOCAL_ARCHITECTURES: Partial<
  Record<NodeJS.Platform, Partial<Record<NodeJS.Architecture, string>>>
> = {
  linux: { x64: "x86_64", arm64: "aarch64" },
  darwin: { x64: "x86_64" },
};

const executable = Effect.fnUntraced(
  function* (path: string | null) {
    if (!path || !isAbsolute(path)) return;
    yield* attempt(() => access(path, constants.X_OK));
    if (!(yield* attempt(() => stat(path))).isFile()) return;
    return yield* attempt(() => realpath(path));
  },
  (effect) =>
    effect.pipe(
      Effect.catch((error) =>
        isFsError(error) && ["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)
          ? Effect.succeed(undefined)
          : Effect.fail(error),
      ),
    ),
);

export const localTargetEffect = Effect.fnUntraced(function* (
  cwd: string,
): Effect.fn.Return<LocalTarget, unknown> {
  if (process.platform !== "darwin" && process.platform !== "linux")
    return yield* Effect.fail(new Error("Local managed jobs require Linux or macOS"));
  yield* Effect.try({
    try: () => pathValue(cwd, "Local cwd"),
    catch: (error) => error,
  });
  const directory = yield* attempt(() => realpath(resolve(cwd)));
  if (!(yield* attempt(() => stat(directory))).isDirectory())
    return yield* Effect.fail(new Error(`Local cwd is not a directory: ${directory}`));
  yield* attempt(() => access(directory, constants.X_OK));
  const bash = yield* executable(Bun.which("bash", { cwd: directory }));
  if (!bash)
    return yield* Effect.fail(
      new Error(
        "Local Bash is unavailable; install Bash and add it to the agent's PATH",
      ),
    );
  const zsh = yield* executable(Bun.which("zsh", { cwd: directory }));
  return {
    backend: "local",
    id: "local",
    home: homedir(),
    cwd: directory,
    bash,
    ...(zsh ? { zsh } : {}),
    info: { os: process.platform === "darwin" ? "macos" : "linux", shell: "bash" },
    arch: LOCAL_ARCHITECTURES[process.platform]?.[process.arch] ?? process.arch,
  };
});

export function localTarget(cwd: string): Promise<LocalTarget> {
  return run(localTargetEffect(cwd));
}

export const localHelperEffect = Effect.fnUntraced(function* (target: LocalTarget) {
  const data = process.env.XDG_DATA_HOME || join(target.home, ".local/share");
  const candidates = [
    join(data, "farstep/current/bin/farstep"),
    Bun.which("farstep", { cwd: target.cwd }),
    "/run/current-system/sw/bin/farstep",
    "/usr/bin/farstep",
    "/usr/local/bin/farstep",
  ];
  for (const candidate of candidates) {
    const helper = yield* executable(candidate);
    if (helper) return helper;
  }
  return yield* Effect.fail(
    new Error(readText(new URL("./local/local.md", import.meta.url), "missing")),
  );
});

export function localHelper(target: LocalTarget): Promise<string> {
  return run(localHelperEffect(target));
}
