import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { attempt, Lifetime, run } from "@ai/core/effect/effect";
import { Queue } from "@ai/core/effect/queue/queue";
import { readText } from "@ai/core/text/text";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Deferred, Effect } from "effect";
import { PROVISION_TIMEOUT_MS } from "farstep/protocol/sky/limits";
import { BoundedFrames } from "farstep/transport/bounds";
import { waylandReference } from "../../protocol/sky/desktop";
import { EMPTY_INPUT, EXECUTION_TOOLS, MAX_FRAME } from "../../protocol/sky/execution";
import { serveStdio, type ToolRegistrar, toolRegistry } from "../jobs/tools";
import { loadIdentity, PROTOCOL_MAJOR, VERSION } from "../state";
import { registerExchange } from "./exchange/exchange";
import { SkyKernel } from "./kernel";
import { MODULES, REFERENCE_PATHS, SKY_BACKEND, SKY_VERSION } from "./runtime/paths";
import { runtimeServer } from "./runtime/server";

// The connection owns one kernel and its input leases; clients never replay cells
class SkyConnection {
  private readonly disconnected = new AbortController();
  private readonly serial = new Queue();
  private readonly completed = Deferred.makeUnsafe<void>();
  private readonly server: Server;
  private readonly kernel: SkyKernel;
  private negotiated = false;
  private stopped = false;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly cwd: string,
    private readonly identity: Awaited<ReturnType<typeof loadIdentity>>,
    private readonly handlers: Lifetime,
  ) {
    this.kernel = new SkyKernel(cwd);
    this.server = new Server(
      { name: "farstep-sky", version: VERSION },
      {
        instructions: readText(new URL("./sky.md", import.meta.url), "instructions", {
          MINUTES: String(PROVISION_TIMEOUT_MS / 60_000),
        }),
      },
    );
  }

  private requireHandshake(): void {
    if (!this.negotiated)
      throw new Error("helper.handshake is required before Sky operations");
    if (this.stopped)
      throw new Error("Sky connection is closing; the operation was not replayed");
  }

  private execute<A>(
    work: (signal: AbortSignal) => Promise<A>,
    signal: AbortSignal,
  ): Promise<A> {
    return this.serial.run(async () => {
      this.requireHandshake();
      return work(AbortSignal.any([signal, this.disconnected.signal]));
    }, signal);
  }

  private registerHandshake(register: ToolRegistrar): void {
    register("helper.handshake", { inputSchema: EMPTY_INPUT }, async () => {
      this.negotiated = true;
      return {
        content: [],
        structuredContent: {
          protocolMajor: PROTOCOL_MAJOR,
          version: VERSION,
          ...this.identity,
          platform: process.platform,
          arch: process.arch,
          cwd: this.cwd,
          skyVersion: SKY_VERSION,
          skyBackend: SKY_BACKEND,
          capabilities: ["sky-mcp-v1", "sky-file-cas-v1"],
        },
      };
    });
  }

  private registerPreparation(register: ToolRegistrar): void {
    register("sky.prepare", { inputSchema: EMPTY_INPUT }, (_input, signal) =>
      this.execute(async (combined) => {
        await this.kernel.prepare(combined);
        return {
          content: [],
          structuredContent: {
            ready: true,
            platform: process.platform,
            skyVersion: SKY_VERSION,
            skyBackend: SKY_BACKEND,
          },
        };
      }, signal),
    );
    register("sky.reference", { inputSchema: EMPTY_INPUT }, async (_input, signal) => {
      this.requireHandshake();
      if (SKY_BACKEND === "wayland") {
        const reference = waylandReference();
        return {
          content: [
            {
              type: "text",
              text: `Farstep Wayland bridge API. Upstream Sky app/window methods are unavailable\n\n${JSON.stringify(reference, null, 2)}`,
            },
          ],
          structuredContent: { skyBackend: SKY_BACKEND, reference },
        };
      }
      await runtimeServer(
        this.cwd,
        AbortSignal.any([signal, this.disconnected.signal]),
      );
      const references = await Promise.all(
        REFERENCE_PATHS.map(
          async (path) =>
            `Source: ${path}\n\n${await Bun.file(join(MODULES, path)).text()}`,
        ),
      );
      return { content: [{ type: "text", text: references.join("\n\n") }] };
    });
  }

  private registerExecution(register: ToolRegistrar): void {
    for (const tool of EXECUTION_TOOLS)
      register(tool.name, { inputSchema: tool.schema }, (input, signal) =>
        this.execute(
          (combined) =>
            this.kernel.invoke(
              tool.name,
              input,
              combined,
              ("timeout_ms" in input && typeof input.timeout_ms === "number"
                ? input.timeout_ms
                : tool.defaultTimeoutMs) + tool.graceMs,
            ),
          signal,
        ),
      );
  }

  private registerTools(): void {
    const register = toolRegistry(this.server, this.handlers);
    this.registerHandshake(register);
    this.registerPreparation(register);
    this.registerExecution(register);
    registerExchange(
      register,
      () => this.requireHandshake(),
      this.cwd,
      this.disconnected.signal,
    );
  }

  private close(): Promise<void> {
    const connection = this;
    this.closing ??= run(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(connection.completed, undefined),
        );
        yield* Effect.addFinalizer(() =>
          attempt(() => connection.server.close()).pipe(Effect.orDie),
        );
        yield* Effect.addFinalizer(() =>
          attempt(() => connection.kernel.close()).pipe(Effect.orDie),
        );
        connection.stopped = true;
        connection.disconnected.abort();
        yield* attempt(() => connection.handlers.close());
        yield* attempt(() => connection.serial.run(async () => undefined));
        const client = yield* attempt(() => connection.kernel.settled());
        if (client)
          yield* attempt(() => connection.kernel.release(client)).pipe(Effect.ignore);
      }).pipe(Effect.scoped),
    );
    return this.closing;
  }

  async run(): Promise<void> {
    this.registerTools();
    const bounded = new BoundedFrames(MAX_FRAME, "Sky request exceeded 32 MiB");
    const stop = () => {
      void this.close().catch(() => {
        Effect.runSync(Deferred.succeed(this.completed, undefined));
      });
    };
    this.server.onclose = stop;
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stop);
    try {
      await serveStdio(
        this.server,
        bounded,
        () => run(Deferred.await(this.completed)),
        stop,
      );
    } finally {
      try {
        await this.close();
      } finally {
        for (const signal of ["SIGINT", "SIGTERM"] as const) process.off(signal, stop);
      }
    }
  }
}

export async function runSky(directory: string): Promise<void> {
  await using handlers = new Lifetime();
  const cwd = resolve(directory);
  if (!(await stat(cwd)).isDirectory()) throw new Error("Sky cwd is not a directory");
  const identity = await loadIdentity();
  await new SkyConnection(cwd, identity, handlers).run();
}
