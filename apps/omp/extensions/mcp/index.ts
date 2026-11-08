import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function mcp(api: ExtensionAPI) {
  const parameters = api.arktype({
    action: "'status' | 'start' | 'stop' | 'restart'",
    "server?": api
      .arktype("string")
      .describe("Configured server name, required except for listing status"),
    "+": "reject",
  });

  api.registerTool({
    name: "mcp",
    label: "MCP",
    loadMode: "essential",
    description:
      "Manage configured MCP servers. status lists server state and startup/shutdown policies without starting servers. Explicitly start manual servers before using their native tools, then stop them when done. start and restart wait for the actual tools/list handshake and refresh the native tool catalog. Accepted lifecycle changes finish even if the call is cancelled. Servers with shutdown agent_end also stop when the assistant finishes.",
    parameters,
    approval: (args) =>
      args !== null &&
      typeof args === "object" &&
      "action" in args &&
      args.action === "status"
        ? "read"
        : "exec",
    async execute(_toolCallId, { action, server }, signal, _onUpdate, context) {
      const manager = context.mcpManager;
      if (!manager) throw new Error("MCP is disabled for this session");
      signal?.throwIfAborted();
      if (action !== "status") {
        if (!server) throw new Error(`mcp ${action} requires a server name`);
        // The manager owns serialized lifecycle changes and has no call signal
        // Await the actual outcome rather than hiding a completed mutation
        await manager.controlServer(server, action);
      }
      const names = server ? [server] : manager.getAllServerNames();
      const serversByName = new Map(
        names.map((name) => {
          const config = manager.getServerConfig(name);
          if (!config) throw new Error(`Unknown MCP server: ${name}`);
          return [
            name,
            {
              name,
              enabled: config.enabled !== false,
              status: manager.getConnectionStatus(name),
              startup: config.startup ?? "auto",
              shutdown: config.shutdown ?? "session",
              tools: [] as string[],
            },
          ] as const;
        }),
      );
      for (const tool of manager.getTools()) {
        if (tool.mcpServerName) {
          serversByName.get(tool.mcpServerName)?.tools.push(tool.name);
        }
      }
      const servers = [...serversByName.values()];
      return {
        content: [{ type: "text", text: JSON.stringify({ servers }) }],
        details: { servers },
      };
    },
  });
}
