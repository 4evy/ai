import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { attempt, run } from "@ai/core/effect/effect";
import { openFile } from "@ai/core/effect/fs/fs";
import { Effect } from "effect";

// Windows needs an ACL-based storage adapter before it can share this lifecycle
function directory(variable: string, fallback: string): string {
  const value = process.env[variable] || fallback;
  if (!isAbsolute(value) || value.includes("\0") || value.includes("\n")) {
    throw new Error(`${variable} must be an absolute directory path`);
  }
  return value;
}

export function paths() {
  if (process.platform !== "linux" && process.platform !== "darwin")
    throw new Error("Farstep private storage requires a native platform adapter");
  const home = homedir();
  return {
    state: join(directory("XDG_STATE_HOME", join(home, ".local/state")), "farstep"),
    data: join(directory("XDG_DATA_HOME", join(home, ".local/share")), "farstep"),
    config: directory("XDG_CONFIG_HOME", join(home, ".config")),
    runtime: join(
      directory(
        "XDG_RUNTIME_DIR",
        process.platform === "darwin"
          ? join(
              directory("XDG_STATE_HOME", join(home, ".local/state")),
              "farstep/runtime",
            )
          : `/run/user/${process.getuid?.()}`,
      ),
      "farstep",
    ),
  };
}

export const privateDirectoryEffect = Effect.fnUntraced(function* (path: string) {
  yield* attempt(() => mkdir(path, { recursive: true, mode: 0o700 }), {
    awaitOnInterrupt: true,
  });
  const info = yield* attempt(() => lstat(path));
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  ) {
    return yield* Effect.fail(
      new Error(`Private directory has unsafe ownership, type or permissions: ${path}`),
    );
  }
});

export function privateDirectory(path: string): Promise<void> {
  return run(privateDirectoryEffect(path));
}

export const privateReadEffect = Effect.fnUntraced(function* (path: string) {
  const file = yield* openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const info = yield* attempt(() => file.stat(), { awaitOnInterrupt: true });
  const link = yield* attempt(() => lstat(path));
  if (
    !info.isFile() ||
    link.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  ) {
    return yield* Effect.fail(
      new Error(`Private file has unsafe ownership, type or permissions: ${path}`),
    );
  }
  return yield* attempt((signal) => file.readFile({ encoding: "utf8", signal }), {
    awaitOnInterrupt: true,
  });
}, Effect.scoped);

export function privateRead(path: string): Promise<string> {
  return run(privateReadEffect(path));
}

export const atomicWriteEffect = Effect.fnUntraced(function* (
  path: string,
  content: string,
  mode = 0o600,
) {
  const temporary = join(dirname(path), `.farstep-${randomUUID()}`);
  const file = yield* attempt(() => open(temporary, "wx", mode));
  yield* Effect.acquireUseRelease(
    Effect.succeed(file),
    (file) =>
      Effect.gen(function* () {
        yield* attempt(() => file.writeFile(content));
        yield* attempt(() => file.sync());
        // Windows requires closing the handle before publishing the file
        yield* attempt(() => file.close());
        yield* attempt(() => rename(temporary, path));
      }),
    (file) => attempt(() => file.close()),
  ).pipe(
    Effect.ensuring(attempt(() => rm(temporary, { force: true })).pipe(Effect.orDie)),
  );
  // Publication must finish before a caller can release its mutation lock
}, Effect.uninterruptible);

export function atomicWrite(
  path: string,
  content: string,
  mode = 0o600,
): Promise<void> {
  return run(atomicWriteEffect(path, content, mode));
}
