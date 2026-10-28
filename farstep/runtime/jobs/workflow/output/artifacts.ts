import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { attempt } from "@ai/core/effect/effect";
import { syncDirectoryAncestors } from "@ai/core/effect/fs/fs";
import { Effect } from "effect";
import { privateDirectoryEffect } from "../../../state";
import { errorText } from "./parsing";
import type { Files, Options } from "./types";

export const prepareFiles = Effect.fnUntraced(function* (options: Options) {
  const files: Files = {};
  yield* Effect.gen(function* () {
    if (
      !/^[A-Za-z0-9._-]{1,128}$/u.test(options.id) ||
      options.id === "." ||
      options.id === ".."
    )
      return yield* Effect.fail(new Error("Invalid workflow capture id"));
    if (!isAbsolute(options.directory) || /[\0\n]/u.test(options.directory))
      return yield* Effect.fail(
        new Error("Workflow capture directory must be an absolute private path"),
      );
    yield* privateDirectoryEffect(options.directory);
    const root = yield* attempt(() => realpath(options.directory));
    if (root !== resolve(options.directory))
      return yield* Effect.fail(
        new Error("Workflow capture directory must be canonical"),
      );
    const directory = join(root, options.id);
    // Exclusive creation prevents overwriting an earlier run or following a link
    yield* attempt(() => mkdir(directory, { mode: 0o700 }), { awaitOnInterrupt: true });
    yield* privateDirectoryEffect(directory);
    for (const stream of ["stdout", "stderr"] as const) {
      const path = join(directory, `${stream}.bin`);
      // Each StreamCapture takes ownership and closes its artifact after draining
      const file = yield* attempt(
        () =>
          open(
            path,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            0o600,
          ),
        { awaitOnInterrupt: true },
      );
      files[stream] = { path, file };
    }
    yield* attempt(() => syncDirectoryAncestors(directory, 1), {
      awaitOnInterrupt: true,
    });
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        files.error = `Cannot initialize output artifacts: ${errorText(error)}`;
      }),
    ),
  );
  return files;
});
