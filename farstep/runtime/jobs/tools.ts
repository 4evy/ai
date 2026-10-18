import type { Lifetime } from "@ai/core/effect/effect";
import { toolRegistry as registry } from "@ai/core/mcp/server/server";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

export { guardTools, serveStdio, type ToolRegistrar } from "@ai/core/mcp/server/server";

export function toolRegistry(server: Server, lifetime: Lifetime) {
  return registry(server, lifetime, { name: "helper.handle", component: "farstep" });
}
