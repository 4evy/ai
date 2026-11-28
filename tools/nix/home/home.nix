{
  packagesFor,
  mkSettings,
}:
{
  config,
  lib,
  pkgs,
  aiBundleEnabled,
  ...
}:
let
  cfg = config.programs.ai;
  packages = pkgs.aiTools or (packagesFor pkgs);
  defaults = lib.attrsets.mapAttrsRecursive (_: value: lib.modules.mkDefault value);
  codexHome =
    if config.home.preferXdgDirectories then
      "${config.xdg.configHome}/codex"
    else
      "${config.home.homeDirectory}/.codex";
  resources = cfg.host.chatgptResources or "";
  repl = pkgs.writeShellScript "ai-node-repl" ''
    exec ${lib.meta.getExe packages.bun} ${cfg.package}/lib/ai-tools/apps/chatgpt/repl/repl.js \
      ${lib.strings.escapeShellArg resources} ${lib.strings.escapeShellArg codexHome} "$@"
  '';
  settings = mkSettings {
    host = {
      os = if pkgs.stdenv.hostPlatform.isDarwin then "darwin" else "linux";
      inherit (config.home) homeDirectory;
      inherit codexHome;
      # Farstep is supplied through upstream shared MCP integration
      farstep = "";
    }
    // cfg.host
    // lib.attrsets.optionalAttrs (resources != "" && (cfg.host.nodeRepl or "") != "") {
      nodeReplWrapper = toString repl;
    };
    inherit (cfg) overrides;
  };
in
{
  imports = [
    (lib.modules.importApply ../common/common.nix { inherit packagesFor; })
    ./codex/codex.nix
    ./opencode/opencode.nix
    ./claude/claude.nix
    ./omp/omp.nix
    ./farstep/farstep.nix
    ./chatgpt/chatgpt.nix
  ];

  config = {
    # Runtime arguments stay out of imports so option-dependent values are lazy
    _module.args.aiContext = {
      inherit settings;
      # Defaults apply to leaves so a user can override one setting independently
      inherit defaults;
    };
    home.packages = lib.modules.mkIf aiBundleEnabled [ cfg.package ];
  };
}
