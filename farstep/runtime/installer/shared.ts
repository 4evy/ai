import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { attempt, run } from "@ai/runtime/effect/effect";
import { Effect, Exit } from "effect";
import { uuidSchema } from "farstep/protocol/identity";
import * as v from "valibot";
import { atomicWrite, paths, withMaintenanceLockEffect } from "../state";

export async function claimUpgradeOperation(lock: string): Promise<void> {
  await mkdir(join(lock, "operation"), { mode: 0o700 });
  await atomicWrite(
    join(lock, "owner.json"),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
}
export const replaceLinkEffect = Effect.fnUntraced(function* (
  path: string,
  target: string,
) {
  const staged = `${path}.${randomUUID()}`;
  yield* Effect.acquireUseRelease(
    attempt(() => symlink(target, staged)),
    () => attempt(() => rename(staged, path)),
    () => attempt(() => rm(staged, { force: true })).pipe(Effect.orDie),
  );
}, Effect.uninterruptible);

export function replaceLink(path: string, target: string): Promise<void> {
  return run(replaceLinkEffect(path, target));
}

export function createInstallerLock<Preparation extends { maintenanceToken: string }>(
  prepared: () => Promise<Preparation | undefined>,
) {
  return function installerLock<T>(
    token: string | undefined,
    work: (preparation?: Preparation) => Promise<T>,
  ): Promise<T> {
    return run(
      Effect.gen(function* () {
        if (token === undefined)
          return yield* withMaintenanceLockEffect(
            attempt(() => work(), { awaitOnInterrupt: true }),
          );
        yield* Effect.try({
          try: () => v.parse(uuidSchema, token),
          catch: (error) => error,
        });
        const lock = join(paths().state, "maintenance.lock");
        const preparation = yield* attempt(prepared);
        if (!preparation || preparation.maintenanceToken !== token)
          return yield* Effect.fail(
            new Error("Maintenance token does not match the pending upgrade"),
          );
        const operation = join(lock, "operation");
        return yield* Effect.acquireUseRelease(
          attempt(() => mkdir(operation, { mode: 0o700 })),
          () =>
            Effect.gen(function* () {
              if ((yield* attempt(prepared))?.maintenanceToken !== token)
                return yield* Effect.fail(new Error("Pending maintenance changed"));
              return yield* attempt(() => work(preparation), {
                awaitOnInterrupt: true,
              });
            }),
          (_, exit) =>
            attempt(() =>
              Exit.isSuccess(exit)
                ? rm(lock, { recursive: true })
                : rm(operation, { recursive: true, force: true }),
            ).pipe(Effect.orDie),
        );
      }).pipe(Effect.uninterruptible),
    );
  };
}
