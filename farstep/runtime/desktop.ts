import type { Socket } from "node:net";
import { pipeline } from "node:stream";
import { attempt, Lifetime, run } from "@ai/core/effect/effect";
import { scopedSocket } from "@ai/core/effect/socket/socket";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ReadBuffer,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { toError } from "@oh-my-pi/pi-utils/type-guards";
import { Deferred, Effect } from "effect";
import { uuidSchema } from "farstep/protocol/identity";
import { BoundedFrames } from "farstep/transport/bounds";
import { unzstdFrames, zstdFrames } from "farstep/transport/zstd";
import * as v from "valibot";
import { desktopEndpoint } from "./platform/desktop/desktop";
import {
  MAX_DESKTOP_RESPONSE_BYTES,
  MAX_REQUEST_BYTES,
  PROTOCOL_MAJOR,
  VERSION,
} from "./state";

class DesktopTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  #socket: Socket | undefined;
  #buffer = new ReadBuffer();
  readonly #lifetime = new Lifetime();

  async start(): Promise<void> {
    const socket = await this.#lifetime.run(
      Effect.gen(function* () {
        const path = yield* attempt(desktopEndpoint);
        return yield* scopedSocket({ path });
      }),
    );
    this.#socket = socket;
    const bounded = new BoundedFrames(
      MAX_DESKTOP_RESPONSE_BYTES,
      "Desktop response exceeded 46 MiB",
    );
    socket.on("error", (error) => this.onerror?.(error));
    socket.on("close", () => {
      bounded.destroy();
      this.onclose?.();
    });
    bounded.on("error", (error) => {
      this.onerror?.(error);
      socket.destroy();
    });
    bounded.on("data", (chunk: Buffer) => {
      try {
        this.#buffer.append(chunk);
        for (
          let message = this.#buffer.readMessage();
          message !== null;
          message = this.#buffer.readMessage()
        ) {
          this.onmessage?.(message);
        }
      } catch (error) {
        this.onerror?.(toError(error));
        socket.destroy();
      }
    });
    socket.pipe(bounded);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const encoded = serializeMessage(message);
    if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES)
      throw new Error("Desktop request exceeded 1 MiB");
    const socket = this.#socket;
    if (!socket || socket.destroyed) throw new Error("Desktop channel is closed");
    await this.#lifetime.run(
      Effect.callback<void, Error>((resume) => {
        socket.write(encoded, (error) =>
          resume(error ? Effect.fail(error) : Effect.void),
        );
      }),
    );
  }

  async close(): Promise<void> {
    await this.#lifetime.close();
    this.#buffer.clear();
  }
}

const healthSchema = v.strictObject({
  controlLeaseActive: v.boolean(),
  sessions: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  systemCommands: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0)), 0),
});
const handshakeSchema = v.object({
  protocolMajor: v.literal(PROTOCOL_MAJOR),
  version: v.string(),
  installationId: uuidSchema,
  platform: v.literal(process.platform),
  capabilities: v.unknown(),
});

export const desktopHealthEffect = Effect.fnUntraced(function* (
  installationId: string,
  version?: string,
) {
  const client = yield* Effect.acquireRelease(
    Effect.sync(() => new Client({ name: "farstep-management", version: VERSION })),
    (client) => attempt(() => client.close()).pipe(Effect.orDie),
  );
  yield* attempt(
    (signal) => client.connect(new DesktopTransport(), { timeout: 5_000, signal }),
    { awaitOnInterrupt: true },
  );
  const handshake = yield* attempt(
    (signal) =>
      client.callTool({ name: "helper.handshake", arguments: {} }, undefined, {
        timeout: 5_000,
        signal,
      }),
    { awaitOnInterrupt: true },
  );
  if (handshake.isError)
    return yield* Effect.fail(new Error("Desktop handshake failed"));
  const identity = yield* Effect.try({
    try: () => v.parse(handshakeSchema, handshake.structuredContent),
    catch: (error) => error,
  });
  if (
    identity.installationId !== installationId ||
    (version && identity.version !== version)
  )
    return yield* Effect.fail(
      new Error("Desktop installation identity or package version does not match"),
    );
  const result = yield* attempt(
    (signal) =>
      client.callTool({ name: "helper.health", arguments: {} }, undefined, {
        timeout: 5_000,
        signal,
      }),
    { awaitOnInterrupt: true },
  );
  if (result.isError)
    return yield* Effect.fail(new Error("Desktop health request failed"));
  return yield* Effect.try({
    try: () => v.parse(healthSchema, result.structuredContent),
    catch: (error) => error,
  });
}, Effect.scoped);

export function desktopHealth(installationId: string, version?: string) {
  return run(desktopHealthEffect(installationId, version));
}

export function relayDesktop(compressed = false): Promise<void> {
  return run(
    Effect.gen(function* () {
      const path = yield* attempt(desktopEndpoint);
      const socket = yield* scopedSocket({ path });
      yield* Effect.addFinalizer(() => Effect.sync(() => process.stdin.destroy()));
      const completed = Deferred.makeUnsafe<void, Error>();
      function stop(error?: Error | null) {
        if (
          !Effect.runSync(
            error
              ? Deferred.fail(completed, error)
              : Deferred.succeed(completed, undefined),
          )
        )
          return;
        socket.destroy();
        process.stdin.destroy();
      }
      if (compressed) {
        pipeline(
          process.stdin,
          unzstdFrames(MAX_REQUEST_BYTES),
          new BoundedFrames(MAX_REQUEST_BYTES),
          socket,
          stop,
        );
        pipeline(
          socket,
          new BoundedFrames(MAX_DESKTOP_RESPONSE_BYTES),
          zstdFrames(MAX_DESKTOP_RESPONSE_BYTES),
          process.stdout,
          stop,
        );
      } else {
        pipeline(process.stdin, new BoundedFrames(MAX_REQUEST_BYTES), socket, stop);
        pipeline(
          socket,
          new BoundedFrames(MAX_DESKTOP_RESPONSE_BYTES),
          process.stdout,
          stop,
        );
      }
      yield* Deferred.await(completed);
    }).pipe(Effect.scoped),
  );
}
