// Harnesses may use the standalone client or supply their own scoped adapters

export { toolCatalog } from "./integration/cli";
export { ToolClient, toolRequestSchema } from "./integration/client";
export type { RemoteHandlers } from "./remote/remote";
export { remoteDefinitions } from "./remote/remote";
export type {
  SkylightChannel,
  SkylightRuntime,
  SkylightTarget,
} from "./skylight/runtime/runtime";
