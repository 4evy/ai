{
  config,
  lib,
  aiContext,
  ...
}:
let
  inherit (aiContext) settings defaults;
  cfg = config.programs.ai.claude;
  environment = lib.attrsets.filterAttrs (_: value: value != null) cfg.environment;
  configDir =
    if (environment.CLAUDE_CONFIG_DIR or "") != "" then
      environment.CLAUDE_CONFIG_DIR
    else if config.home.preferXdgDirectories then
      "${config.xdg.configHome}/claude"
    else
      "${config.home.homeDirectory}/.claude";
in
{
  config = lib.modules.mkIf cfg.enable {
    assertions = [
      {
        assertion = lib.strings.hasPrefix "/" config.programs.claude-code.configDir;
        message = "Claude Code configDir must be an absolute path";
      }
    ];
    programs.ai.claude.environment = defaults settings.".claude/settings.json".settings.env;
    programs.claude-code = {
      enable = true;
      package = lib.modules.mkDefault null;
      configDir = lib.modules.mkDefault configDir;
      mutableSettings = lib.modules.mkDefault true;
      enableMcpIntegration = lib.modules.mkDefault true;
      settings = defaults (removeAttrs settings.".claude/settings.json".settings [ "env" ]);
    };
    home.sessionVariables =
      environment
      //
        lib.attrsets.optionalAttrs
          (config.programs.claude-code.configDir != "${config.home.homeDirectory}/.claude")
          {
            CLAUDE_CONFIG_DIR = config.programs.claude-code.configDir;
          };
  };
}
