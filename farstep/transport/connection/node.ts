import { Lifetime } from "@ai/core/effect/effect";
import { McpSession } from "@ai/core/mcp/session/session";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Record as Records, type Scope, Struct } from "effect";
import * as v from "valibot";
import { MAX_RESPONSE_BYTES } from "../../protocol/desktop/desktop";
import type { HelperIdentity } from "../../protocol/identity";
import { helperHandshakeSchema, structuredResult } from "../../protocol/identity";
import { boundRequest } from "../bounds";
import { assertDesktopHelper } from "../desktop/desktop";

// The MCP SDK supplies its safe platform environment; add desktop session paths
const HELPER_ENVIRONMENT_KEYS = [
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
  "XDG_DATA_HOME",
] as const;

export interface NodeHelperConnection {
  identity: HelperIdentity;
  callEffect(
    name: string,
    args: Record<string, unknown>,
  ): Effect.Effect<CallToolResult, unknown>;
  call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult>;
  close(): Promise<void>;
}

// The scope owns startup, handshake failures and the helper process's lifetime
function acquireNodeHelper(
  command: string,
  args = ["desktop", "connect"],
): Effect.Effect<NodeHelperConnection, unknown, Scope.Scope> {
  return Effect.gen(function* () {
    const env = Records.filter(
      Struct.pick(process.env, HELPER_ENVIRONMENT_KEYS),
      (value) => value !== undefined,
    );
    const transport = new StdioClientTransport({
      command,
      args,
      env,
      stderr: "ignore",
      maxBufferSize: MAX_RESPONSE_BYTES,
    });
    const client = new Client({ name: "ai-desktop-client", version: "1.0.0" });
    const session = new McpSession(client, {
      closedMessage: "Helper channel is closed; reset and observe again",
      requestMode: "request",
      beforeCall: boundRequest,
      operation: { name: "helper.call", component: "helper" },
    });
    yield* Effect.addFinalizer(() => session.closeEffect);
    yield* session.openEffect(transport);
    const handshake = yield* session.callEffect("helper.handshake", {});
    const identity = yield* Effect.try({
      try: () => {
        const identity = v.parse(helperHandshakeSchema, structuredResult(handshake));
        assertDesktopHelper(identity);
        return identity;
      },
      catch: (error) => error,
    });
    return {
      identity,
      callEffect: session.callEffect.bind(session),
      call: session.call.bind(session),
      close: session.close,
    };
  });
}

export async function connectNodeHelper(
  command: string,
  args = ["desktop", "connect"],
  signal?: AbortSignal,
): Promise<NodeHelperConnection> {
  const lifetime = new Lifetime();
  try {
    const connection = await lifetime.run(acquireNodeHelper(command, args), signal);
    return { ...connection, close: () => lifetime.close() };
  } catch (error) {
    await lifetime.close();
    throw error;
  }
}
