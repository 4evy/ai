import { run } from "@ai/core/effect/effect";
import { McpSession } from "@ai/core/mcp/session/session";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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
  private readonly session: McpSession;
  private prepared = false;
  constructor(
    client: Client,
    private readonly transport: StdioClientTransport,
    private readonly closedFleet: AbortSignal,
    onClose: () => void,
  ) {
    client.onclose = () => {
      onClose();
    };
    this.session = new McpSession(client, {
      closedMessage:
        "Sky channel closed; reset and observe again. The operation was not replayed",
    });
  }

  readonly close = (): Promise<void> => this.session.close();

  readonly call = (
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    timeout = 30_000,
  ): Promise<CallToolResult> =>
    this.session.call(
      name,
      input,
      signal ? AbortSignal.any([signal, this.closedFleet]) : this.closedFleet,
      timeout,
    );

  readonly prepare = async (signal?: AbortSignal): Promise<void> => {
    if (this.prepared) return;
    // Provisioning is independent of the cell's execution deadline
    structured(await this.call("sky.prepare", {}, signal, PROVISION_TIMEOUT_MS));
    this.prepared = true;
  };

  async open(signal?: AbortSignal): Promise<SkyChannel> {
    const active = signal
      ? AbortSignal.any([signal, this.closedFleet])
      : this.closedFleet;
    try {
      await run(this.session.openEffect(this.transport), active);
      const identity = v.parse(
        identitySchema,
        structured(await this.call("helper.handshake", {}, signal)),
      );
      if (!identity.capabilities.includes("sky-mcp-v1"))
        throw new Error("Upgrade Farstep on this target: it lacks sky-mcp-v1");

      return {
        identity,
        call: this.call,
        prepare: this.prepare,
        close: this.close,
        isClosed: this.session.isClosed,
      };
    } catch (error) {
      await this.close();
      throw error;
    }
  }
}
