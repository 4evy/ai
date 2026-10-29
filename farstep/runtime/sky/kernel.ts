import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { attempt, Lifetime, run } from "@ai/runtime/effect/effect";
import { temporaryDirectory } from "@ai/runtime/effect/fs/fs";
import { Queue } from "@ai/runtime/effect/queue/queue";
import { McpSession } from "@ai/toolkit/mcp/session/session";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ElicitRequestSchema,
  ListRootsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Effect, Exit, Record as Records, Scope, ScopedRef } from "effect";
import { MAX_FRAME, type SkyTurn } from "../../protocol/sky/execution";
import { VERSION } from "../state";
import { installLinuxServiceEffect } from "./runtime/linux";
import { WAYLAND } from "./runtime/paths";
import { runtimeServerEffect } from "./runtime/server";

export class SkyKernel {
  private readonly lifetime = new Lifetime("sequential");
  private readonly connecting = new Queue();
  private turn: SkyTurn | undefined;
  private readonly kernel = Effect.runSync(
    Scope.provide(this.lifetime.scope)(
      ScopedRef.make<McpSession | undefined>(() => undefined),
    ),
  );

  constructor(private readonly cwd: string) {}

  private installSessionEffect(env: Record<string, string>) {
    return Effect.gen(function* () {
      if (!WAYLAND) return;
      const directory = yield* temporaryDirectory(join(tmpdir(), "farstep-sky-"));
      yield* installLinuxServiceEffect(env, directory.path);
    });
  }

  private client(): Client {
    const client = new Client(
      { name: "farstep-sky", version: VERSION },
      { capabilities: { roots: {}, elicitation: { form: {} } } },
    );
    client.setRequestHandler(ListRootsRequestSchema, () => ({
      roots: [{ uri: pathToFileURL(this.cwd).href }],
    }));
    client.setRequestHandler(ElicitRequestSchema, (request) => {
      const meta = request.params._meta;
      const params = meta?.tool_params;
      // The caller explicitly authorizes code execution on this selected machine
      if (
        request.params.mode !== "url" &&
        meta?.connector_id === "computer-use" &&
        meta?.codex_approval_kind === "mcp_tool_call" &&
        params &&
        typeof params === "object" &&
        "app" in params &&
        typeof params.app === "string"
      )
        return { action: "accept" };
      return { action: "decline" };
    });
    return client;
  }

  private openEffect() {
    return Effect.gen({ self: this }, function* () {
      this.turn = undefined;
      const config = yield* runtimeServerEffect(this.cwd);
      yield* this.installSessionEffect(config.env);
      const env = Records.filter(
        { ...process.env, ...config.env },
        (value) => value !== undefined,
      );
      // CUA derives its trusted services from the enabled surfaces
      if (!WAYLAND) delete env.NODE_REPL_TRUSTED_SERVICES;
      const { session } = yield* McpSession.acquireEffect(
        this.client(),
        new StdioClientTransport({
          command: config.command,
          args: config.args,
          cwd: this.cwd,
          env,
          stderr: "inherit",
          maxBufferSize: MAX_FRAME,
        }),
        {
          closedMessage: "Sky kernel is closed",
          awaitOnInterrupt: true,
          requestMeta: () =>
            this.turn
              ? {
                  "x-codex-turn-metadata": {
                    session_id: this.turn.sessionId,
                    turn_id: this.turn.turnId,
                  },
                }
              : {},
        },
        (session) =>
          Effect.gen(function* () {
            const { tools } = yield* attempt(
              (signal) => session.client.listTools({}, { signal, timeout: 30_000 }),
              { awaitOnInterrupt: true },
            );
            for (const name of ["js", "js_reset", "turn_ended"]) {
              if (!tools.some((tool) => tool.name === name))
                return yield* Effect.fail(new Error(`Sky kernel lacks ${name}`));
            }
          }),
      );
      return session;
    });
  }

  private connectEffect() {
    return this.connecting.runEffect(
      Effect.gen({ self: this }, function* () {
        const existing = yield* ScopedRef.get(this.kernel);
        if (existing) return existing;
        // ScopedRef owns each generation; opening stays interruptible by its caller
        yield* ScopedRef.set(this.kernel, Effect.interruptible(this.openEffect()));
        const client = yield* ScopedRef.get(this.kernel);
        if (!client) return yield* Effect.fail(new Error("Sky kernel did not connect"));
        return client;
      }),
    );
  }

  prepare(signal: AbortSignal): Promise<void> {
    return this.lifetime.run(this.connectEffect().pipe(Effect.asVoid), signal);
  }

  invoke(
    name: "js" | "js_reset",
    input: Record<string, unknown>,
    signal: AbortSignal,
    timeout: number,
    turn?: SkyTurn,
  ) {
    return this.lifetime.run(
      Effect.gen({ self: this }, function* () {
        const client = yield* this.connectEffect();
        if (turn) {
          if (
            this.turn &&
            (this.turn.sessionId !== turn.sessionId || this.turn.turnId !== turn.turnId)
          )
            yield* this.finishTurnEffect(client, this.turn);
          this.turn = turn;
        }
        if (name === "js_reset") yield* this.releaseInputEffect(client);
        return yield* client.callEffect(name, input, timeout);
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? ScopedRef.set(this.kernel, Effect.succeed(undefined))
            : Effect.void,
        ),
      ),
      signal,
    );
  }

  private finishTurnEffect(client: McpSession, turn: SkyTurn) {
    return Effect.gen({ self: this }, function* () {
      const current = this.turn;
      if (
        !current ||
        current.sessionId !== turn.sessionId ||
        current.turnId !== turn.turnId
      )
        return false;
      if (!client.isClosed()) {
        const result = yield* client.callEffect(
          "turn_ended",
          {
            hook_event_name: "Stop",
            session_id: current.sessionId,
            turn_id: current.turnId,
          },
          15_000,
        );
        if (result.isError)
          return yield* Effect.fail(
            new Error(
              `Sky browser turn cleanup failed: ${result.content
                .flatMap((item) => (item.type === "text" ? [item.text] : []))
                .join("\n")}`,
            ),
          );
      }
      this.turn = undefined;
      return !client.isClosed();
    });
  }

  endTurn(turn: SkyTurn, signal: AbortSignal): Promise<boolean> {
    return this.lifetime.run(
      Effect.gen({ self: this }, function* () {
        const client = yield* ScopedRef.get(this.kernel);
        return client ? yield* this.finishTurnEffect(client, turn) : false;
      }),
      signal,
    );
  }

  private releaseInputEffect(client: McpSession) {
    return Effect.gen(function* () {
      if (!WAYLAND) return;
      const result = yield* client.callEffect(
        "js",
        {
          code: 'await nodeRepl.rpc("sky", {type: "release_input"});',
          timeout_ms: 5000,
        },
        7000,
      );
      if (result.isError)
        return yield* Effect.fail(new Error("Sky input cleanup failed"));
    });
  }

  release(client: McpSession): Promise<void> {
    const turn = this.turn;
    return run(
      (turn ? this.finishTurnEffect(client, turn) : Effect.void).pipe(
        Effect.ensuring(this.releaseInputEffect(client).pipe(Effect.orDie)),
      ),
    );
  }

  settled(): Promise<McpSession | undefined> {
    return run(this.connecting.runEffect(ScopedRef.get(this.kernel)));
  }

  close(): Promise<void> {
    return this.lifetime.close();
  }
}
