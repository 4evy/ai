import { quotePosixArgument as quote } from "@ai/values/shell/shell";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Record as Records } from "effect";
import { MAX_FRAME } from "../../protocol/sky/execution";

import type { FleetOptions, SkyTarget } from "./contracts";

function skyTarget(input: SkyTarget): string {
  const target = input.target ?? "local";
  if (target.startsWith("-") || /[\s\p{Cc}]/u.test(target) || !target)
    throw new Error(
      "Sky target must be local or an OpenSSH host/alias without whitespace or control characters",
    );
  if (input.cwd?.includes("\0")) throw new Error("Sky cwd contains NUL");
  return target;
}
export function skyTransport(
  input: SkyTarget,
  options: FleetOptions,
): StdioClientTransport {
  const target = skyTarget(input);
  const args = ["sky", "connect", ...(input.cwd ? ["--cwd", input.cwd] : [])];
  const local = target === "local";
  const env = Records.filter(process.env, (value) => value !== undefined);
  const command = local
    ? options.localCommand || process.env.FARSTEP_SKY_COMMAND || Bun.which("farstep")
    : "ssh";
  if (!command) throw new Error("Install Farstep before opening a local Sky kernel");
  return new StdioClientTransport({
    command,
    args: local
      ? args
      : [
          "-T",
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=10",
          "-o",
          "ServerAliveInterval=15",
          "-o",
          "ServerAliveCountMax=2",
          "--",
          target,
          options.remoteCommand
            ? `exec ${quote(options.remoteCommand)} ${args.map(quote).join(" ")}`
            : `helper="\${XDG_DATA_HOME:-$HOME/.local/share}/farstep/current/bin/farstep"; [ -x "$helper" ] || helper=$(command -v farstep) || exit 69; exec "$helper" ${args.map(quote).join(" ")}`,
        ],
    env,
    stderr: "inherit",
    maxBufferSize: MAX_FRAME,
  });
}
