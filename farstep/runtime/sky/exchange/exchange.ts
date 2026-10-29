import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, realpath, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { attempt, run } from "@ai/runtime/effect/effect";
import { openFile, stagedFile, syncDirectoryAncestors } from "@ai/runtime/effect/fs/fs";
import { readText } from "@ai/toolkit/text/text";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { Effect } from "effect";
import { MAX_SYNC_BYTES } from "farstep/protocol/sky/limits";
import * as v from "valibot";
import type { ToolRegistrar } from "../../jobs/tools";

const LIMIT = MAX_SYNC_BYTES;
const pathSchema = v.pipe(v.string(), v.minLength(1), v.excludes("\0"));
const hashSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

const readEffect = Effect.fnUntraced(function* (path: string) {
  const file = yield* openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const info = yield* attempt(() => file.stat({ bigint: true }));
  if (!info.isFile() || info.size > BigInt(LIMIT))
    return yield* Effect.fail(
      new Error("Sky exchange supports regular files up to 8 MiB"),
    );
  const data = Buffer.alloc(LIMIT + 1);
  let size = 0;
  while (size < data.length) {
    const { bytesRead } = yield* attempt(
      () => file.read(data, size, data.length - size, null),
      { awaitOnInterrupt: true },
    );
    if (bytesRead === 0) break;
    size += bytesRead;
  }
  if (size > LIMIT)
    return yield* Effect.fail(new Error("Sky exchange file grew beyond 8 MiB"));
  const latest = yield* attempt(() => file.stat({ bigint: true }));
  if (
    latest.size !== info.size ||
    latest.mtimeNs !== info.mtimeNs ||
    latest.ctimeNs !== info.ctimeNs
  )
    return yield* Effect.fail(
      new Error("Sky exchange conflict: source changed during export"),
    );
  const bytes = data.subarray(0, size);
  return { data: bytes.toString("base64"), sha256: digest(bytes), size };
}, Effect.scoped);

const writeEffect = Effect.fnUntraced(function* (
  path: string,
  data: Buffer,
  sha256: string,
  expectedSha256: string | null,
) {
  const previous = yield* Effect.gen(function* () {
    const info = yield* attempt(() => lstat(path));
    if (!info.isFile() || info.isSymbolicLink())
      return yield* Effect.fail(new Error("Destination must be a regular file"));
    return { sha256: (yield* readEffect(path)).sha256, mode: info.mode & 0o777 };
  }).pipe(
    Effect.catch((error) =>
      isEnoent(error)
        ? Effect.succeed({ sha256: null, mode: 0o600 })
        : Effect.fail(error),
    ),
  );
  const result = (changed: boolean) => ({
    content: [],
    structuredContent: { path, sha256, size: data.length, changed },
  });
  // Identical content makes a retry after a lost acknowledgment harmless
  if (previous.sha256 === sha256) return result(false);
  if (previous.sha256 !== expectedSha256)
    return yield* Effect.fail(
      new Error(
        `Sky exchange conflict: destination digest is ${previous.sha256 ?? "missing"}`,
      ),
    );
  const staged = yield* stagedFile(path, previous.mode);
  yield* attempt(() => staged.write(data), { awaitOnInterrupt: true });
  // Detect edits by writers that do not participate in the Farstep lock
  const latest = yield* readEffect(path).pipe(
    Effect.map((value) => value.sha256),
    Effect.catch((error) =>
      isEnoent(error) ? Effect.succeed(null) : Effect.fail(error),
    ),
  );
  if (latest !== previous.sha256)
    return yield* Effect.fail(
      new Error("Sky exchange conflict: destination changed during import"),
    );
  yield* Effect.gen(function* () {
    yield* attempt(() => rename(staged.path, path));
    if (process.platform !== "win32")
      yield* attempt(() => syncDirectoryAncestors(dirname(path), 1));
  }).pipe(Effect.uninterruptible);
  return result(true);
}, Effect.scoped);

export function registerExchange(
  register: ToolRegistrar,
  requireHandshake: () => void,
  cwd: string,
  disconnected: AbortSignal,
) {
  register(
    "sky.file.read",
    {
      inputSchema: v.strictObject({ path: pathSchema }),
      description: "Export a regular file up to 8 MiB with its SHA-256 digest",
    },
    async ({ path }, caller) => {
      requireHandshake();
      const signal = AbortSignal.any([caller, disconnected]);
      signal.throwIfAborted();
      return {
        content: [],
        structuredContent: await run(readEffect(resolve(cwd, path)), signal),
      };
    },
  );
  register(
    "sky.file.write",
    {
      inputSchema: v.strictObject({
        path: pathSchema,
        data: v.pipe(v.string(), v.maxLength(Math.ceil(LIMIT / 3) * 4)),
        sha256: hashSchema,
        expectedSha256: v.nullable(hashSchema),
      }),
      description: readText(new URL("./exchange.md", import.meta.url), "import"),
    },
    async (input, caller) => {
      requireHandshake();
      const signal = AbortSignal.any([caller, disconnected]);
      const data = Buffer.from(input.data, "base64");
      if (
        data.length > LIMIT ||
        data.toString("base64") !== input.data ||
        digest(data) !== input.sha256
      )
        throw new Error("Sky exchange content or SHA-256 mismatch");
      const destination = resolve(cwd, input.path);
      const parent = await realpath(dirname(destination));
      const path = join(parent, destination.slice(dirname(destination).length + 1));
      return await withFileLock(
        path,
        () => run(writeEffect(path, data, input.sha256, input.expectedSha256), signal),
        { signal, retries: 120, retryDelayMs: 250 },
      );
    },
  );
}
