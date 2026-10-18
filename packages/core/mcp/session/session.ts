import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Exit } from "effect";
import {
  attempt,
  Lifetime,
  operationEffect,
  run,
  traceCarrier,
} from "../../effect/effect";
import { assertTimerDelay, MAX_TIMER_DELAY } from "../../time/time";

interface SessionOptions {
  closedMessage: string;
  timeout?: number;
  requestMode?: "request" | "callTool";
  awaitOnInterrupt?: boolean;
  timeoutMessage?: string;
  beforeCall?: (name: string, input: Record<string, unknown>) => void;
  operation?: { name: string; component: string };
}

// One lifetime owns startup and calls; failed calls revoke the whole channel
export class McpSession implements AsyncDisposable {
  private readonly lifetime = new Lifetime();
  private state: "new" | "opening" | "open" | "closed" = "new";

  readonly client: Client;
  private readonly options: SessionOptions;

  constructor(client: Client, options: SessionOptions) {
    this.client = client;
    this.options = options;
    const onclose = client.onclose;
    client.onclose = () => {
      this.state = "closed";
      onclose?.();
    };
  }

  readonly isClosed = () => this.state === "closed";
  readonly closeEffect = Effect.suspend(() => {
    this.state = "closed";
    return this.lifetime.closeEffect;
  });
  readonly close = (): Promise<void> => {
    this.state = "closed";
    return this.lifetime.close();
  };

  openEffect(transport: Transport, timeout = 30_000) {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.try({
        try: () => {
          assertTimerDelay(timeout);
          if (this.state !== "new") throw new Error("MCP session was already opened");
          this.state = "opening";
        },
        catch: (error) => error,
      });
      const opening = Effect.gen({ self: this }, function* () {
        yield* Effect.addFinalizer(() =>
          attempt(() => this.client.close()).pipe(Effect.orDie),
        );
        yield* attempt(
          (signal) =>
            this.client.connect(transport, {
              signal,
              timeout: timeout || MAX_TIMER_DELAY,
            }),
          { awaitOnInterrupt: true },
        );
        if (this.state !== "opening")
          return yield* Effect.fail(new Error(this.options.closedMessage));
        this.state = "open";
        return this;
      });
      return yield* this.lifetime
        .runEffect(opening)
        .pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? this.closeEffect : Effect.void,
          ),
        );
    });
  }

  callEffect(
    name: string,
    input: Record<string, unknown>,
    timeout = this.options.timeout ?? 30_000,
  ) {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.try({
        try: () => {
          assertTimerDelay(timeout);
          if (this.state !== "open") throw new Error(this.options.closedMessage);
          this.options.beforeCall?.(name, input);
        },
        catch: (error) => error,
      });
      const params = { name, arguments: input, _meta: traceCarrier() };
      const request = attempt(
        (signal) => {
          // Effect owns the deadline so SDK and Effect timers cannot
          // race to report different timeout errors, even for calls
          // without a deadline
          const options = { signal, timeout: MAX_TIMER_DELAY };
          return this.options.requestMode === "request"
            ? this.client.request(
                { method: "tools/call", params },
                CallToolResultSchema,
                options,
              )
            : this.client.callTool(params, CallToolResultSchema, options);
        },
        { awaitOnInterrupt: this.options.awaitOnInterrupt ?? false },
      ).pipe(
        Effect.flatMap((result) =>
          Effect.try({
            try: () => CallToolResultSchema.parse(result),
            catch: (error) => error,
          }),
        ),
      );
      const timed =
        timeout > 0
          ? request.pipe(
              Effect.timeoutOrElse({
                duration: timeout,
                orElse: () =>
                  Effect.fail(
                    new DOMException(
                      this.options.timeoutMessage ?? "MCP call timed out",
                      "TimeoutError",
                    ),
                  ),
              }),
            )
          : request;
      const operation = this.options.operation;
      return yield* this.lifetime
        .runEffect(
          operation
            ? operationEffect(
                operation.name,
                { component: operation.component, method: name },
                timed,
              )
            : timed,
        )
        .pipe(
          // Close outside the owned fiber so shutdown never waits for itself
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? this.closeEffect.pipe(Effect.ignoreCause)
              : Effect.void,
          ),
        );
    });
  }

  call(
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    timeout?: number,
  ) {
    return run(this.callEffect(name, input, timeout), signal);
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
