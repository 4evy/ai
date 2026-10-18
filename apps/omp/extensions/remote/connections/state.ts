import { attempt, run } from "@ai/core/effect/effect";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  buildRemoteCommand,
  supportsSshControlMaster,
} from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import { ptree } from "@oh-my-pi/pi-utils";
import { Effect } from "effect";
import { localTarget } from "farstep/client/execution/local";
import { REMOTE_TOOLS } from "farstep/remote/tools/names";
import * as v from "valibot";
import { helperStatusSchema } from "../helper/helper";
import type { Connection, ConnectionState, ExecutionTarget } from "./types";

const CONNECTIONS_ENTRY = "remote-connections";
const connectionSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  target: v.object({
    name: v.pipe(v.string(), v.minLength(1)),
    host: v.pipe(v.string(), v.minLength(1)),
    username: v.exactOptional(v.string()),
    port: v.exactOptional(
      v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(65535)),
    ),
    keyPath: v.exactOptional(v.string()),
    compat: v.exactOptional(v.boolean()),
  }),
  info: v.object({
    version: v.pipe(v.number(), v.safeInteger()),
    os: v.picklist(["windows", "linux", "macos", "unknown"]),
    shell: v.picklist(["cmd", "powershell", "bash", "zsh", "sh", "unknown"]),
    transferShell: v.exactOptional(v.picklist(["sh", "bash", "zsh"])),
    compatShell: v.exactOptional(v.picklist(["bash", "sh"])),
    compatEnabled: v.boolean(),
  }),
  home: v.pipe(v.string(), v.minLength(1)),
  cwd: v.pipe(v.string(), v.minLength(1)),
  bash: v.pipe(v.string(), v.minLength(1)),
  zsh: v.optional(v.pipe(v.string(), v.minLength(1))),
  timeout: v.optional(v.string()),
  arch: v.string(),
  fileRoot: v.string(),
  helper: v.optional(helperStatusSchema),
});
const connectionsSchema = v.array(connectionSchema);

export function createConnections(api: ExtensionAPI) {
  const connections = new Map<string, Connection>();

  function selected(id: string): Connection {
    const connection = connections.get(id);
    if (!connection) {
      throw new Error(`Unknown connection '${id}'; use ${REMOTE_TOOLS.connect} first`);
    }
    return connection;
  }

  async function execution(id: string, cwd: string): Promise<ExecutionTarget> {
    return id === "local" ? localTarget(cwd) : selected(id);
  }

  const restore = (ctx: ExtensionContext) => {
    connections.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== CONNECTIONS_ENTRY) continue;
      const parsed = v.safeParse(connectionsSchema, entry.data);
      if (!parsed.success) continue;
      connections.clear();
      for (const connection of parsed.output) {
        if (connection.id !== "local") connections.set(connection.id, connection);
      }
    }
  };
  function save(connection: Connection) {
    if (connection.id === "local")
      throw new Error("Connection id 'local' is reserved for local execution");
    connections.set(connection.id, connection);
    api.appendEntry(CONNECTIONS_ENTRY, [...connections.values()]);
  }
  return { connections, selected, execution, save, restore };
}
export type Connections = ReturnType<typeof createConnections>;

const connectionStateEffect = Effect.fnUntraced(function* (
  connection: Connection,
): Effect.fn.Return<ConnectionState, unknown> {
  if (!supportsSshControlMaster()) return { active: false };
  const args = yield* attempt(() => buildRemoteCommand(connection.target, ""), {
    awaitOnInterrupt: true,
  });
  const result = yield* attempt(
    (signal) =>
      ptree.exec(["ssh", "-O", "check", ...args.slice(0, -1)], {
        timeout: 10_000,
        signal,
        allowNonZero: true,
        allowAbort: true,
      }),
    { awaitOnInterrupt: true },
  );
  const match = /Master running \(pid=(\d+)\)/u.exec(result.stderr);
  return {
    controlPath: args
      .find((argument) => argument.startsWith("ControlPath="))
      ?.slice("ControlPath=".length),
    active: result.ok && result.exitCode === 0,
    ...(match ? { masterPid: Number(match[1]) } : {}),
  };
});

export function connectionState(
  connection: Connection,
  signal?: AbortSignal,
): Promise<ConnectionState> {
  return run(connectionStateEffect(connection), signal);
}
