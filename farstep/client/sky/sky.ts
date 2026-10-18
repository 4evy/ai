import { attempt, run } from "@ai/core/effect/effect";
import { Queue } from "@ai/core/effect/queue/queue";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Exit } from "effect";
import * as v from "valibot";

import { ChannelSession, structured } from "./channel";
import {
  type FleetOptions,
  fileSchema,
  type SkyChannel,
  type SkyTarget,
} from "./contracts";
import { skyTransport } from "./transport";

export type { SkyChannel, SkyTarget } from "./contracts";

class SkyFleet {
  private readonly channels = new Map<
    string,
    { pending?: Promise<SkyChannel>; serial: Queue }
  >();
  private closing: Promise<void> | undefined;
  private lifetime = new AbortController();
  constructor(private readonly options: FleetOptions) {}

  private async open(input: SkyTarget, signal?: AbortSignal): Promise<SkyChannel> {
    const closedFleet = this.lifetime.signal;
    const entry = this.channels.get(key(input));
    const client = new Client({ name: "farstep-sky-client", version: "1.0.0" });
    const transport = skyTransport(input, this.options);
    const session = new ChannelSession(client, transport, closedFleet, () => {
      if (this.channels.get(key(input)) === entry) this.channels.delete(key(input));
    });
    return session.open(signal);
  }

  readonly withChannel = async <T>(
    input: SkyTarget,
    work: (channel: SkyChannel) => Promise<T>,
    signal?: AbortSignal,
  ) => {
    if (this.closing) throw new Error("Sky fleet is closing");
    const id = key(input);
    const entry = this.channels.getOrInsertComputed(id, () => ({
      serial: new Queue(),
    }));
    const active = signal
      ? AbortSignal.any([signal, this.lifetime.signal])
      : this.lifetime.signal;
    return entry.serial.run(async () => {
      try {
        entry.pending ??= this.open(input, active);
        return await work(await entry.pending);
      } catch (error) {
        const channel = await entry.pending?.catch(() => undefined);
        if ((!channel || channel.isClosed()) && this.channels.get(id) === entry)
          this.channels.delete(id);
        throw error;
      }
    }, active);
  };

  readonly execute = async (
    input: SkyTarget,
    code: string | undefined,
    reset: boolean | undefined,
    options: { title?: string; timeout_ms?: number } = {},
    signal?: AbortSignal,
  ) => {
    if (!reset && code === undefined) throw new Error("Provide code or reset:true");
    return this.withChannel(
      input,
      async (channel) => {
        await channel.prepare(signal);
        let result: CallToolResult | undefined;
        if (reset) result = await channel.call("js_reset", {}, signal);
        if (!result?.isError && code !== undefined)
          result = await channel.call(
            "js",
            { code, ...options },
            signal,
            (options.timeout_ms ?? 30_000) + 15_000,
          );
        if (!result) throw new Error("Sky returned no result");
        return {
          ...result,
          details: {
            serverName: "farstep-sky",
            mcpToolName: "js",
            target: input.target ?? "local",
            ...channel.identity,
          },
        };
      },
      signal,
    );
  };

  readonly sync = async (
    from: SkyTarget & { path: string },
    to: SkyTarget & { path: string },
    expectedSha256: string | null,
    signal?: AbortSignal,
  ) => {
    // Release the source queue before acquiring the destination, even for one host
    const file = await this.withChannel(
      from,
      async (channel) => {
        if (!channel.identity.capabilities.includes("sky-file-cas-v1"))
          throw new Error("Source Farstep lacks file exchange");
        return v.parse(
          fileSchema,
          structured(await channel.call("sky.file.read", { path: from.path }, signal)),
        );
      },
      signal,
    );
    return this.withChannel(
      to,
      async (channel) => {
        if (!channel.identity.capabilities.includes("sky-file-cas-v1"))
          throw new Error("Destination Farstep lacks file exchange");
        const result = await channel.call(
          "sky.file.write",
          { path: to.path, data: file.data, sha256: file.sha256, expectedSha256 },
          signal,
        );
        structured(result);
        return {
          ...result,
          content: [
            { type: "text" as const, text: JSON.stringify(result.structuredContent) },
          ],
          details: {
            from: from.target ?? "local",
            to: to.target ?? "local",
            ...result.structuredContent,
          },
        };
      },
      signal,
    );
  };

  readonly close = (): Promise<void> => {
    if (this.closing) return this.closing;
    this.lifetime.abort(new Error("Sky fleet closed"));
    const entries = [...this.channels.values()];
    this.channels.clear();
    this.closing = run(
      Effect.forEach(
        entries,
        (entry) =>
          entry.serial
            .runEffect(
              attempt(async () =>
                (await entry.pending?.catch(() => undefined))?.close(),
              ),
            )
            .pipe(Effect.exit),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.flatMap((results) => {
          const failed = results.find(Exit.isFailure);
          return failed ? Effect.failCause(failed.cause) : Effect.void;
        }),
      ),
    ).finally(() => {
      this.lifetime = new AbortController();
      this.closing = undefined;
    });
    return this.closing;
  };
}

function key(input: SkyTarget) {
  return JSON.stringify([input.target ?? "local", input.cwd ?? null]);
}

export function createSkyFleet(options: FleetOptions = {}) {
  const fleet = new SkyFleet(options);
  return {
    execute: fleet.execute,
    sync: fleet.sync,
    withChannel: fleet.withChannel,
    close: fleet.close,
  };
}
