{
  lib,
  host ? { },
  overrides ? { },
}:
let
  claude = import ./claude/claude.nix;
  codex = import ./codex/codex.nix { inherit lib host; };
  omp = import ./omp.nix { inherit host; };
  opencode = import ./opencode.nix { inherit lib host; };
  file = format: settings: {
    inherit format settings;
    private = true;
  };
  defaults = {
    ".claude/settings.json" = file "json" claude;
    ".codex/config.toml" = file "toml" codex.config;
    ".codex/safe.config.toml" = file "toml" codex.safe;
    ".codex/review.config.toml" = file "toml" codex.review;
    ".omp/agent/config.yml" = file "yaml" omp.config;
    ".omp/agent/mcp.json" = file "json" omp.mcp;
    ".omp/agent/keybindings.yml" = file "yaml" omp.keybindings;
    ".config/opencode/opencode.json" = file "json" opencode.config;
    ".config/opencode/cli.json" = file "json" opencode.cli;
    ".config/opencode/opencode-quota/quota-toast.json" = file "json" opencode.quota;
  };
in
# Overrides contain settings keyed by destination path, with lists replaced
lib.attrsets.mapAttrs (
  path: entry:
  entry
  // {
    settings = lib.attrsets.recursiveUpdate entry.settings (overrides.${path} or { });
  }
) defaults
