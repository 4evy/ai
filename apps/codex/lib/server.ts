import { attempt, Lifetime, operationEffect, run } from "@ai/core/effect/effect";
import { terminateProcess } from "@ai/core/effect/process/process";
import { errorMessage } from "@ai/core/error/error";
import { processCommand } from "@ai/core/process/launch";
import { Effect, Scope } from "effect";
import { createMessageConnection, type MessageConnection } from "vscode-jsonrpc/node";
import { AppServerReader, AppServerWriter } from "./transport/transport.ts";

export class AppServer implements AsyncDisposable {
  readonly #process: Bun.Subprocess<"pipe", "pipe", "ignore">;
  readonly #connection: MessageConnection;
  readonly #lifetime = new Lifetime();
  #failure: Error | undefined;

  constructor(real: string, lifetimeMs?: number) {
    this.#process = Bun.spawn(processCommand(real, ["app-server", "--stdio"]), {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    this.#connection = createMessageConnection(
      new AppServerReader(this.#process.stdout),
      new AppServerWriter(this.#process.stdin),
    );
    this.#connection.onError(([error]) => this.#fail(error));
    this.#connection.onClose(() => this.#fail(new Error("Codex app server exited")));
    this.#connection.listen();
    Effect.runSync(
      Scope.addFinalizer(
        this.#lifetime.scope,
        terminateProcess(this.#process, { terminationGraceMs: 3000 }).pipe(
          Effect.orDie,
        ),
      ),
    );
    if (lifetimeMs !== undefined) {
      this.#lifetime.fork(
        Effect.sleep(lifetimeMs).pipe(
          Effect.andThen(
            Effect.sync(() => {
              this.#fail(new Error("Codex app-server operation timed out"));
              if (this.#process.exitCode === null) this.#process.kill("SIGTERM");
            }),
          ),
        ),
      );
    }
  }

  notifyEffect(method: string) {
    return Effect.suspend(() =>
      this.#failure
        ? Effect.fail(this.#failure)
        : this.#lifetime.runEffect(
            attempt(() => this.#connection.sendNotification(method)),
          ),
    );
  }

  notify(method: string): Promise<void> {
    return run(this.notifyEffect(method));
  }

  requestEffect(method: string, params: Record<string, unknown>) {
    return Effect.suspend(() => {
      if (this.#failure) return Effect.fail(this.#failure);
      return this.#lifetime
        .runEffect(
          operationEffect(
            "codex.request",
            { component: "codex", method },
            attempt(() => this.#connection.sendRequest<unknown>(method, params)).pipe(
              Effect.timeoutOrElse({
                duration: 5000,
                orElse: () =>
                  Effect.suspend(() => {
                    const error = new Error(`Codex ${method} response timed out`);
                    // Invalidate the connection so pending requests cannot leak
                    this.#fail(error);
                    return Effect.fail(error);
                  }),
              }),
              Effect.onInterrupt(() =>
                Effect.sync(() => this.#fail(new Error("Codex request interrupted"))),
              ),
            ),
          ),
        )
        .pipe(Effect.mapError((error) => this.#failure ?? error));
    });
  }

  request(method: string, params: Record<string, unknown>, signal?: AbortSignal) {
    return run(this.requestEffect(method, params), signal);
  }

  #fail(error: unknown): void {
    if (this.#failure) return;
    this.#failure = error instanceof Error ? error : new Error(errorMessage(error));
    this.#connection.dispose();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#fail(new Error("Codex app server closed"));
    await this.#lifetime.close();
  }
}

export async function appServer(
  real: string,
  clientName = "codex-launcher",
  lifetimeMs?: number,
): Promise<AppServer> {
  const server = new AppServer(real, lifetimeMs);
  try {
    await server.request("initialize", {
      clientInfo: { name: clientName, version: "1" },
    });
    await server.notify("initialized");
    return server;
  } catch (error) {
    await server[Symbol.asyncDispose]();
    throw error;
  }
}
