import { Lifetime, run as runEffect } from "@ai/core/effect/effect";
import { Queue } from "@ai/core/effect/queue/queue";
import type { ToolResult } from "@ai/core/tool/tool";
import { Effect, Exit } from "effect";
import type { DesktopInputRequest } from "../../protocol/desktop/desktop";
import type { HelperConfig, HelperConnection } from "../../transport/connection/bun";
import { connectHelperEffect } from "../../transport/connection/bun";
import {
  createDesktopClient,
  type DesktopClient,
} from "../../transport/desktop/desktop";
export interface DesktopResult extends ToolResult<Record<string, unknown>> {
  content: (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  )[];
  details: Record<string, unknown>;
  isError?: boolean;
}

export interface DesktopTarget {
  key: string;
  platform: string;
  connect(signal?: AbortSignal): Promise<{ config: HelperConfig; wireCodec?: "zstd" }>;
}

export interface DesktopInput {
  action: "inspect" | "open" | "authorize" | "release" | "release-workspace";
  timeout?: number | undefined;
  uri?: string | undefined;
  source?: "monitor" | "window" | undefined;
  outputName?: string | undefined;
  sessionId?: string | undefined;
  workspaceId?: string | undefined;
}
export interface ScreenshotInput {
  timeout?: number | undefined;
  target?: "screen" | "window" | undefined;
  sessionId?: string | undefined;
}
export interface DesktopOperations {
  desktop(
    connection: DesktopTarget,
    input: DesktopInput,
    signal?: AbortSignal,
  ): Promise<DesktopResult>;
  screenshot(
    connection: DesktopTarget,
    input: ScreenshotInput,
    signal?: AbortSignal,
  ): Promise<DesktopResult>;
  input(
    connection: DesktopTarget,
    input: DesktopInputRequest,
    signal?: AbortSignal,
  ): Promise<DesktopResult>;
  close(): Promise<void>;
}
interface Channel {
  client: Effect.Effect<HelperConnection, unknown>;
  lifetime: Lifetime;
  serial: Queue;
  sessionId?: string;
}
function present(
  metadata: Record<string, unknown> & { status: "ok" | "error" },
  image?: { type: "image"; data: string; mimeType: string },
): DesktopResult {
  return {
    content: [
      { type: "text", text: JSON.stringify(metadata, null, 2) },
      ...(image ? [image] : []),
    ],
    details: metadata,
    ...(metadata.status === "error" ? { isError: true } : {}),
  };
}

const DEFAULT_DESKTOP_TIMEOUT = 30;

type DesktopAction = (
  input: DesktopInput,
  channel: Channel,
  client: DesktopClient,
) => Promise<DesktopResult>;

const DESKTOP_ACTIONS = {
  inspect: async (_input, _channel, client) =>
    present(await client.request("desktop.inspect", {})),
  open: async (input, _channel, client) => {
    const capabilities = await client.request("desktop.inspect", {});
    if (capabilities.status === "error") return present(capabilities);
    const opener = capabilities.operations.find(
      (operation) => operation.operation === "open",
    );
    if (!opener?.available)
      return present({
        status: "error",
        code: "prerequisite",
        message:
          opener?.reason ??
          "The native helper does not advertise an available isolated workspace opener",
      });
    return present(await client.request("desktop.open", { uri: input.uri ?? "" }));
  },
  authorize: async (input, channel, client) => {
    const result = await client.request("desktop.authorize", {
      source: input.source ?? "monitor",
      ...(input.outputName ? { outputName: input.outputName } : {}),
    });
    if (result.status === "ok") channel.sessionId = result.sessionId;
    return present(result);
  },
  release: async (input, channel, client) => {
    const result = await client.request("desktop.release", {
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    });
    if (result.status === "ok") delete channel.sessionId;
    return present(result);
  },
  "release-workspace": async (input, _channel, client) =>
    present(
      await client.request("desktop.workspace.release", {
        workspaceId: input.workspaceId ?? "",
      }),
    ),
} satisfies Record<DesktopInput["action"], DesktopAction>;

export function createDesktop(): DesktopOperations {
  const channels = new Map<string, Channel>();
  let generation = 0;
  async function get(connection: DesktopTarget, signal?: AbortSignal) {
    if (!["linux", "macos", "windows"].includes(connection.platform))
      throw new Error("Remote desktop requires Linux, macOS or Windows");
    const key = connection.key;
    let channel = channels.get(key);
    if (!channel) {
      const openingGeneration = generation;
      const { config, wireCodec } = await connection.connect(signal);
      signal?.throwIfAborted();
      if (generation !== openingGeneration)
        throw new Error("Desktop session changed while connecting");
      // Insert only after asynchronous preflight and its generation check: racing
      // callers share one channel without caching a cancelled or stale connection
      // attempt
      channel = channels.getOrInsertComputed(key, () => {
        const lifetime = new Lifetime("sequential");
        const fresh: Channel = {
          serial: new Queue(),
          lifetime,
          client: Effect.runSync(
            Effect.cached(
              lifetime
                .runEffect(
                  Effect.interruptible(
                    connectHelperEffect("remote-desktop", config, {
                      ...(wireCodec ? { wireCodec } : {}),
                      onClose: () => {
                        if (channels.get(key) === fresh) channels.delete(key);
                        void fresh.lifetime.close().catch(() => undefined);
                      },
                    }),
                  ),
                )
                .pipe(
                  Effect.onExit((exit) =>
                    Effect.sync(() => {
                      if (Exit.isFailure(exit) && channels.get(key) === fresh)
                        channels.delete(key);
                    }),
                  ),
                ),
            ),
          ),
        };
        return fresh;
      });
    }
    return channel;
  }
  async function run(
    connection: DesktopTarget,
    signal: AbortSignal | undefined,
    work: (client: DesktopClient, channel: Channel) => Promise<DesktopResult>,
  ) {
    const channel = await get(connection, signal);
    return channel.serial.run(async () => {
      signal?.throwIfAborted();
      try {
        const client = await channel.lifetime.run(channel.client, signal);
        return await work(createDesktopClient(client), channel);
      } catch (error) {
        await channel.lifetime.close();
        throw error;
      }
    }, signal);
  }
  return {
    async close() {
      generation++;
      const pending = [...channels.values()];
      channels.clear();
      await runEffect(
        Effect.forEach(pending, (channel) => channel.lifetime.closeEffect, {
          concurrency: "unbounded",
          discard: true,
        }),
      );
    },
    desktop(connection, input, signal) {
      return run(connection, signal, async (client, channel) => {
        const timeout = (input.timeout ?? DEFAULT_DESKTOP_TIMEOUT) * 1000;
        return DESKTOP_ACTIONS[input.action](input, channel, {
          ...client,
          request: (method, args) => client.request(method, args, signal, timeout),
        });
      });
    },
    screenshot(connection, input, signal) {
      return run(connection, signal, async (client, channel) => {
        const sessionId = input.sessionId ?? channel.sessionId;
        const args = {
          ...(sessionId ? { sessionId } : {}),
          ...(input.target
            ? {
                source:
                  input.target === "window"
                    ? ("window" as const)
                    : ("monitor" as const),
              }
            : {}),
        };
        const { metadata, image } = await client.capture(
          args,
          signal,
          (input.timeout ?? DEFAULT_DESKTOP_TIMEOUT) * 1000,
        );
        if (metadata.status === "ok") channel.sessionId = metadata.frame.sessionId;
        return present(metadata, image);
      });
    },
    input(connection, input, signal) {
      return run(connection, signal, async (client) =>
        present(await client.request("desktop.input", input, signal)),
      );
    },
  };
}
