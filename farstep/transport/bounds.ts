export { BoundedFrames } from "@ai/runtime/stream/frames";

import { MAX_REQUEST_BYTES } from "../protocol/desktop/desktop";

export function boundRequest(name: string, args: Record<string, unknown>): void {
  // Reserve space for the JSON-RPC envelope and generated request identifier
  if (
    Buffer.byteLength(JSON.stringify({ name, arguments: args })) >
    MAX_REQUEST_BYTES - 1024
  ) {
    throw new Error("Helper request exceeds 1 MiB limit");
  }
}
