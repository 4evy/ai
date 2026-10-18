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
