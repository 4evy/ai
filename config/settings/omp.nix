{ host }:
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
  mcp.mcpServers.ghidra = (import ./ghidra/ghidra.nix { inherit host; }) // {
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
