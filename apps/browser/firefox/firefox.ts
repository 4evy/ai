import { readFileSync as readResource } from "node:fs";
import { writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attempt } from "@ai/runtime/effect/effect";
import { temporaryDirectory } from "@ai/runtime/effect/fs/fs";
import { terminateProcess } from "@ai/runtime/effect/process/process";
import { connectSocket } from "@ai/runtime/effect/socket/socket";
import { ConcatSink } from "@oh-my-pi/pi-utils";
import { Effect, Schedule } from "effect";
import * as v from "valibot";
import { hasErrorCode, runUserAgent, START_TIMEOUT_MS } from "../agent/agent.ts";

const COMMAND_NAME = "ai browser firefox user agent";
const POLL_INTERVAL_MS = 25;
const MAX_PACKET_BYTES = 1024 * 1024;
const packetMetadata = v.looseObject({
  from: v.string(),
  type: v.optional(v.string()),
  error: v.optional(v.string()),
  message: v.optional(v.string()),
});

function connectDevTools(path: string, browser: Bun.Subprocess) {
  return Effect.suspend(() => {
    if (browser.exitCode !== null)
      return Effect.fail(new Error(`Browser exited with status ${browser.exitCode}`));
    return connectSocket({ path });
  }).pipe(
    Effect.retry({
      schedule: Schedule.spaced(POLL_INTERVAL_MS),
      while: (error) =>
        hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ECONNREFUSED"),
    }),
    Effect.timeoutOrElse({
      duration: START_TIMEOUT_MS,
      orElse: () =>
        Effect.fail(
          new Error("Browser did not expose a DevTools socket within 15 seconds"),
        ),
    }),
  );
}

function devToolsPacket(buffer: Buffer) {
  // Firefox frames JSON with its UTF-8 byte length followed by a colon
  const colon = buffer.indexOf(58);
  if (colon < 0) {
    if (buffer.length > 10) throw new Error("Invalid DevTools packet length");
    return undefined;
  }
  const prefix = buffer.subarray(0, colon).toString("ascii");
  const length = Number(prefix);
  if (!/^\d+$/.test(prefix) || length < 1 || length > MAX_PACKET_BYTES)
    throw new Error("Invalid DevTools packet length");
  const end = colon + 1 + length;
  if (buffer.length < end) return undefined;
  const packet = v.parse(
    packetMetadata,
    JSON.parse(buffer.subarray(colon + 1, end).toString("utf8")),
  );
  return { packet, remaining: buffer.subarray(end) };
}

function readDevToolsUserAgent(socket: Socket) {
  return Effect.scoped(
    Effect.gen(function* () {
      let detach = () => {};
      yield* Effect.acquireRelease(Effect.succeed(socket), (socket) =>
        Effect.sync(() => {
          detach();
          socket.destroy();
        }),
      );
      return yield* Effect.callback<string, unknown>((resume) => {
        const fail = (error: unknown) => resume(Effect.fail(error));
        const buffer = new ConcatSink();
        let stage: "greeting" | "process" | "target" | "evaluation" = "greeting";
        let actor = "root";
        let resultID: string | undefined;
        const send = (request: Record<string, unknown>) => {
          const body = JSON.stringify(request);
          socket.write(`${Buffer.byteLength(body)}:${body}`);
        };

        const closed = () => fail(new Error("Browser DevTools connection closed"));
        const evaluate = (packet: v.InferOutput<typeof packetMetadata>): boolean => {
          if (packet.type === undefined) {
            resultID = v.parse(v.object({ resultID: v.string() }), packet).resultID;
            return false;
          }
          if (packet.type !== "evaluationResult" || packet.resultID !== resultID)
            return false;
          const response = v.parse(
            v.object({
              hasException: v.literal(false),
              result: v.pipe(v.string(), v.nonEmpty()),
            }),
            packet,
          );
          resume(Effect.succeed(response.result));
          return true;
        };
        const handlePacket = (
          packet: v.InferOutput<typeof packetMetadata>,
        ): boolean => {
          if (packet.from !== actor) return false;
          if (packet.error)
            throw new Error(
              `Browser DevTools: ${packet.error}: ${packet.message ?? ""}`,
            );

          switch (stage) {
            case "greeting":
              v.parse(v.object({ applicationType: v.literal("browser") }), packet);
              stage = "process";
              send({ to: actor, type: "getProcess", id: 0 });
              break;
            case "process": {
              const response = v.parse(
                v.object({ processDescriptor: v.object({ actor: v.string() }) }),
                packet,
              );
              actor = response.processDescriptor.actor;
              stage = "target";
              send({ to: actor, type: "getTarget" });
              break;
            }
            case "target": {
              const response = v.parse(
                v.object({ process: v.object({ consoleActor: v.string() }) }),
                packet,
              );
              actor = response.process.consoleActor;
              stage = "evaluation";
              // Read the HTTP service directly so no browser window is needed
              send({
                to: actor,
                type: "evaluateJSAsync",
                text: 'Cc["@mozilla.org/network/protocol;1?name=http"].getService(Ci.nsIHttpProtocolHandler).userAgent',
              });
              break;
            }
            case "evaluation":
              return evaluate(packet);
          }
          return false;
        };
        const data = (data: Buffer) => {
          try {
            buffer.append(data);
            while (!buffer.isEmpty) {
              const bytes = buffer.flush();
              if (!bytes) break;
              const frame = devToolsPacket(
                Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
              );
              if (!frame) break;
              buffer.consume(bytes.byteLength - frame.remaining.byteLength);
              if (handlePacket(frame.packet)) return;
            }
          } catch (error) {
            fail(error);
          }
        };
        detach = () => {
          socket.removeListener("error", fail);
          socket.removeListener("close", closed);
          socket.removeListener("data", data);
        };
        socket.on("error", fail);
        socket.on("close", closed);
        socket.on("data", data);
      });
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: START_TIMEOUT_MS,
      orElse: () => Effect.fail(new Error("Browser DevTools request timed out")),
    }),
  );
}

const probeUserAgent = Effect.fnUntraced(function* (command: string[]) {
  const profile = yield* temporaryDirectory(join(tmpdir(), `${COMMAND_NAME}-`));
  const socketPath = join(profile.path, "socket");
  yield* attempt(
    (signal) =>
      writeFile(
        join(profile.path, "user.js"),
        [
          'user_pref("devtools.debugger.remote-enabled", true);',
          'user_pref("devtools.chrome.enabled", true);',
          'user_pref("devtools.debugger.prompt-connection", false);',
          'user_pref("devtools.debugger.force-local", true);',
          "",
        ].join("\n"),
        { mode: 0o600, signal },
      ),
    { awaitOnInterrupt: true },
  );
  const browser = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        Bun.spawn(
          [
            ...command,
            ...(process.platform === "linux" ? ["--headless"] : []),
            "--no-remote",
            "--profile",
            profile.path,
            "--start-debugger-server",
            socketPath,
          ],
          {
            // macOS supports silent startup; Linux needs a headless browser window
            env: {
              ...Bun.env,
              MOZ_APP_SILENT_START: process.platform === "darwin" ? "1" : "",
            },
            stderr: "ignore",
            stdout: "ignore",
          },
        ),
      catch: (error) => error,
    }),
    (browser) => terminateProcess(browser).pipe(Effect.orDie),
  );

  const socket = yield* Effect.acquireRelease(
    connectDevTools(socketPath, browser),
    (socket) =>
      Effect.sync(() => {
        socket.destroy();
      }),
    { interruptible: true },
  );
  return yield* readDevToolsUserAgent(socket);
}, Effect.scoped);

await runUserAgent({
  commandName: COMMAND_NAME,
  browserName: "Firefox",
  environmentVariable: "FIREFOX_BROWSER",
  browserCommands: ["firefox", "firefox-esr", "firefox-devedition", "firefox-nightly"],
  macosBrowsers: [
    ["Firefox.app", "firefox"],
    ["Firefox ESR.app", "firefox"],
    ["Firefox Developer Edition.app", "firefox"],
    ["Firefox Nightly.app", "firefox"],
  ],
  usage: readResource(new URL("./usage.txt", import.meta.url), "utf8"),
  probe: probeUserAgent,
});
