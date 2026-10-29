import { randomUUID } from "node:crypto";
import { lstat, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { attempt, run } from "@ai/runtime/effect/effect";
import { openFile, syncDirectoryAncestors } from "@ai/runtime/effect/fs/fs";
import { isEexist, isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { Effect } from "effect";
import { uuidSchema } from "farstep/protocol/identity";
import * as v from "valibot";

import {
  atomicWriteEffect,
  paths,
  privateDirectoryEffect,
  privateReadEffect,
} from "./platform/state";

export {
  atomicWrite,
  atomicWriteEffect,
  paths,
  privateDirectory,
  privateDirectoryEffect,
  privateRead,
  privateReadEffect,
} from "./platform/state";

// Preserve the platform's private publication before flushing directory entries
export function durableJsonWriter<T = unknown>(ancestors: number) {
  return async (path: string, value: T): Promise<void> => {
    await run(atomicWriteEffect(path, JSON.stringify(value)));
    await syncDirectoryAncestors(dirname(path), ancestors);
  };
}

export const PROTOCOL_MAJOR = 1;
export const VERSION = "1.0.0";
export {
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES as MAX_DESKTOP_RESPONSE_BYTES,
} from "farstep/protocol/desktop/desktop";

const identitySchema = v.strictObject({ installationId: uuidSchema });
function decodeIdentity(text: string) {
  return Effect.try({
    try: () => v.parse(identitySchema, JSON.parse(text)),
    catch: (error) => error,
  });
}

export const loadIdentityEffect = Effect.fnUntraced(function* () {
  const state = paths().state;
  yield* privateDirectoryEffect(state);
  const path = join(state, "installation.json");
  const existing = yield* privateReadEffect(path).pipe(
    Effect.flatMap(decodeIdentity),
    Effect.catch((error) =>
      isEnoent(error) ? Effect.succeed(undefined) : Effect.fail(error),
    ),
  );
  if (existing) return existing;
  const identity = { installationId: randomUUID() };
  return yield* Effect.gen(function* () {
    const file = yield* openFile(path, "wx", 0o600);
    yield* attempt(() => file.writeFile(`${JSON.stringify(identity)}\n`));
    yield* attempt(() => file.sync());
    return identity;
  }).pipe(
    Effect.scoped,
    // A competing creator may win; publication must finish before we return
    Effect.uninterruptible,
    Effect.catch((error) =>
      isEexist(error)
        ? privateReadEffect(path).pipe(Effect.flatMap(decodeIdentity))
        : Effect.fail(error),
    ),
  );
});

export function loadIdentity(): Promise<v.InferOutput<typeof identitySchema>> {
  return run(loadIdentityEffect());
}

export const withMaintenanceLockEffect = Effect.fnUntraced(function* <A, E, R>(
  work: Effect.Effect<A, E, R>,
) {
  const state = paths().state;
  yield* privateDirectoryEffect(state);
  const lock = join(state, "maintenance.lock");
  yield* Effect.acquireRelease(
    attempt(() => mkdir(lock, { mode: 0o700 })).pipe(
      Effect.mapError((error) =>
        isEexist(error)
          ? new Error(
              "Helper is busy with a launch or installation operation; no operation was replayed",
            )
          : error,
      ),
    ),
    () => attempt(() => rm(lock, { recursive: true })).pipe(Effect.orDie),
  );
  yield* atomicWriteEffect(
    join(lock, "owner.json"),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
  return yield* work;
}, Effect.scoped);

export function withMaintenanceLock<T>(work: () => Promise<T>): Promise<T> {
  return run(withMaintenanceLockEffect(attempt(work, { awaitOnInterrupt: true })));
}

export const existsEffect = Effect.fnUntraced(function* (path: string) {
  return yield* attempt(() => lstat(path)).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      isEnoent(error) ? Effect.succeed(false) : Effect.fail(error),
    ),
  );
});

export function exists(path: string): Promise<boolean> {
  return run(existsEffect(path));
}
