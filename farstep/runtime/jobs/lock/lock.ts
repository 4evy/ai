import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { attempt, run } from "@ai/runtime/effect/effect";
import { acquireFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { Effect, RcMap, Scope, Semaphore } from "effect";
import { privateDirectory } from "../../state";

// The process shares one permit per path while any holder or waiter retains it
const queues = Effect.runSync(
  RcMap.make({ lookup: (_path: string) => Semaphore.make(1) }).pipe(
    Scope.provide(Scope.makeUnsafe()),
  ),
);

export async function withFileLock<T>(
  directory: string,
  key: string,
  work: () => Promise<T>,
  options: { unsafeMessage: string; timeoutMessage?: string },
): Promise<T> {
  const path = join(directory, key);
  return run(
    Effect.gen(function* () {
      const queue = yield* RcMap.get(queues, path);
      return yield* queue.withPermit(
        Effect.gen(function* () {
          yield* attempt(() => privateDirectory(directory));
          yield* Effect.acquireUseRelease(
            attempt(() =>
              open(
                `${path}.lock`,
                constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
                0o600,
              ),
            ),
            (file) =>
              attempt(async () => {
                const info = await file.stat();
                if (
                  !info.isFile() ||
                  info.uid !== process.getuid?.() ||
                  (info.mode & 0o077) !== 0
                )
                  throw new Error(options.unsafeMessage);
              }),
            (file) => Effect.promise(() => file.close()),
          );
          // The native utility appends .lock; OS locks vanish on process exit
          yield* Effect.acquireRelease(
            attempt((signal) => {
              const budget = AbortSignal.timeout(15000);
              return acquireFileLock(path, {
                retries: 601,
                retryDelayMs: 25,
                signal: AbortSignal.any([signal, budget]),
              }).catch((error) => {
                if (budget.aborted && options.timeoutMessage)
                  throw new Error(options.timeoutMessage, { cause: error });
                throw error;
              });
            }),
            (lock) => Effect.sync(() => lock.release()),
          );
          // Keep the lock until a started mutation has persisted its receipt
          return yield* Effect.uninterruptible(attempt(work));
        }).pipe(Effect.scoped),
      );
    }).pipe(Effect.scoped),
  );
}
