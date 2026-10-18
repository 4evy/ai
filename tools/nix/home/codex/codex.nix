{
  config,
  lib,
  aiContext,
  ...
}:
let
  inherit (aiContext) settings defaults;
  cfg = config.programs.ai;
  sharedProfiles =
    rule:
    if config.programs.mcp.enable then
      lib.attrsets.mapAttrs (_: _: rule) config.programs.mcp.servers
    else
      { };
in
{
  config = lib.modules.mkIf cfg.codex.enable {
    # Upstream owns writable settings, profiles, skills, rules, and plugins
    programs.codex = {
      enable = true;
      package = lib.modules.mkDefault null;
      mutableSettings = lib.modules.mkDefault true;
      enableMcpIntegration = lib.modules.mkDefault true;
      settings = defaults settings.".codex/config.toml".settings;
      profiles = {
        safe = defaults (
          lib.attrsets.recursiveUpdate settings.".codex/safe.config.toml".settings {
            mcp_servers = sharedProfiles { default_tools_approval_mode = "prompt"; };
          }
        );
        review = defaults (
          lib.attrsets.recursiveUpdate settings.".codex/review.config.toml".settings {
            mcp_servers = sharedProfiles { enabled = false; };
          }
        );
      };
    };
  };
}
