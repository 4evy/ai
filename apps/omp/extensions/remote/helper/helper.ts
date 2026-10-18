import { run } from "@ai/core/effect/effect";
import { helperStatusEffect as inspect } from "farstep/client/execution/status";
import { scriptTransport } from "../connections/execution";
import type { Connection } from "../connections/types";

export { type HelperStatus, helperStatusSchema } from "farstep/client/execution/status";
export const helperStatusEffect = (connection: Connection) =>
  inspect(connection.info.os, scriptTransport(connection));
export function helperStatus(connection: Connection, signal?: AbortSignal) {
  return run(helperStatusEffect(connection), signal);
}
