import { Lifetime } from "@ai/core/effect/effect";
import { McpSession } from "@ai/core/mcp/session/session";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Exit } from "effect";
import { PROVISION_TIMEOUT_MS } from "farstep/protocol/sky/limits";
import * as v from "valibot";

import { identitySchema, type SkyChannel } from "./contracts";

export function structured(result: CallToolResult) {
  if (result.isError)
    throw new Error(
      result.content
        .flatMap((item) => (item.type === "text" ? [item.text] : []))
        .join("\n"),
    );
  return result.structuredContent;
}

export class ChannelSession {
  private readonly lifetime = new Lifetime();
  constructor(
    private readonly client: Client,
    private readonly transport: StdioClientTransport,
    private readonly closedFleet: AbortSignal,
    onClose: () => void,
  ) {
    client.onclose = () => {
      onClose();
    };
  }

  open(signal?: AbortSignal): Promise<SkyChannel> {
    const active = signal
      ? AbortSignal.any([signal, this.closedFleet])
      : this.closedFleet;
    return this.lifetime.run(
      Effect.gen({ self: this }, function* () {
        const { session, value: identity } = yield* McpSession.acquireEffect(
          this.client,
          this.transport,
          {
            closedMessage:
              "Sky channel closed; reset and observe again. The operation was not replayed",
          },
          (session) =>
            Effect.gen(function* () {
              const handshake = yield* session.callEffect("helper.handshake", {});
              const identity = yield* Effect.try({
                try: () => v.parse(identitySchema, structured(handshake)),
                catch: (error) => error,
              });
              if (!identity.capabilities.includes("sky-mcp-v1"))
                return yield* Effect.fail(
                  new Error("Upgrade Farstep on this target: it lacks sky-mcp-v1"),
                );
              return identity;
            }),
        );
        const call = (
          name: string,
          input: Record<string, unknown>,
          signal?: AbortSignal,
          timeout = 30_000,
        ) =>
          session.call(
            name,
            input,
            signal ? AbortSignal.any([signal, this.closedFleet]) : this.closedFleet,
            timeout,
          );
        let prepared = false;
        return {
          identity,
          call,
          prepare: async (signal?: AbortSignal) => {
            if (prepared) return;
            // Provisioning is independent of the cell's execution deadline
            structured(await call("sky.prepare", {}, signal, PROVISION_TIMEOUT_MS));
            prepared = true;
          },
          close: () => this.lifetime.close(),
          isClosed: session.isClosed,
        };
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? this.lifetime.closeEffect : Effect.void,
        ),
      ),
      active,
    );
  }
}
