import type { ToolResult } from "@ai/core/tool/tool";
import type { SkyBackend } from "#farstep/protocol/sky/execution";

export { MAX_SYNC_BYTES, PROVISION_TIMEOUT_MS } from "#farstep/protocol/sky/limits";

export interface SkylightTarget {
  target?: string | undefined;
  cwd?: string | undefined;
}

export interface SkylightChannel {
  identity: { platform: string; skyBackend?: SkyBackend | undefined };
  call(
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<ToolResult>;
}

// The adapter chooses transport and provisioning; the core owns the tool behavior
export interface SkylightRuntime {
  withChannel<T>(
    target: SkylightTarget,
    work: (channel: SkylightChannel) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  execute(
    target: SkylightTarget,
    code: string | undefined,
    reset: boolean | undefined,
    options: { title?: string; timeout_ms?: number },
    signal?: AbortSignal,
  ): Promise<ToolResult>;
  sync(
    from: SkylightTarget & { path: string },
    to: SkylightTarget & { path: string },
    expectedSha256: string | null,
    signal?: AbortSignal,
  ): Promise<ToolResult>;
  close(): Promise<void>;
}
