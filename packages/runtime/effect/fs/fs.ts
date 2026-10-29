import { randomUUID } from "node:crypto";
import { mkdtempDisposable, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { attempt, run } from "../effect";

// Acquisition is masked until the scope owns cleanup, including late opens
export function openFile(...args: Parameters<typeof open>) {
  return Effect.acquireDisposable(attempt(() => open(...args)));
}

export function temporaryDirectory(prefix: string) {
  return Effect.acquireDisposable(attempt(() => mkdtempDisposable(prefix)));
}

/**
 * Acquire an exclusive sibling file, removed on disposal even after a failed write
 * `write` syncs and closes it. Streaming callers use `file` and close it before
 * publishing `path` with link or rename
 * Conflict checks and directory syncing remain the caller's responsibility
 */
export async function stageFile(destination: string, mode = 0o600) {
  const path = join(dirname(destination), `.ai-stage-${randomUUID()}`);
  const file = await open(path, "wx", mode);
  return {
    path,
    file,
    // Flush and close before publication, including on Windows
    async write(content: string | Uint8Array): Promise<void> {
      await file.writeFile(content);
      await file.sync();
      await file.close();
    },
    async [Symbol.asyncDispose](): Promise<void> {
      try {
        await file.close();
      } finally {
        await rm(path, { force: true });
      }
    },
  };
}

// The Effect scope owns cleanup, including acquisition that completes during abort
export function stagedFile(destination: string, mode = 0o600) {
  return Effect.acquireDisposable(attempt(() => stageFile(destination, mode)));
}

// Finish publication before a caller can release its mutation lock
// File contents are synced, but callers choose which directory entries to sync
export const atomicWriteEffect = Effect.fnUntraced(
  function* (path: string, content: string | Uint8Array, mode = 0o600) {
    const staged = yield* stagedFile(path, mode);
    yield* attempt(() => staged.write(content));
    yield* attempt(() => rename(staged.path, path));
  },
  Effect.scoped,
  Effect.uninterruptible,
);

export function atomicWrite(path: string, content: string | Uint8Array, mode = 0o600) {
  return run(atomicWriteEffect(path, content, mode));
}

// Flush newly published directory entries nearest-first, up to the root
export async function syncDirectoryAncestors(directory: string, count: number) {
  for (let index = 0; index < count; index++) {
    await using file = await open(directory, "r");
    await file.sync();
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}
