import { Effect, Semaphore } from "effect";
import { attempt, run } from "../effect";

export class Queue {
  readonly #permit = Semaphore.makeUnsafe(1);

  runEffect<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    return this.#permit.withPermits(1)(effect);
  }

  run<A>(work: () => Promise<A>, signal?: AbortSignal): Promise<A> {
    return run(
      this.runEffect(
        // Waiting callers can abort; started actions retain the permit through
        // their native cancellation and cleanup instead of overlapping the next action
        Effect.uninterruptible(
          attempt(async () => {
            signal?.throwIfAborted();
            return work();
          }),
        ),
      ),
      signal,
    );
  }
}
