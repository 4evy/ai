import { AsyncLocalStorage } from "node:async_hooks";
import { parseTraceParent } from "@opentelemetry/core";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  ManagedRuntime,
  Option,
  Scope,
  Tracer,
} from "effect";
import { observability } from "./observability/observability";

const spans = new AsyncLocalStorage<Tracer.AnySpan>();
const runtime = ManagedRuntime.make(observability);

export const attempt = Effect.fnUntraced(function* <A>(
  operation: (signal: AbortSignal) => Promise<A>,
  options: { awaitOnInterrupt?: boolean } = {},
) {
  const span = yield* Effect.serviceOption(Tracer.ParentSpan);
  return yield* Effect.suspend(() => {
    let pending: Promise<A> | undefined;
    const attempted = Effect.tryPromise({
      try: (signal) => {
        pending = Option.isSome(span)
          ? spans.run(span.value, () => operation(signal))
          : operation(signal);
        return pending;
      },
      catch: (error) => error,
    });
    return options.awaitOnInterrupt
      ? attempted.pipe(
          // Native cancellation aborts the signal before this finalizer runs
          Effect.onInterrupt(() =>
            Effect.promise(async () => {
              await pending?.then(
                () => undefined,
                () => undefined,
              );
            }),
          ),
        )
      : attempted;
  });
});

// Keep native errors intact at existing Promise APIs instead of exposing fibers
export async function run<A, E>(
  effect: Effect.Effect<A, E>,
  signal?: AbortSignal,
  scope?: Scope.Closeable,
): Promise<A> {
  // The runtime evaluates synchronous work before attaching its abort listener
  signal?.throwIfAborted();
  const parent = spans.getStore();
  const exit = await runtime.runPromiseExit(
    parent ? Effect.withParentSpan(effect, parent) : effect,
    { signal, onFiberStart: scope ? Fiber.runIn(scope) : undefined },
  );
  if (Exit.isSuccess(exit)) return exit.value;
  if (signal?.aborted) throw signal.reason;
  throw Cause.squash(exit.cause);
}

// Sanitize the span's failure while preserving the caller's complete error cause
export function operationEffect<A, E, R>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.suspend(() => {
    let original: Cause.Cause<E> | undefined;
    return Effect.gen(function* () {
      const span = yield* Effect.currentSpan.pipe(Effect.orDie);
      const started = performance.now();
      return yield* Effect.gen(function* () {
        yield* Effect.logDebug("Operation started");
        return yield* effect.pipe(
          Effect.onExit((exit) =>
            (Exit.isSuccess(exit)
              ? Effect.logDebug("Operation finished")
              : Cause.hasInterruptsOnly(exit.cause)
                ? Effect.logDebug("Operation interrupted")
                : Effect.logWarning("Operation failed")
            ).pipe(
              Effect.annotateLogs("elapsedMs", Math.round(performance.now() - started)),
            ),
          ),
          Effect.catchCause((cause) => {
            original = cause;
            if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
            // Telemetry must not capture command output, arguments or credentials
            const observed = new Error("Operation failed");
            delete observed.stack;
            return Effect.die(observed);
          }),
        );
      }).pipe(Effect.annotateLogs({ traceId: span.traceId, spanId: span.spanId }));
    }).pipe(
      Effect.annotateLogs(attributes),
      Effect.withSpan(name, { attributes }, { captureStackTrace: false }),
      Effect.catchCause((cause) => Effect.failCause(original ?? cause)),
    );
  });
}

export function operation<A>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  body: (signal: AbortSignal) => Promise<A>,
  signal?: AbortSignal,
  parent?: Tracer.AnySpan,
): Promise<A> {
  if (parent) return spans.run(parent, () => operation(name, attributes, body, signal));
  return run(
    operationEffect(name, attributes, attempt(body, { awaitOnInterrupt: true })),
    signal,
  );
}

export function traceCarrier(): Record<string, string> {
  const span = spans.getStore();
  return span
    ? {
        traceparent: `00-${span.traceId}-${span.spanId}-${span.sampled ? "01" : "00"}`,
      }
    : {};
}

export function traceParent(meta: unknown): Tracer.AnySpan | undefined {
  if (typeof meta !== "object" || meta === null || !("traceparent" in meta))
    return undefined;
  const value = meta.traceparent;
  // MCP metadata carries exactly the version 00 header, without HTTP whitespace
  if (typeof value !== "string" || value.length !== 55 || !value.startsWith("00-"))
    return undefined;
  const context = parseTraceParent(value);
  if (!context) return undefined;
  return Tracer.externalSpan({
    traceId: context.traceId,
    spanId: context.spanId,
    sampled: (context.traceFlags & 1) === 1,
  });
}

export class Lifetime implements AsyncDisposable {
  readonly scope: Scope.Closeable;
  // Track peers directly so shutdown can exclude its caller while interrupting
  // every other owned fiber together
  readonly #fibers = new Set<Fiber.Fiber<unknown, unknown>>();
  #closed = false;
  #closing: Promise<void> | undefined;
  #closeStarted = false;
  readonly #closeResult = Deferred.makeUnsafe<void>();

  readonly closeEffect = Effect.withFiber((caller) =>
    Effect.suspend(() => {
      // An owned closer must not wait for shutdown that is already waiting
      // for that same fiber to finish
      if (this.#closeStarted)
        return this.#fibers.has(caller)
          ? Effect.void
          : Deferred.await(this.#closeResult);
      this.#closed = true;
      this.#closeStarted = true;
      const peers = [...this.#fibers].filter((fiber) => fiber !== caller);
      return Fiber.interruptAll(peers).pipe(
        Effect.ensuring(Scope.close(this.scope, Exit.void)),
        Effect.onExit((exit) => Deferred.done(this.#closeResult, exit)),
      );
    }),
  ).pipe(
    // Once shutdown starts, interruption cannot strand resources or other
    // closers
    Effect.uninterruptible,
  );

  constructor(finalizerStrategy: "sequential" | "parallel" = "parallel") {
    this.scope = Scope.makeUnsafe(finalizerStrategy);
  }

  #track<A, E>(fiber: Fiber.Fiber<A, E>): Fiber.Fiber<A, E> {
    this.#fibers.add(fiber);
    fiber.addObserver(() => this.#fibers.delete(fiber));
    if (this.#closed) fiber.interruptUnsafe();
    return fiber;
  }

  // Fork in the caller's Effect context while retaining lifetime ownership
  forkEffect<A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<Fiber.Fiber<A, E>, Error, Exclude<R, Scope.Scope>> {
    return Effect.suspend(() =>
      this.#closed
        ? Effect.fail(new Error("Resource lifetime is closed"))
        : Effect.forkDetach(Scope.provide(this.scope)(effect)).pipe(
            Effect.map((fiber) => this.#track(fiber)),
          ),
    ).pipe(Effect.uninterruptible);
  }

  // Both the calling fiber and this lifetime can cancel owned work, and both
  // wait for its finalizers before returning or releasing shared resources
  runEffect<A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | Error, Exclude<R, Scope.Scope>> {
    return Effect.scoped(
      Effect.gen({ self: this }, function* () {
        const fiber = yield* Effect.acquireRelease(
          this.forkEffect(effect),
          Fiber.interrupt,
        );
        return yield* Fiber.join(fiber);
      }),
    );
  }

  run<A, E>(
    effect: Effect.Effect<A, E, Scope.Scope>,
    signal?: AbortSignal,
  ): Promise<A> {
    return run(this.runEffect(effect), signal);
  }

  fork<A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Fiber.Fiber<A, E> {
    if (this.#closed) throw new Error("Resource lifetime is closed");
    const parent = spans.getStore();
    return runtime.runFork(
      Scope.provide(this.scope)(
        parent ? Effect.withParentSpan(effect, parent) : effect,
      ),
      {
        onFiberStart: (fiber) => this.#track(fiber),
      },
    );
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#closing ??= run(this.closeEffect);
    return this.#closing;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

export function flushObservability(): Promise<void> {
  return runtime.dispose();
}
