export { helperCommand } from "farstep/client/execution/helper";

import { attempt, run } from "@ai/core/effect/effect";
import {
  buildRemoteCommand,
  ensureConnection,
  type SSHConnectionTarget,
  type SSHHostInfo,
} from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import { wrapInPosixShell } from "@oh-my-pi/pi-coding-agent/ssh/utils";
import { Effect } from "effect";
import type { Connection } from "./types";

export const argvEffect = Effect.fnUntraced(function* (
  target: SSHConnectionTarget,
  info: SSHHostInfo,
  script: string,
  pty: boolean,
) {
  if (info.os !== "windows" && !info.transferShell) {
    return yield* Effect.fail(
      new Error(
        "Remote connections require a verified POSIX transfer shell on a non-Windows host",
      ),
    );
  }
  const command =
    info.os === "windows"
      ? `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`
      : wrapInPosixShell(info.transferShell ?? "sh", script);
  const native = yield* attempt(
    () => buildRemoteCommand(target, command, { allowStdin: true }),
    { awaitOnInterrupt: true },
  );
  return [
    pty ? "-tt" : "-T",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    ...native,
  ];
});

export function argv(
  target: SSHConnectionTarget,
  info: SSHHostInfo,
  script: string,
  pty: boolean,
): Promise<string[]> {
  return run(argvEffect(target, info, script, pty));
}

export const remoteArgvEffect = Effect.fnUntraced(function* (
  connection: Connection,
  script: string,
  pty: boolean,
) {
  yield* attempt(() => ensureConnection(connection.target), { awaitOnInterrupt: true });
  return yield* argvEffect(connection.target, connection.info, script, pty);
});

export function remoteArgv(
  connection: Connection,
  script: string,
  pty: boolean,
): Promise<string[]> {
  return run(remoteArgvEffect(connection, script, pty));
}
