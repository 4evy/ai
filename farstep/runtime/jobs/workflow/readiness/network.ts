import { get } from "@ai/runtime/effect/http/http";
import { scopedSocket } from "@ai/runtime/effect/socket/socket";
import { Effect, Stream } from "effect";
import type { WorkflowReady } from "#farstep/protocol/workflow/workflow";

import { errorCode, errorMessage, type Observation } from "./context";

const MAX_BODY_BYTES = 65536;

const TRANSIENT_NETWORK_CODES: Record<string, true> = {
  ECONNREFUSED: true,
  ECONNRESET: true,
  EPIPE: true,
  ETIMEDOUT: true,
  EHOSTUNREACH: true,
  ENETUNREACH: true,
  ENETDOWN: true,
  EADDRNOTAVAIL: true,
  ENOTFOUND: true,
  EAI_AGAIN: true,
  UND_ERR_CONNECT_TIMEOUT: true,
  UND_ERR_HEADERS_TIMEOUT: true,
  UND_ERR_BODY_TIMEOUT: true,
  UND_ERR_SOCKET: true,
};

function transientNetworkError(error: unknown, depth = 0): boolean {
  const code = errorCode(error);
  if (code && Object.hasOwn(TRANSIENT_NETWORK_CODES, code)) return true;
  if (depth < 8 && typeof error === "object" && error !== null && "cause" in error)
    return transientNetworkError(error.cause, depth + 1);
  // Bun's fetch connection failures do not always expose a Node errno
  return (
    error instanceof Error &&
    /^(Unable to connect|Connection (closed|refused)|The socket connection was closed|fetch failed)/u.test(
      error.message,
    )
  );
}

function networkFailure(error: unknown): Observation {
  return {
    ready: false,
    reason: errorMessage(error),
    fatal: !transientNetworkError(error),
  };
}

export function tcpProbe(
  ready: Extract<WorkflowReady, { kind: "tcp" }>,
): Effect.Effect<Observation> {
  return Effect.scoped(
    scopedSocket({ host: ready.host, port: ready.port }).pipe(
      Effect.as({
        ready: true,
        reason: `Connected to ${ready.host}:${ready.port}`,
      }),
    ),
  ).pipe(Effect.catch((error) => Effect.succeed(networkFailure(error))));
}

export function httpProbe(
  ready: Extract<WorkflowReady, { kind: "http" }>,
  url: URL,
): Effect.Effect<Observation> {
  return Effect.gen(function* () {
    const response = yield* get(url.href, { redirect: "manual" });
    if (response.status !== ready.status)
      return {
        ready: false,
        reason: `HTTP status ${response.status}; expected ${ready.status}`,
      };
    const needle = ready.bodyContains;
    if (needle === undefined || needle === "")
      return {
        ready: true,
        reason: `HTTP status ${response.status} matched`,
      };
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    if (![204, 205, 304].includes(response.status)) {
      yield* response.stream.pipe(
        Stream.map((chunk) => {
          const retained = chunk.subarray(0, MAX_BODY_BYTES - bytes);
          bytes += retained.byteLength;
          text += decoder.decode(retained, { stream: true });
          return bytes >= MAX_BODY_BYTES || text.includes(needle);
        }),
        Stream.takeUntil((complete) => complete),
        Stream.runDrain,
      );
    }
    if (bytes < MAX_BODY_BYTES && !text.includes(needle)) text += decoder.decode();
    const matched = text.includes(needle);
    return {
      ready: matched,
      reason: matched
        ? `HTTP status ${response.status} and body matched`
        : bytes >= MAX_BODY_BYTES
          ? "HTTP body match was not found within the 64 KiB limit"
          : "HTTP body did not contain the required text",
    };
  }).pipe(
    Effect.scoped,
    Effect.catch((error) => Effect.succeed(networkFailure(error))),
  );
}
