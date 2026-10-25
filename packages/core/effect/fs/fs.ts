import { mkdtempDisposable, open } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect } from "effect";
import { attempt } from "../effect";

// Acquisition is masked until the scope owns cleanup, including late opens
export function openFile(...args: Parameters<typeof open>) {
  return Effect.acquireDisposable(attempt(() => open(...args)));
}

export function temporaryDirectory(prefix: string) {
  return Effect.acquireDisposable(attempt(() => mkdtempDisposable(prefix)));
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
