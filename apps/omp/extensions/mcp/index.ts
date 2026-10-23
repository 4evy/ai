import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function mcp(api: ExtensionAPI) {
  const parameters = api.arktype({
    action: "'status' | 'start' | 'stop' | 'restart'",
    "server?": api
      .arktype("string")
      .describe("Configured server name, required except for listing status"),
    "+": "reject",
  });

  api.on("session_start", (_event, ctx) => {
    if (!ctx.mcpManager) return;
    api.registerTool({
      name: "mcp",
      label: "MCP",
      loadMode: "essential",
      description:
        "Manage configured MCP servers. status lists server state and startup/shutdown policies. Explicitly start manual servers before using their native tools, then stop them when done. start and restart wait for the actual tools/list handshake and refresh the native tool catalog. Servers with shutdown agent_end also stop when the assistant finishes. No server starts merely by checking status.",
      parameters,
      async execute(_toolCallId, { action, server }, signal, _onUpdate, context) {
        const manager = context.mcpManager;
        if (!manager) throw new Error("MCP is disabled for this session");
        signal?.throwIfAborted();
        if (action !== "status") {
          if (!server) throw new Error(`mcp ${action} requires a server name`);
          await manager.controlServer(server, action);
          signal?.throwIfAborted();
        }
        const names = server ? [server] : manager.getAllServerNames();
        const tools = manager.getTools();
        const servers = names.map((name) => {
          const config = manager.getServerConfig(name);
          if (!config) throw new Error(`Unknown MCP server: ${name}`);
          return {
            name,
            status: manager.getConnectionStatus(name),
            startup: config.startup ?? "auto",
            shutdown: config.shutdown ?? "session",
            tools: tools
              .filter((tool) => tool.mcpServerName === name)
              .map((tool) => tool.name),
          };
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ servers }) }],
          details: { servers },
        };
      },
    });
  });
}
