import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import {
  buildRemoteCommand,
  ensureConnection,
  ensureHostInfo,
  type SSHConnectionTarget,
} from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import { wrapInPosixShell } from "@oh-my-pi/pi-coding-agent/ssh/utils";
import { ptree } from "@oh-my-pi/pi-utils";
import ipaddr from "ipaddr.js";

function address(value: string): string {
  const bare = (value.replace(/^\[|\]$/g, "").split("%")[0] ?? "").toLowerCase();
  return ipaddr.process(bare).toString();
}

/** Inspect the authenticated server's actual endpoint, not its OpenSSH alias */
export async function isSameMachineSSH(
  target: SSHConnectionTarget,
  opts: {
    controlPath?: string;
    signal?: AbortSignal | undefined;
    timeoutMs?: number;
  } = {},
): Promise<boolean> {
  await ensureConnection(target);
  const info = await ensureHostInfo(target);
  if (!info.transferShell)
    throw new Error("SSH transfer requires a verified POSIX shell");
  const args = await buildRemoteCommand(
    target,
    wrapInPosixShell(info.transferShell, 'printf "%s\\n" "$SSH_CONNECTION"'),
  );
  if (opts.controlPath) args.unshift("-o", `ControlPath=${opts.controlPath}`);
  const signal = ptree.combineSignals(opts.signal, opts.timeoutMs ?? 30_000);
  using child = ptree.spawn(["ssh", ...args], signal ? { signal } : {});
  const connection = (await child.text()).trim().split(/\s+/);
  await child.exitedCleanly;
  const serverAddress = connection[2];
  if (
    connection.length !== 4 ||
    !serverAddress ||
    !isIP(serverAddress.split("%")[0] ?? "")
  ) {
    throw new Error("SSH server did not report its actual endpoint in SSH_CONNECTION");
  }
  const endpoint = address(serverAddress);
  if (ipaddr.parse(endpoint).range() === "loopback") return true;
  return Object.values(networkInterfaces()).some((entries) =>
    entries?.some((entry) => address(entry.address) === endpoint),
  );
}
