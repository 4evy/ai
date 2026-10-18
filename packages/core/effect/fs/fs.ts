import { mkdtempDisposable, open } from "node:fs/promises";
import { Effect } from "effect";
import { attempt } from "../effect";

// Acquisition is masked until the scope owns cleanup, including late opens
export function openFile(...args: Parameters<typeof open>) {
  return Effect.acquireDisposable(attempt(() => open(...args)));
}

export function temporaryDirectory(prefix: string) {
  return Effect.acquireDisposable(attempt(() => mkdtempDisposable(prefix)));
}
