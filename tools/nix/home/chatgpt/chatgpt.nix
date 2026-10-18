{
  config,
  lib,
  pkgs,
  aiContext,
  ...
}:
let
  inherit (aiContext) packages settings;
  cfg = config.programs.ai.chatgpt;
  codexCli = config.programs.ai.host.codexCli or (lib.meta.getExe' packages.ai-tools "codex");
  nodeRepl = settings.".codex/config.toml".settings.mcp_servers.node_repl.command;
  codexHome = settings.".codex/config.toml".settings.mcp_servers.node_repl.env.CODEX_HOME;
  environment = pkgs.writeShellScript "ai-chatgpt-environment" ''
    set -eu
    /bin/launchctl setenv CODEX_HOME ${lib.strings.escapeShellArg codexHome}
    /bin/launchctl setenv CODEX_CLI_PATH ${lib.strings.escapeShellArg codexCli}
    /bin/launchctl setenv CODEX_NODE_REPL_PATH ${lib.strings.escapeShellArg nodeRepl}
  '';
in
{
  config = lib.modules.mkIf cfg.enable {
    assertions = [
      {
        assertion = !cfg.patchComputerUse || pkgs.stdenv.hostPlatform.isDarwin;
        message = "programs.ai.chatgpt.patchComputerUse requires macOS";
      }
    ];
    home.packages = [ packages.ai-tools ] ++ lib.lists.optional (cfg.package != null) cfg.package;
    home.sessionVariables = lib.modules.mkIf pkgs.stdenv.hostPlatform.isDarwin {
      CHATGPT_RESOURCES = cfg.resources;
      CODEX_HOME = codexHome;
      CODEX_CLI_PATH = codexCli;
      CODEX_NODE_REPL_PATH = nodeRepl;
    };
    programs.ai.host = lib.modules.mkIf pkgs.stdenv.hostPlatform.isDarwin {
      chatgptResources = lib.modules.mkDefault cfg.resources;
      nodeRepl = lib.modules.mkDefault "${cfg.resources}/cua_node/bin/node_repl";
      codexCli = lib.modules.mkDefault (lib.meta.getExe' packages.ai-tools "codex");
    };
    # Dock-launched apps inherit launchd's environment rather than shell exports
    launchd.agents.ai-chatgpt-environment = lib.modules.mkIf pkgs.stdenv.hostPlatform.isDarwin {
      enable = true;
      config = {
        ProgramArguments = [ (toString environment) ];
        RunAtLoad = true;
        ProcessType = "Background";
      };
    };
    launchd.agents.ai-chatgpt-policy =
      lib.modules.mkIf (cfg.patchComputerUse && pkgs.stdenv.hostPlatform.isDarwin)
        {
          enable = true;
          config = {
            ProgramArguments = [
              "${packages.ai-tools}/bin/ai"
              "chatgpt"
              "policy"
              "patch"
              (dirOf (dirOf cfg.resources))
            ];
            RunAtLoad = true;
            StartInterval = 300;
          };
        };
  };
}
