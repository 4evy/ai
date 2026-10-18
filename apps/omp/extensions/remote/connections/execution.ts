import type { ScriptTransport } from "farstep/client/execution/execution";
import { remoteArgv } from "./command";
import type { ExecutionTarget } from "./types";

export function scriptTransport(target: ExecutionTarget): ScriptTransport {
  return async (script, pty) =>
    target.backend === "local"
      ? { command: target.bash, args: ["--noprofile", "--norc", "-c", script] }
      : { command: "ssh", args: await remoteArgv(target, script, pty) };
}
