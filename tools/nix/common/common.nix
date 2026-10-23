{ packagesFor }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.ai;
  packages = pkgs.aiTools or (packagesFor pkgs);
  yaml = pkgs.formats.yaml { };
  json = pkgs.formats.json { };
in
{
  options.programs.ai = {
    enable = lib.options.mkEnableOption "the shared AI tools and settings";
    host = lib.options.mkOption {
      type = lib.types.attrsOf lib.types.anything;
      default = { };
      description = ''
        Host context for optional integrations, such as ChatGPT resources,
        nodeRepl, codexCli, notifyClient, and lldb
      '';
    };
    overrides = lib.options.mkOption {
      type = lib.types.attrsOf lib.types.anything;
      default = { };
      description = ''
        Settings overrides keyed by the export destination path
        Nested attributes merge and lists replace the defaults
        Home Manager users can also use the upstream program options
      '';
    };
    codex = {
      enable = lib.options.mkEnableOption "the shared Codex defaults and launcher";
    };
    opencode = {
      enable = lib.options.mkEnableOption "the shared OpenCode defaults";
      cliSettings = lib.options.mkOption {
        inherit (json) type;
        default = { };
        description = "OpenCode CLI settings written to opencode/cli.json";
      };
      quotaSettings = lib.options.mkOption {
        inherit (json) type;
        default = { };
        description = "OpenCode quota plugin settings written to opencode/opencode-quota/quota-toast.json";
      };
    };
    claude = {
      enable = lib.options.mkEnableOption "the shared Claude Code defaults and launcher";
      environment = lib.options.mkOption {
        type = lib.types.addCheck (lib.types.attrsOf (lib.types.nullOr lib.types.str)) (
          variables: lib.lists.all lib.strings.isValidPosixName (builtins.attrNames variables)
        );
        default = { };
        example = {
          CLAUDE_CODE_EFFORT_LEVEL = "high";
          DISABLE_TELEMETRY = null;
        };
        description = ''
          Environment exported before Claude Code starts
          Null omits a default without removing an inherited value
          CLAUDE_CONFIG_DIR must be absolute; an empty value uses the default
          Set credentials in the launching environment, not the public Nix store
        '';
      };
    };
    omp = {
      enable = lib.options.mkEnableOption "the pinned patched OMP launcher and extensions";
      settings = lib.options.mkOption {
        inherit (yaml) type;
        default = { };
        description = "OMP agent settings";
      };
      keybindings = lib.options.mkOption {
        inherit (yaml) type;
        default = { };
        description = "OMP keybindings";
      };
      mcp = lib.options.mkOption {
        inherit (json) type;
        default = { };
        description = "OMP MCP configuration, including mcpServers and server enable lists";
      };
      mutableSettings = lib.options.mkOption {
        type = lib.types.bool;
        default = true;
        description = ''
          Merge declared settings into writable YAML files during activation
          Preserve settings added by OMP while declared values take precedence
        '';
      };
      extensions = lib.options.mkOption {
        type = lib.types.attrsOf lib.types.path;
        default = {
          compact = "${packages.ai-tools}/lib/ai-tools/apps/omp/extensions/compact";
          mcp = "${packages.ai-tools}/lib/ai-tools/apps/omp/extensions/mcp";
          remote = "${packages.ai-tools}/lib/ai-tools/apps/omp/extensions/remote";
          skylight = "${packages.ai-tools}/lib/ai-tools/apps/omp/extensions/skylight";
          thinking = "${packages.ai-tools}/lib/ai-tools/apps/omp/extensions/thinking";
        };
        description = "Extension directories installed into the OMP agent home";
      };
    };
    farstep = {
      enable = lib.options.mkEnableOption "Farstep jobs and desktop automation";
      package = lib.options.mkPackageOption packages "farstep" {
        pkgsText = "ai.packages.<system>";
      };
      desktop = {
        enable = lib.options.mkEnableOption "the Farstep desktop session service";
        environment = lib.options.mkOption {
          type = lib.types.attrsOf lib.types.str;
          default = { };
          description = "Environment passed to the desktop daemon";
        };
      };
    };
    ghidra = {
      enable = lib.options.mkEnableOption "the Ghidra MCP backend and client integration";
      package = lib.options.mkPackageOption packages "ghidra-mcp" {
        pkgsText = "ai.packages.<system>";
      };
      url = lib.options.mkOption {
        type = lib.types.str;
        default = "http://127.0.0.1:${toString cfg.ghidra.server.port}";
        defaultText = lib.options.literalExpression ''"http://127.0.0.1:''${toString config.programs.ai.ghidra.server.port}"'';
        description = "Ghidra backend HTTP URL used by the stdio MCP bridge";
      };
      server = {
        enable = lib.options.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Install a manually started persistent headless Ghidra backend user service";
        };
        port = lib.options.mkOption {
          type = lib.types.port;
          default = 8089;
          description = "Loopback port of the managed headless Ghidra backend";
        };
        environment = lib.options.mkOption {
          type = lib.types.attrsOf lib.types.str;
          default = { };
          description = "Environment passed to the headless backend, including JAVA_OPTS and initial program/project settings";
        };
        extraArgs = lib.options.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
          description = "Additional headless backend arguments, preserving spaces within each argument";
        };
      };
      bridge.environment = lib.options.mkOption {
        type = lib.types.attrsOf lib.types.str;
        default = { };
        description = "Environment passed to client bridges, including optional external debugger settings";
      };
    };
    chatgpt = {
      enable = lib.options.mkEnableOption "the ChatGPT desktop package";
      package = lib.options.mkPackageOption packages "chatgpt" {
        nullable = true;
        default = if packages ? chatgpt then "chatgpt" else null;
        pkgsText = "ai.packages.<system>";
        extraDescription = "Set to null to use a separately installed app";
      };
      patchComputerUse = lib.options.mkEnableOption "the macOS ChatGPT computer-use policy patch";
      resources = lib.options.mkOption {
        type = lib.types.str;
        default =
          if cfg.chatgpt.package != null && pkgs.stdenv.hostPlatform.isDarwin then
            "${cfg.chatgpt.package}/Applications/ChatGPT.app/Contents/Resources"
          else
            "/Applications/ChatGPT.app/Contents/Resources";
        defaultText = lib.options.literalExpression ''"''${config.programs.ai.chatgpt.package}/Applications/ChatGPT.app/Contents/Resources" or "/Applications/ChatGPT.app/Contents/Resources"'';
        description = "Resources directory of the macOS ChatGPT app";
      };
    };
  };
  config = lib.modules.mkIf cfg.enable {
    programs.ai = {
      claude.enable = lib.modules.mkDefault true;
      codex.enable = lib.modules.mkDefault true;
      opencode.enable = lib.modules.mkDefault true;
      omp.enable = lib.modules.mkDefault true;
      farstep.enable = lib.modules.mkDefault true;
      ghidra.enable = lib.modules.mkDefault true;
    };
  };
}
