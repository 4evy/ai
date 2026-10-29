import { isIP } from "node:net";
import { attempt, run } from "@ai/runtime/effect/effect";
import {
  AccessDeniedError,
  DaemonUnreachableError,
  LocalApiError,
  type PeerStatus,
  Tailscaled,
} from "@tailnet/tailscaled";
import { Effect } from "effect";

function machine(peer: PeerStatus, self: boolean) {
  const ips = peer.tailscaleIps ?? [];
  const tailscaleIp =
    ips.find((ip) => isIP(ip) === 4) ?? ips.find((ip) => isIP(ip) === 6) ?? null;
  return {
    kind: self ? "self" : "peer",
    name: peer.hostName || peer.dnsName,
    tailscaleIp,
    os: peer.os,
    online: peer.online ?? null,
    target: self ? "127.0.0.1" : tailscaleIp,
  };
}

function diagnostic(error: unknown): string {
  if (error instanceof AccessDeniedError) {
    return "Tailscale discovery unavailable: local daemon access denied; no privileges were requested";
  }
  if (error instanceof DaemonUnreachableError) {
    return "Tailscale discovery unavailable: local daemon is absent or unreachable";
  }
  if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
    return "Tailscale discovery unavailable: local status request timed out";
  }
  if (error instanceof LocalApiError) {
    return `Tailscale discovery unavailable: local daemon returned HTTP ${error.status}`;
  }
  // Daemon responses and CLI stderr may contain private tailnet information
  return "Tailscale discovery unavailable: check that Tailscale is installed, running and accessible to the OMP user";
}

export async function discoverTailscaleHosts(signal?: AbortSignal) {
  try {
    const client = new Tailscaled({ timeout: 2500 });
    // Version 0.1.2 bounds socket requests but not its macOS/Windows CLI path
    // Bound the guide's wait too; the library cannot cancel an in-flight CLI
    const status = await run(
      attempt(() => client.status()).pipe(
        Effect.timeoutOrElse({
          duration: 3000,
          orElse: () =>
            Effect.fail(new DOMException("Status deadline exceeded", "TimeoutError")),
        }),
      ),
      signal,
    );
    return {
      machines: [
        ...(status.self ? [machine(status.self, true)] : []),
        ...Object.values(status.peer ?? {}).map((peer) => machine(peer, false)),
      ],
      ...(status.backendState === "Running"
        ? {}
        : {
            diagnostic:
              "Tailscale daemon is not connected; discovered machine records may be stale",
          }),
    };
  } catch (error) {
    signal?.throwIfAborted();
    return { machines: [], diagnostic: diagnostic(error) };
  }
}
