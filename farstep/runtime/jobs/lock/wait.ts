import { Effect } from "effect";

export interface LockWait {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  timeoutMessage?: string | undefined;
}

// Bound acquisition only, never interrupt a mutation after its lock is held
export function waitForLockEffect<A, E, R>(
  acquire: Effect.Effect<A, E, R>,
  options: LockWait = {},
) {
  const signal = options.signal;
  const cancellable = signal
    ? Effect.raceFirst(
        acquire,
        Effect.callback<never, unknown>((resume) => {
          const aborted = () => resume(Effect.fail(signal.reason));
          if (signal.aborted) aborted();
          else signal.addEventListener("abort", aborted, { once: true });
          return Effect.sync(() => signal.removeEventListener("abort", aborted));
        }),
      )
    : acquire;
  return cancellable.pipe(
    Effect.timeoutOrElse({
      duration: options.timeoutMs ?? 15000,
      orElse: () =>
        Effect.fail(
          new Error(options.timeoutMessage ?? "Timed out waiting for the private lock"),
        ),
    }),
    Effect.interruptible,
  );
}
