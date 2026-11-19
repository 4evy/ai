import { quotePosixArgument } from "@ai/values/shell/shell";
import { Effect } from "effect";
import { unixHelperSelection } from "farstep/client/execution/helper";
import { localHelperEffect } from "farstep/client/execution/local";
import type { GatewayConnection } from "farstep/client/jobs/gateway";
import { REMOTE_TOOLS } from "farstep/remote/tools/names";
import { remoteArgvEffect } from "../../connections/command";
import type { ExecutionTarget } from "../../connections/types";

export const gatewayTransportEffect = Effect.fnUntraced(function* (
  connection: ExecutionTarget,
  scopeId: string,
  owner: string,
) {
  if (connection.info.os !== "linux" && connection.info.os !== "macos")
    return yield* Effect.fail(
      new Error("Managed jobs require a Linux or macOS farstep target"),
    );
  const transport =
    connection.backend === "local"
      ? {
          command: yield* localHelperEffect(connection),
          args: ["jobs", "--scope", scopeId, "--owner", owner],
          cwd: connection.cwd,
        }
      : {
          command: "ssh",
          args: yield* remoteArgvEffect(
            connection,
            `${unixHelperSelection(connection.info.os)}\n[ -x "$helper" ] || { printf '%s\\n' 'farstep is not installed; use ${REMOTE_TOOLS.helper}' >&2; exit 69; }\nexec "$helper" jobs --scope ${quotePosixArgument(scopeId)} --owner ${quotePosixArgument(owner)}`,
            false,
          ),
        };
  return {
    backend: connection.backend ?? "ssh",
    platform: connection.info.os,
    transport,
  } satisfies GatewayConnection;
});
