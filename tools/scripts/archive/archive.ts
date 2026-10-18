import { mkdir, readdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { attempt, run } from "@ai/core/effect/effect";
import { temporaryDirectory } from "@ai/core/effect/fs/fs";
import { downloadFile } from "@ai/core/effect/http/http";
import { Effect } from "effect";

export const extractArchiveEffect = Effect.fnUntraced(function* (
  archive: string,
  destination: string,
) {
  yield* attempt(() => mkdir(destination, { recursive: true }), {
    awaitOnInterrupt: true,
  });
  const staging = yield* temporaryDirectory(join(dirname(destination), ".archive-"));
  const contents = yield* attempt(() => Bun.file(archive).bytes());
  yield* attempt(() => new Bun.Archive(contents).extract(staging.path), {
    awaitOnInterrupt: true,
  });
  const roots = yield* attempt(() => readdir(staging.path, { withFileTypes: true }));
  const root = roots[0];
  if (roots.length !== 1 || !root?.isDirectory())
    return yield* Effect.fail(
      new Error("Expected an archive with one top-level directory"),
    );
  const source = join(staging.path, root.name);
  const names = yield* attempt(() => readdir(source));
  yield* Effect.forEach(
    names,
    (name) =>
      attempt(() => rename(join(source, name), join(destination, name)), {
        awaitOnInterrupt: true,
      }),
    { discard: true },
  );
}, Effect.scoped);

export function extractArchive(archive: string, destination: string): Promise<void> {
  return run(extractArchiveEffect(archive, destination));
}

export function downloadArchiveEffect(url: string, destination: string) {
  return downloadFile(url, destination, "Archive download").pipe(
    Effect.timeoutOrElse({
      duration: 10 * 60_000,
      orElse: () => Effect.fail(new Error(`Archive download timed out: ${url}`)),
    }),
    Effect.asVoid,
  );
}

export function downloadArchive(
  url: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  return run(downloadArchiveEffect(url, destination), signal);
}
