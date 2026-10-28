import { mkdir, readdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { attempt, run } from "@ai/core/effect/effect";
import { temporaryDirectory } from "@ai/core/effect/fs/fs";
import { type DownloadOptions, downloadFile } from "@ai/core/effect/http/http";
import { extractArchive as unpack } from "@oh-my-pi/pi-utils/ar";
import { Effect } from "effect";

export const extractArchiveEffect = Effect.fnUntraced(function* (
  archive: string,
  destination: string,
  stripRoot = true,
) {
  yield* attempt(() => mkdir(destination, { recursive: true }), {
    awaitOnInterrupt: true,
  });
  const staging = yield* temporaryDirectory(join(dirname(destination), ".archive-"));
  if (archive.endsWith(".zip")) {
    yield* attempt(
      () =>
        unpack(archive, staging.path, {
          // Match the existing Sky runtime policy for large SDK and JDK payloads
          limits: { maxInMemorySize: 4 * 1024 ** 3, maxMemberSize: 1024 ** 3 },
        }),
      { awaitOnInterrupt: true },
    );
  } else {
    // The archive library materializes tar symlinks as files; retain native links
    const contents = yield* attempt(() => Bun.file(archive).bytes());
    yield* attempt(() => new Bun.Archive(contents).extract(staging.path), {
      awaitOnInterrupt: true,
    });
  }
  const roots = yield* attempt(() => readdir(staging.path, { withFileTypes: true }));
  const root = roots[0];
  if (stripRoot && (roots.length !== 1 || !root?.isDirectory()))
    return yield* Effect.fail(
      new Error("Expected an archive with one top-level directory"),
    );
  const source = stripRoot && root ? join(staging.path, root.name) : staging.path;
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

export function extractArchive(
  archive: string,
  destination: string,
  stripRoot = true,
): Promise<void> {
  return run(extractArchiveEffect(archive, destination, stripRoot));
}

// Return the streaming SHA-256 digest
// Expected checksums reject before publication
export function downloadArchiveEffect(
  url: string,
  destination: string,
  options: DownloadOptions = {},
) {
  return downloadFile(url, destination, "Archive download", options).pipe(
    Effect.timeoutOrElse({
      duration: 10 * 60_000,
      orElse: () => Effect.fail(new Error(`Archive download timed out: ${url}`)),
    }),
  );
}

export function downloadArchive(
  url: string,
  destination: string,
  options: DownloadOptions = {},
  signal?: AbortSignal,
): Promise<string> {
  return run(downloadArchiveEffect(url, destination, options), signal);
}
