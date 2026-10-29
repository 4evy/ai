import { isIP } from "node:net";
import { run } from "@ai/runtime/effect/effect";
import { quotePosixArgument as quote } from "@ai/values/shell/shell";
import * as v from "valibot";
import {
  type ExecutionTarget,
  scriptCommandEffect,
} from "../client/execution/execution";
import { localHelper, localTarget } from "../client/execution/local";
import type { GatewayConnection } from "../client/jobs/gateway";
import type { HelperConfig } from "../transport/connection/bun";

export const connectionInputSchema = v.strictObject({
  target: v.optional(v.string(), "local"),
  cwd: v.pipe(v.string(), v.startsWith("/")),
});
export type ConnectionInput = v.InferOutput<typeof connectionInputSchema>;
export interface ToolConnection {
  input: ConnectionInput;
  target: ExecutionTarget;
  command(script: string): HelperConfig;
  gateway(scope: string, owner: string): GatewayConnection;
  sshArgs: string[] | undefined;
}

export async function toolConnection(input: ConnectionInput): Promise<ToolConnection> {
  if (input.target === "local") {
    const target = await localTarget(input.cwd);
    const helper = await localHelper(target);
    return {
      input,
      target,
      sshArgs: undefined,
      command: (script) => ({
        command: target.bash,
        args: ["-c", script],
        cwd: target.cwd,
      }),
      gateway: (scope, owner) => ({
        backend: "local",
        platform: target.info.os,
        transport: {
          command: helper,
          args: ["jobs", "--scope", scope, "--owner", owner],
          cwd: target.cwd,
        },
      }),
    };
  }
  const parts = input.target.split("@");
  const host = parts.at(-1) ?? "";
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (
    parts.length > 2 ||
    parts.some((part) => !part || part.startsWith("-") || /[\s\p{Cc}]/u.test(part)) ||
    (!isIP(bare) && !/^[A-Za-z0-9._-]+$/u.test(host)) ||
    (parts.length === 2 && /[/@:]/u.test(parts[0] ?? ""))
  )
    throw new Error("target must be an OpenSSH alias, hostname, or user@host");
  // Keep OpenSSH's host-key and user configuration policy intact
  const sshArgs = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
  ];
  const command = (script: string): HelperConfig => ({
    command: "ssh",
    args: [...sshArgs, input.target, `sh -c ${quote(script)}`],
  });
  const facts = await run(
    scriptCommandEffect(
      async (script) => command(script),
      `set -eu\nprintf '%s\\n' "$HOME" "$(uname -s)" "$(command -v bash)"`,
    ),
  );
  const [home, os, bash] = facts.trimEnd().split("\n");
  if (
    !home?.startsWith("/") ||
    !bash?.startsWith("/") ||
    !["Linux", "Darwin"].includes(os ?? "")
  )
    throw new Error(
      "Target requires Linux or macOS with Bash and an activated Farstep installation",
    );
  const target: ExecutionTarget = {
    backend: "ssh",
    id: input.target,
    home,
    cwd: input.cwd,
    bash,
    info: { os: os === "Darwin" ? "macos" : "linux" },
  };
  return {
    input,
    target,
    command,
    sshArgs,
    gateway: (scope, owner) => ({
      backend: "ssh",
      platform: os === "Darwin" ? "macos" : "linux",
      transport: command(
        `set -eu\ncd ${quote(input.cwd)}\nhelper="\${XDG_DATA_HOME:-$HOME/.local/share}/farstep/current/bin/farstep"\nif [ ! -x "$helper" ]; then helper="$(command -v farstep)"; fi\n[ -x "$helper" ] || { printf '%s\\n' 'Activated Farstep is required' >&2; exit 69; }\nexec "$helper" jobs --scope ${quote(scope)} --owner ${quote(owner)}`,
      ),
    }),
  };
}
