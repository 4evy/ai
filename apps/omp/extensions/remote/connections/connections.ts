import { attempt, run } from "@ai/runtime/effect/effect";
import {
  ensureConnection,
  ensureHostInfo,
} from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import { toError } from "@oh-my-pi/pi-utils/type-guards";
import { Effect } from "effect";
import { helperStatusEffect as helperStatus } from "../helper/helper";
import { probeConnectionEffect as probeConnection } from "./probe/probe";
import {
  configuredHostsEffect as configuredHosts,
  fileRoot,
  identifier,
  resolveTarget,
} from "./target";
import type { ConnectInput, Connection } from "./types";

const connectEffect = Effect.fnUntraced(function* (
  input: ConnectInput,
  cwd: string,
): Effect.fn.Return<Connection, unknown> {
  yield* Effect.try({
    try: () => identifier(input.target, "SSH target"),
    catch: (error) => error,
  });
  const { hosts } = yield* configuredHosts(cwd);
  const { target, id, configured } = yield* Effect.try({
    try: () => resolveTarget(input, cwd, hosts),
    catch: (error) => error,
  });
  // Native setup owns fixed budgets; interruption waits for each started call
  yield* attempt(() => ensureConnection(target), { awaitOnInterrupt: true });
  const info = yield* attempt(() => ensureHostInfo(target), { awaitOnInterrupt: true });
  if (info.os !== "windows" && !info.transferShell) {
    return yield* Effect.fail(
      new Error(
        "Remote connections require a verified POSIX transfer shell on a non-Windows host",
      ),
    );
  }
  const facts = yield* probeConnection(target, info, input.cwd, cwd);
  const connection: Connection = {
    id,
    target,
    info,
    ...facts,
    fileRoot: info.os === "windows" ? "" : fileRoot(target, configured, hosts),
  };
  connection.helper = yield* helperStatus(connection).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        installed: false,
        jobsReady: false,
        reason: `Helper status unavailable: ${toError(error).message}`,
      }),
    ),
  );
  return connection;
});

export function connect(
  input: ConnectInput,
  cwd: string,
  signal?: AbortSignal,
): Promise<Connection> {
  return run(connectEffect(input, cwd), signal);
}
