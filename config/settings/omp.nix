{ host }:
let
  ghidra = import ./ghidra/ghidra.nix { inherit host; };
  ghidraEnvironment = (host.ghidraOmpEnvironment or { }) // ghidra.env;
  ghidraPort = ghidraEnvironment.GHIDRA_MCP_PORT or "8089";
  localGhidra = builtins.elem ghidraEnvironment.GHIDRA_MCP_URL [
    "http://127.0.0.1:${ghidraPort}"
    "http://127.0.0.1:${ghidraPort}/"
    "http://localhost:${ghidraPort}"
    "http://localhost:${ghidraPort}/"
  ];
in
{
  config = {
    modelRoles = {
      default = "openai-codex/gpt-6.1-sol";
      web = "openai-codex/gpt-6.1-sol";
    };
    retry = {
      fallbackChains = {
        web = [ ];
      };
    };
    defaultThinkingLevel = "high";
    hideThinkingBlock = false;
    # Keep weekly quota and saved-reset expiry visible, with detailed token usage
    # available in /stats rather than the persistent footer
    statusLine = {
      preset = "custom";
      separator = "pipe";
      transparent = true;
      sessionAccent = false;
      compactThinkingLevel = false;
      leftSegments = [
        "vim"
        "model"
        "mode"
        "path"
      ];
      rightSegments = [
        "usage"
        "context_pct"
        "cost"
      ];
      segmentOptions.path = {
        stripWorkPrefix = true;
        maxLength = 24;
      };
    };
  };
  mcp.mcpServers.ghidra = ghidra // {
    args =
      host.ghidraOmpArgs or (host.ghidraArgs or (
        if host ? ghidraBridge then
          [ ]
        else
          [
            "ghidra"
            "mcp"
            "headless"
          ]
      )
      );
    env = {
      GHIDRA_MCP_START_HTTPD = if localGhidra then "1" else "0";
    }
    // ghidraEnvironment;
    startup = "manual";
    shutdown = "agent_end";
    timeout = 1800000;
  };
  keybindings = {
    "app.editor.external" = [
      "ctrl+x"
      "super+x"
      "ctrl+g"
    ];
    "app.message.followUp" = [
      "ctrl+shift+enter"
    ];
  };
}
