import { fileURLToPath } from "node:url";
import { run } from "@ai/core/effect/effect";
import { McpSession } from "@ai/core/mcp/session/session";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Exit, Record as Records } from "effect";
import type { HelperIdentity } from "farstep/protocol/identity";
import { helperHandshakeSchema, structuredResult } from "farstep/protocol/identity";
import { boundRequest } from "farstep/transport/bounds";
import * as v from "valibot";
import { MAX_RESPONSE_BYTES } from "../../protocol/desktop/desktop";

export interface HelperConnection extends AsyncDisposable {
  identity: HelperIdentity;
  readonly closeEffect: Effect.Effect<void>;
  callEffect(
    name: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Effect.Effect<CallToolResult, unknown>;
  call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<CallToolResult>;
  close(): Promise<void>;
}

export interface HelperConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
}

interface ConnectionOptions {
  signal?: AbortSignal;
  wireCodec?: "zstd";
  onNotification?: (method: string, params: unknown) => void;
  onClose?: () => void;
}

function relayTransport(config: HelperConfig, options: ConnectionOptions) {
  return new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(
        new URL(
          `../relay/relay.${import.meta.url.endsWith(".js") ? "js" : "ts"}`,
          import.meta.url,
        ),
      ),
      ...(options.wireCodec ? ["--wire-codec=zstd"] : []),
      config.command,
      ...(config.args ?? []),
    ],
    env: Records.filter(
      { ...process.env, ...config.env },
      (value) => value !== undefined,
    ),
    ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    stderr: "inherit",
    maxBufferSize: MAX_RESPONSE_BYTES,
  });
}

const openHelperEffect = Effect.fnUntraced(function* (
  name: string,
  config: HelperConfig,
  options: Omit<ConnectionOptions, "signal">,
) {
  const client = new Client({ name, version: "1.0.0" });
  client.fallbackNotificationHandler = async (notification) => {
    options.onNotification?.(notification.method, notification.params);
  };
  if (options.onClose) client.onclose = options.onClose;
  const session = new McpSession(client, {
    closedMessage: "Helper channel is closed",
    timeout: config.timeout ?? 30_000,
    timeoutMessage: "Helper call timed out",
    requestMode: "request",
    beforeCall: boundRequest,
    operation: { name: "helper.call", component: "helper" },
  });
  return yield* Effect.gen(function* () {
    yield* session.openEffect(relayTransport(config, options));
    const handshake = yield* session.callEffect("helper.handshake", {}, 30_000);
    const identity = yield* Effect.try({
      try: () => v.parse(helperHandshakeSchema, structuredResult(handshake)),
      catch: (error) => error,
    });
    return {
      identity,
      callEffect: session.callEffect.bind(session),
      call: session.call.bind(session),
      close: session.close,
      closeEffect: session.closeEffect,
      [Symbol.asyncDispose]: session.close,
    };
  }).pipe(
    Effect.onExit((exit) => (Exit.isFailure(exit) ? session.closeEffect : Effect.void)),
  );
});

export function connectHelperEffect(
  name: string,
  config: HelperConfig,
  options: Omit<ConnectionOptions, "signal"> = {},
): Effect.Effect<HelperConnection, unknown> {
  return openHelperEffect(name, config, options);
}

export function connectHelper(
  name: string,
  config: HelperConfig,
  options: ConnectionOptions = {},
): Promise<HelperConnection> {
  return run(connectHelperEffect(name, config, options), options.signal);
}
