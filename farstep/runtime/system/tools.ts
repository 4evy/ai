import { attempt, Lifetime, run } from "@ai/core/effect/effect";
import { readText } from "@ai/core/text/text";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Deferred, Effect, Scope } from "effect";
import {
  SYSTEM_CAPABILITY,
  SYSTEM_MAX_TIMEOUT_SECONDS,
  systemExecSchema,
} from "farstep/protocol/system";
import { BoundedFrames } from "farstep/transport/bounds";
import * as v from "valibot";
import { serveStdio, type ToolRegistrar, toolRegistry } from "../jobs/tools";
import { loadIdentity, MAX_REQUEST_BYTES, PROTOCOL_MAJOR, VERSION } from "../state";
import { systemExec, systemStatus } from "./system";

export function registerSystemTools(
  register: ToolRegistrar,
  requireHandshake: () => void,
  disconnected: AbortSignal,
) {
  register(
    "system.inspect",
    {
      inputSchema: v.strictObject({}),
      description:
        "Inspect Farstep's privileged system service without prompting or changing access",
    },
    async () => {
      requireHandshake();
      return { content: [], structuredContent: await systemStatus() };
    },
  );
  register(
    "system.exec",
    {
      inputSchema: systemExecSchema,
      description: readText(new URL("./tools/tools.md", import.meta.url), "execute", {
        MAX_SECONDS: String(SYSTEM_MAX_TIMEOUT_SECONDS),
      }),
    },
    async (input, signal) => {
      requireHandshake();
      const reply = await systemExec(input, AbortSignal.any([signal, disconnected]));
      return {
        content: [{ type: "text", text: reply.stdout + reply.stderr }],
        structuredContent: reply,
        isError: reply.exitCode !== 0,
      };
    },
  );
}

export async function runSystem() {
  await using lifetime = new Lifetime("sequential");
  const identity = await loadIdentity();
  const server = new Server(
    { name: "farstep-system", version: VERSION },
    {
      instructions: readText(
        new URL("./tools/tools.md", import.meta.url),
        "instructions",
        {
          MAX_SECONDS: String(SYSTEM_MAX_TIMEOUT_SECONDS),
        },
      ),
    },
  );
  await run(
    Scope.addFinalizer(
      lifetime.scope,
      attempt(() => server.close()).pipe(Effect.orDie),
    ),
  );
  const register = toolRegistry(server, lifetime);
  const disconnected = new AbortController();
  let negotiated = false;
  register("helper.handshake", { inputSchema: v.strictObject({}) }, async () => {
    negotiated = true;
    return {
      content: [],
      structuredContent: {
        protocolMajor: PROTOCOL_MAJOR,
        version: VERSION,
        ...identity,
        platform: process.platform,
        capabilities: [SYSTEM_CAPABILITY],
      },
    };
  });
  registerSystemTools(
    register,
    () => {
      if (!negotiated)
        throw new Error("helper.handshake is required before system operations");
    },
    disconnected.signal,
  );
  const bounded = new BoundedFrames(MAX_REQUEST_BYTES, "System request exceeded 1 MiB");
  const completed = Deferred.makeUnsafe<void>();
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    disconnected.abort();
    Deferred.doneUnsafe(completed, Effect.void);
  };
  server.onclose = close;
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
  try {
    await serveStdio(server, bounded, () => run(Deferred.await(completed)), close);
  } finally {
    process.off("SIGTERM", close);
    process.off("SIGINT", close);
  }
}
