{
  config,
  lib,
  pkgs,
  aiContext,
  ...
}:
let
  inherit (aiContext) defaults;
  cfg = config.programs.ai.farstep;
  servers = import ../../../../config/settings/farstep/farstep.nix;
  codexServer =
    name: timeout:
    lib.modules.mkMerge [
      (lib.attrsets.mapAttrs (_: value: lib.modules.mkOptionDefault value) {
        startup_timeout_sec = 30;
        tool_timeout_sec = timeout;
        default_tools_approval_mode = "approve";
      })
      (defaults (
        lib.hm.mcp.transformMcpServer {
          server = config.programs.mcp.servers.${name};
          exclude = [
            "headers"
            "type"
          ];
          extraTransforms = [
            (s: s // lib.attrsets.optionalAttrs (s.headers or { } != { }) { http_headers = s.headers; })
            (lib.hm.mcp.wrapEnvFilesCommand { inherit pkgs name; })
          ];
        }
      ))
    ];
in
{
  config = lib.modules.mkIf cfg.enable {
    home.packages = [ cfg.package ];
    programs = {
      mcp = {
        enable = lib.modules.mkDefault true;
        servers = lib.attrsets.mapAttrs (
          _: server:
          defaults {
            command = lib.meta.getExe cfg.package;
            args = [
              server.subcommand
              "connect"
            ];
          }
        ) servers;
      };
      codex.settings.mcp_servers = lib.modules.mkIf (
        config.programs.ai.codex.enable && config.programs.mcp.enable
      ) (lib.attrsets.mapAttrs (name: server: codexServer name server.timeout) servers);
      opencode.settings.mcp.servers =
        lib.modules.mkIf (config.programs.ai.opencode.enable && config.programs.mcp.enable)
          (
            lib.attrsets.mapAttrs (_: server: {
              timeout = defaults {
                catalog = server.timeout * 1000;
                execution = server.timeout * 1000;
              };
            }) servers
          );
    };
    systemd.user.services.farstep-desktop =
      lib.modules.mkIf (cfg.desktop.enable && pkgs.stdenv.hostPlatform.isLinux)
        {
          Unit = {
            Description = "Farstep desktop service";
            After = [ "graphical-session.target" ];
            PartOf = [ "graphical-session.target" ];
          };
          Service = {
            ExecStart = "${lib.meta.getExe' cfg.package "farstep-desktop"} daemon";
            Environment = lib.attrsets.mapAttrsToList (
              name: value: lib.strings.replaceStrings [ "%" ] [ "%%" ] (builtins.toJSON "${name}=${value}")
            ) cfg.desktop.environment;
            UMask = "0077";
            Restart = "on-failure";
            RestartSec = 2;
          };
          Install.WantedBy = [ "graphical-session.target" ];
        };
    launchd.agents.farstep-desktop =
      lib.modules.mkIf (cfg.desktop.enable && pkgs.stdenv.hostPlatform.isDarwin)
        {
          enable = true;
          config = {
            ProgramArguments = [
              "${cfg.package}/share/Farstep.app/Contents/MacOS/Farstep"
              "daemon"
            ];
            EnvironmentVariables = cfg.desktop.environment // {
              FARSTEP_PACKAGE_PATH = "${cfg.package}";
            };
            RunAtLoad = true;
            KeepAlive = true;
            Umask = 63;
          };
        };
  };
}
