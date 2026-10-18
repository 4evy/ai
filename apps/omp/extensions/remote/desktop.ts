import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { isSameMachineSSH } from "@oh-my-pi/pi-coding-agent/ssh/transfer-compression";
import {
  createDesktop as createClient,
  type DesktopInput,
  type DesktopTarget,
  type ScreenshotInput,
} from "farstep/client/desktop/desktop";
import type { DesktopInputRequest } from "farstep/protocol/desktop/desktop";
import { helperCommand, remoteArgv } from "./connections/command";
import type { Connection } from "./connections/types";
import { owner } from "./jobs/records";

function target(connection: Connection, ctx: ExtensionContext): DesktopTarget {
  return {
    key: JSON.stringify([connection.target, owner(ctx)]),
    platform: connection.info.os,
    async connect(signal) {
      const compressed =
        connection.info.os !== "windows" &&
        !(await isSameMachineSSH(connection.target, signal ? { signal } : {}));
      const args = await remoteArgv(
        connection,
        helperCommand(connection, [
          "desktop",
          "connect",
          ...(compressed ? ["--wire-codec=zstd"] : []),
        ]),
        false,
      );
      return {
        config: { command: "ssh", args },
        ...(compressed ? { wireCodec: "zstd" as const } : {}),
      };
    },
  };
}

export function createDesktop() {
  const client = createClient();
  return {
    close: client.close,
    desktop: (
      connection: Connection,
      input: DesktopInput,
      ctx: ExtensionContext,
      signal?: AbortSignal,
    ) => client.desktop(target(connection, ctx), input, signal),
    screenshot: (
      connection: Connection,
      input: ScreenshotInput,
      ctx: ExtensionContext,
      signal?: AbortSignal,
    ) => client.screenshot(target(connection, ctx), input, signal),
    input: (
      connection: Connection,
      input: DesktopInputRequest,
      ctx: ExtensionContext,
      signal?: AbortSignal,
    ) => client.input(target(connection, ctx), input, signal),
  };
}
export type DesktopOperations = ReturnType<typeof createDesktop>;
