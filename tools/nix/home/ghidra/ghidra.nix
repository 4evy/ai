{
  config,
  lib,
  pkgs,
  aiContext,
  ...
}:
let
  inherit (aiContext) packages;
  cfg = config.programs.ai.ghidra;
  command = lib.meta.getExe packages.ai-tools;
  environment = cfg.server.environment // {
    GHIDRA_MCP_PACKAGE = toString cfg.package;
    GHIDRA_MCP_PORT = toString cfg.server.port;
  };
in
{
  config = lib.modules.mkIf cfg.enable {
    home.packages = [
      cfg.package
      packages.ai-tools
    ];
    programs.mcp = {
      enable = lib.modules.mkDefault true;
      servers.ghidra = {
        command = lib.modules.mkDefault command;
        args = lib.modules.mkDefault [
          "ghidra"
          "mcp"
          "bridge"
        ];
        env = lib.modules.mkDefault (
          {
            GHIDRA_MCP_URL = cfg.url;
            GHIDRA_MCP_PACKAGE = toString cfg.package;
          }
          // cfg.bridge.environment
        );
      };
    };
    systemd.user.services.ghidra-mcp =
      lib.modules.mkIf (cfg.server.enable && pkgs.stdenv.hostPlatform.isLinux)
        {
          Unit.Description = "Ghidra MCP headless backend";
          Service = {
            ExecStart = lib.hm.strings.escapeSystemdExecArgs (
              [
                command
                "ghidra"
                "mcp"
                "httpd"
              ]
              ++ cfg.server.extraArgs
            );
            Environment = lib.attrsets.mapAttrsToList (
              name: value: lib.strings.replaceStrings [ "%" ] [ "%%" ] (builtins.toJSON "${name}=${value}")
            ) environment;
            UMask = "0077";
            Restart = "on-failure";
            RestartSec = 5;
          };
          Install.WantedBy = [ "default.target" ];
        };
    launchd.agents.ghidra-mcp =
      lib.modules.mkIf (cfg.server.enable && pkgs.stdenv.hostPlatform.isDarwin)
        {
          enable = true;
          config = {
            ProgramArguments = [
              command
              "ghidra"
              "mcp"
              "httpd"
            ]
            ++ cfg.server.extraArgs;
            EnvironmentVariables = environment;
            RunAtLoad = true;
            KeepAlive = true;
            ThrottleInterval = 5;
            Umask = 63;
          };
        };
  };
}
