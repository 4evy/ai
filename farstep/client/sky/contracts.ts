import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as v from "valibot";
import { skyBackendSchema } from "../../protocol/sky/execution";

export const identitySchema = v.object({
  protocolMajor: v.literal(1),
  installationId: v.string(),
  platform: v.picklist(["linux", "darwin", "win32"]),
  arch: v.string(),
  cwd: v.string(),
  skyVersion: v.string(),
  skyBackend: v.optional(skyBackendSchema),
  capabilities: v.array(v.string()),
});
export const fileSchema = v.strictObject({
  data: v.string(),
  sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  size: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

export interface SkyTarget {
  // OpenSSH aliases retain their configured ports, identities and jump hosts
  target?: string | undefined;
  cwd?: string | undefined;
}

export interface SkyChannel {
  identity: v.InferOutput<typeof identitySchema>;
  call(
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    timeout?: number,
  ): Promise<CallToolResult>;
  prepare(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
  isClosed(): boolean;
}

export type FleetOptions = { localCommand?: string; remoteCommand?: string };
