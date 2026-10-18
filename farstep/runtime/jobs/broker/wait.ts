import { run } from "@ai/core/effect/effect";
import { Effect, Schedule } from "effect";

export function until(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  return run(
    Effect.sync(condition).pipe(
      Effect.repeat({ until: (ready) => ready, schedule: Schedule.spaced(25) }),
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.sync(condition),
      }),
    ),
  );
}
