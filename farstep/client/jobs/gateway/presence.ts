import { randomUUID } from "node:crypto";
import { type Lifetime, run } from "@ai/runtime/effect/effect";
import { toError } from "@oh-my-pi/pi-utils/type-guards";
import { Cause, Effect, Fiber, Schedule } from "effect";
import * as v from "valibot";
import type {
  CoordinationOpen,
  CoordinationRequest,
  CoordinationResult,
} from "#farstep/protocol/coordination";
import {
  coordinationOpenSchema,
  coordinationRequestSchema,
  coordinationResultSchema,
} from "#farstep/protocol/coordination";

export class GatewayPresence {
  #coordination: Effect.Effect<void, unknown> | undefined;
  #registered = false;
  #heartbeat: Fiber.Fiber<unknown, unknown> | undefined;
  #onCoordinationFailure: ((error: unknown) => void) | undefined;
  #coordinationFailed = false;
  constructor(
    private readonly owner: string,
    private readonly lifetime: Lifetime,
    private readonly callEffect: (
      tool: string,
      args: Record<string, unknown>,
      timeoutMs?: number,
    ) => Effect.Effect<unknown, unknown>,
    private readonly isClosed: () => boolean,
    private readonly close: () => Promise<void>,
    private readonly onRegistered: () => void,
  ) {}

  get registered(): boolean {
    return this.#registered;
  }

  openEffect(
    input: CoordinationOpen,
    onFailure: (error: unknown) => void,
  ): Effect.Effect<void, unknown> {
    return Effect.suspend(() => {
      if (this.#coordination) return this.#coordination;
      this.#onCoordinationFailure = onFailure;
      this.#coordination = Effect.runSync(
        Effect.cached(
          Effect.gen({ self: this }, function* () {
            const parsed = yield* Effect.try({
              try: () => v.parse(coordinationOpenSchema, input),
              catch: (error) => error,
            });
            const response = yield* this.callEffect("coordination.open", parsed);
            const result = yield* Effect.try({
              try: () => v.parse(coordinationResultSchema, response),
              catch: (error) => error,
            });
            if (!result.session || result.session.actor !== this.owner)
              return yield* Effect.fail(
                new Error(
                  "Coordination registration did not return the gateway session",
                ),
              );
            if (this.isClosed())
              return yield* Effect.fail(
                new Error("Gateway closed during coordination registration"),
              );
            this.#registered = true;
            yield* this.#scheduleHeartbeatEffect();
            this.onRegistered();
          }),
        ),
      );
      return this.#coordination;
    });
  }

  open(input: CoordinationOpen, onFailure: (error: unknown) => void): Promise<void> {
    return run(this.openEffect(input, onFailure));
  }

  async request(
    input: CoordinationRequest,
    signal?: AbortSignal,
  ): Promise<CoordinationResult> {
    if (!this.#coordination)
      throw new Error("Gateway coordination session has not been registered");
    await run(this.#coordination, signal);
    const parsed = v.parse(coordinationRequestSchema, input);
    const request =
      parsed.action === "snapshot" ||
      parsed.action === "inbox" ||
      parsed.action === "thread" ||
      parsed.action === "events"
        ? parsed
        : { ...parsed, requestId: parsed.requestId ?? randomUUID() };
    try {
      return v.parse(
        coordinationResultSchema,
        await run(this.callEffect("coordination.request", request), signal),
      );
    } catch (error) {
      if (!("requestId" in request)) throw error;
      throw new Error(
        `Coordination ${request.action} failed; requestId ${request.requestId} was not replayed: ${toError(error).message.slice(0, 512)}`,
        { cause: error },
      );
    }
  }

  failure(error: unknown): void {
    if (this.#coordinationFailed) return;
    this.#coordinationFailed = true;
    this.#onCoordinationFailure?.(error);
  }

  stopHeartbeatEffect() {
    return Effect.suspend(() => {
      const heartbeat = this.#heartbeat;
      this.#heartbeat = undefined;
      return heartbeat ? Fiber.interrupt(heartbeat) : Effect.void;
    });
  }

  stopHeartbeat(): Promise<void> {
    return run(this.stopHeartbeatEffect());
  }

  #scheduleHeartbeatEffect() {
    return Effect.gen({ self: this }, function* () {
      if (this.isClosed()) return;
      const heartbeat = Effect.sleep(30_000).pipe(
        Effect.andThen(
          Effect.uninterruptible(
            Effect.gen({ self: this }, function* () {
              const result = yield* this.callEffect(
                "coordination.heartbeat",
                {},
                5_000,
              );
              yield* Effect.try({
                try: () => v.parse(coordinationResultSchema, result),
                catch: (error) => error,
              });
            }),
          ).pipe(Effect.repeat(Schedule.spaced(30_000))),
        ),
        Effect.tapCause((cause) =>
          Effect.sync(() => {
            if (
              this.#heartbeat !== current ||
              this.isClosed() ||
              Cause.hasInterruptsOnly(cause)
            )
              return;
            this.failure(Cause.squash(cause));
            void this.close().catch((error) => this.failure(error));
          }),
        ),
      );
      const current = yield* this.lifetime.forkEffect(heartbeat);
      this.#heartbeat = current;
    });
  }
}
