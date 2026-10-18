{
  config,
  lib,
  pkgs,
  aiFormatters,
  ...
}:
let
  inherit (aiFormatters) ai-javascript bun powershell-analyzer;
  adapter =
    kind: executable:
    pkgs.writeShellApplication {
      name = "format-${kind}";
      text = ''
        exec ${lib.getExe bun} ${ai-javascript}/tools/scripts/format/format.js \
          ${lib.escapeShellArg kind} ${lib.escapeShellArg executable} "$@"
      '';
    };
  shell = adapter "shell" (lib.getExe pkgs.shfmt);
  xml = adapter "xml" (lib.getExe' pkgs.libxml2 "xmllint");
  text = adapter "text" "-";
  powershell = pkgs.callPackage ./powershell.nix {
    analyzer = powershell-analyzer;
  };
in
{
  projectRootFile = "flake.nix";
  programs = {
    nixfmt.enable = true;
    deadnix.enable = true;
    just.enable = true;
    biome.enable = true;
    rustfmt = {
      enable = true;
      package = pkgs.rustfmt.override { asNightly = true; };
    };
    rumdl-format.enable = true;
    taplo.enable = true;
    clang-format.enable = true;
    google-java-format.enable = true;
    cmake-format.enable = true;
    qmlformat.enable = true;
    yamlfmt.enable = true;
  };
  settings = {
    # Include nonignored untracked sources without traversing dependency trees
    walk = "git";
    on-unmatched = "fatal";
    excludes = [
      "AGENTS.md"
      ".DS_Store"
      ".git/*"
      ".jj/*"
      ".generated/*"
      ".rumdl_cache/*"
      "node_modules/*"
      "*/node_modules/*"
      "target/*"
      "*/target/*"
      "dist/*"
      "*/dist/*"
      "build/*"
      "*/build/*"
      "tmp/*"
      "*/tmp/*"
      "Sources/*"
      "*/Sources/*"
      "result"
      "result/*"
      "bun.nix"
      "*.lockb"
      "*.lock.json"
      "*.lock.yaml"
      "*.lock.yml"
      "npm-shrinkwrap.json"
      "pnpm-lock.yaml"
      "pnpm-lock.yml"
      "farstep/sky/upstream/*"
      "farstep/sky/package.json"
      "apps/omp/runtime/upstream/*"
      "apps/omp/runtime/npm/*"
    ];
    formatter = {
      # Use the repository's existing Biome config, not treefmt's generated one
      biome.options = lib.mkForce [
        "check"
        "--write"
        "--no-errors-on-unmatched"
        "--config-path"
        "."
      ];
      rumdl-format.options = lib.mkForce [
        "fmt"
        "--config"
        "MD013.line-length = 80"
        "--config"
        "MD013.reflow = true"
        "--no-code-block-tools"
      ];
      shell = {
        command = shell;
        includes = [
          "*.sh"
          "*.bash"
          "apps/omp/omp"
          "farstep/farstep"
        ];
      };
      powershell = {
        command = powershell;
        includes = [
          "*.ps1"
          "*.psm1"
          "*.psd1"
        ];
      };
      xml = {
        command = xml;
        includes = [
          "*.xml"
          "*.wxs"
          "*.plist"
        ];
      };
      sql = {
        command = pkgs.writeShellApplication {
          name = "format-sql";
          text = ''
            for file in "$@"; do
              ${lib.getExe pkgs.sql-formatter} --fix --language sqlite "$file"
            done
          '';
        };
        includes = [ "*.sql" ];
      };
      text = {
        command = text;
        # These formats need token-preserving normalization, not a foreign parser
        includes = [
          "*.zsh"
          "*.cmd"
          "*.in"
          "*.txt"
          "*.patch"
        ];
        excludes = [ "CMakeLists.txt" ];
        priority = 100;
      };
    };
  };
  # Keep VCS walking independent of globally installed command-line tools
  build.wrapper = pkgs.writeShellApplication {
    name = "treefmt";
    runtimeInputs = [ pkgs.gitMinimal ];
    text = ''
      unset PRJ_ROOT
      exec ${lib.getExe config.package} \
        --config-file=${config.build.configFile} \
        --tree-root-file=flake.nix "$@"
    '';
  };
}
