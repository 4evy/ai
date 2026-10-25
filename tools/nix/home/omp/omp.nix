{
  config,
  lib,
  pkgs,
  aiContext,
  ...
}:
let
  inherit (aiContext) packages settings defaults;
  cfg = config.programs.ai.omp;
  yaml = pkgs.formats.yaml { };
  json = pkgs.formats.json { };
  files = {
    ".omp/agent/config.yml" = {
      format = "yaml";
      source = yaml.generate "omp-config.yml" cfg.settings;
    };
    ".omp/agent/keybindings.yml" = {
      format = "yaml";
      source = yaml.generate "omp-keybindings.yml" cfg.keybindings;
    };
    ".omp/agent/mcp.json" = {
      format = "json";
      source = json.generate "omp-mcp.json" cfg.mcp;
    };
  };
in
{
  config = lib.modules.mkIf cfg.enable {
    programs.ai.omp = {
      settings = defaults settings.".omp/agent/config.yml".settings;
      keybindings = defaults settings.".omp/agent/keybindings.yml".settings;
      mcp = defaults settings.".omp/agent/mcp.json".settings;
    };
    home = {
      activation.ompSettings = lib.modules.mkIf cfg.mutableSettings (
        lib.hm.dag.entryAfter [ "linkGeneration" ] (
          lib.strings.concatMapAttrsStringSep "\n" (
            path: entry:
            lib.hm.generators.mkImpureConfigMerger {
              inherit pkgs;
              inherit (entry) format;
              staticSettings = entry.source;
              path = "${config.home.homeDirectory}/${path}";
              empty = "{}";
              jqOperation = "$dynamic * $static";
              mode = "600";
            }
          ) files
        )
      );
      file =
        lib.attrsets.mapAttrs (
          _: entry: lib.modules.mkIf (!cfg.mutableSettings) { inherit (entry) source; }
        ) files
        // {
          ".omp/agent/lib".source = "${packages.ai-tools}/lib/ai-tools/apps/omp/lib";
          ".omp/agent/commands/commit.md".source =
            "${packages.ai-tools}/lib/ai-tools/apps/omp/commands/commit.md";
          ".omp/agent/commands/rebase.md".source =
            "${packages.ai-tools}/lib/ai-tools/apps/omp/commands/rebase.md";
        }
        // lib.attrsets.mapAttrs' (
          name: source:
          lib.attrsets.nameValuePair ".omp/agent/extensions/${name}" {
            inherit source;
          }
        ) cfg.extensions;
    };
  };
}
