{
  config,
  lib,
  pkgs,
  aiContext,
  ...
}:
let
  inherit (aiContext) settings defaults;
  cfg = config.programs.ai;
  opencodeServers = lib.attrsets.mapAttrs (
    _: server:
    let
      remote = server.url != null;
      enabled = lib.hm.mcp.resolveEnabled server;
    in
    {
      type = if remote then "remote" else "local";
    }
    // lib.attrsets.optionalAttrs (enabled != null) {
      disabled = !enabled;
    }
    // (
      if remote then
        {
          inherit (server) url;
        }
        // lib.attrsets.optionalAttrs (server.headers != { }) { inherit (server) headers; }
      else
        {
          command = [ server.command ] ++ server.args;
        }
        // lib.attrsets.optionalAttrs (server.env != { }) {
          environment = lib.hm.mcp.renderEnv (path: "{file:${path}}") server.env;
        }
    )
  ) (if config.programs.mcp.enable then config.programs.mcp.servers else { });
in
{
  config = lib.modules.mkIf cfg.opencode.enable {
    programs.ai.opencode = {
      cliSettings = defaults settings.".config/opencode/cli.json".settings;
      quotaSettings = defaults settings.".config/opencode/opencode-quota/quota-toast.json".settings;
    };
    programs.opencode = {
      enable = true;
      package = lib.modules.mkDefault null;
      # Upstream currently renders the older flat MCP table
      enableMcpIntegration = lib.modules.mkDefault false;
      settings = defaults (
        lib.attrsets.recursiveUpdate settings.".config/opencode/opencode.json".settings {
          mcp.servers = opencodeServers;
        }
      );
    };
    xdg.configFile."opencode/cli.json".source =
      (pkgs.formats.json { }).generate "cli.json"
        cfg.opencode.cliSettings;
    xdg.configFile."opencode/opencode-quota/quota-toast.json".source =
      (pkgs.formats.json { }).generate "quota-toast.json"
        cfg.opencode.quotaSettings;
  };
}
