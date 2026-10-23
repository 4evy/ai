{
  packagesFor,
  mkSettings,
}:
{
  config,
  lib,
  pkgs,
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
    exec ${lib.meta.getExe packages.bun} ${packages.ai-tools}/lib/ai-tools/apps/chatgpt/repl/repl.js \
      ${lib.strings.escapeShellArg resources} ${lib.strings.escapeShellArg codexHome} "$@"
  '';
  settings = mkSettings {
    host = {
      os = if pkgs.stdenv.hostPlatform.isDarwin then "darwin" else "linux";
      inherit (config.home) homeDirectory;
      inherit codexHome;
      # Farstep is supplied through upstream shared MCP integration
      farstep = "";
      ghidraBridge = lib.meta.getExe packages.ai-tools;
      ghidraArgs = [
        "ghidra"
        "mcp"
        "bridge"
      ];
      ghidraOmpArgs =
        cfg.host.ghidraArgs or (
          if cfg.host ? ghidraBridge then
            [ ]
          else
            [
              "ghidra"
              "mcp"
              "headless"
            ]
        );
      ghidraOmpEnvironment = cfg.ghidra.server.environment // {
        GHIDRA_MCP_PORT = toString cfg.ghidra.server.port;
      };
      ghidraUrl = cfg.ghidra.url;
      ghidraEnabled = cfg.ghidra.enable;
      ghidraEnvironment = cfg.ghidra.bridge.environment // {
        GHIDRA_MCP_PACKAGE = toString cfg.ghidra.package;
      };
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
    ./ghidra/ghidra.nix
    ./chatgpt/chatgpt.nix
  ];

  config = lib.modules.mkMerge [
    {
      # Runtime arguments stay out of imports so option-dependent values are lazy
      _module.args.aiContext = {
        inherit packages settings;
        # Defaults apply to leaves so a user can override one setting independently
        inherit defaults;
      };
    }
    (lib.modules.mkIf
      (cfg.enable || cfg.codex.enable || cfg.claude.enable || cfg.opencode.enable || cfg.omp.enable)
      {
        home.packages = [ packages.ai-tools ];
      }
    )
  ];
}
