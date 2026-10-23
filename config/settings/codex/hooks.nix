{ lib, marketplace }:
let
  events = {
    Stop = "\${session_id}";
    Interrupt = "\${session_id}";
    SubagentStop = "\${agent_id}";
  };
  plugins =
    lib.lists.concatMap
      (
        source:
        map (name: "${name}@${source}") [
          "browser"
          "chrome"
        ]
      )
      [
        marketplace
        "dotfiles-chatgpt-bundled"
      ];
in
# Keep cleanup independent of plugin version directories removed by upgrades
lib.attrsets.mapAttrs (_: session: [
  {
    hooks = [
      {
        type = "mcp_tool";
        server = "node_repl";
        tool = "turn_ended";
        input = {
          hook_event_name = "\${hook_event_name}";
          session_id = session;
          turn_id = "\${turn_id}";
        };
      }
    ];
  }
]) events
// {
  state =
    lib.attrsets.genAttrs
      (lib.lists.concatMap (
        plugin:
        map (event: "${plugin}:plugin.json#hooks[0]:${event}:0:0") [
          "stop"
          "interrupt"
          "subagent_stop"
        ]
      ) plugins)
      (_: {
        enabled = false;
      });
}
