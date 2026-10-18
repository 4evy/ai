{ homeManager }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  hmLib = import (homeManager + "/modules/lib/stdlib-extended.nix") lib;
  inherit
    (
      (import (homeManager + "/modules/lib/file-type.nix") {
        lib = hmLib;
        inherit pkgs;
        inherit (config.home) homeDirectory;
      })
    )
    fileType
    ;
in
{
  # Only the output contracts needed by the borrowed program modules
  # No Home Manager system integration or activation package is imported
  options = {
    home = {
      homeDirectory = lib.options.mkOption {
        type = lib.types.str;
        internal = true;
      };
      preferXdgDirectories = lib.options.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Use XDG config directories for supported AI tools";
      };
      profileDirectory = lib.options.mkOption {
        type = lib.types.str;
        default = "/run/current-system/sw";
        internal = true;
      };
      packages = lib.options.mkOption {
        type = lib.types.listOf lib.types.package;
        default = [ ];
        internal = true;
      };
      sessionVariables = lib.options.mkOption {
        type = lib.types.attrsOf lib.types.str;
        default = { };
        internal = true;
      };
      file = lib.options.mkOption {
        type = fileType "home.file" "the primary user's home" config.home.homeDirectory;
        default = { };
        internal = true;
        # Codex emits home-relative XDG file names with a leading slash
        apply = lib.attrsets.mapAttrs (
          _: entry:
          entry
          // {
            target =
              if
                config.home.preferXdgDirectories
                && lib.strings.hasPrefix "${lib.strings.removePrefix config.home.homeDirectory config.xdg.configHome}/codex/" entry.target
              then
                lib.strings.removePrefix "/" entry.target
              else
                entry.target;
          }
        );
      };
      activation = lib.options.mkOption {
        type = hmLib.hm.types.dagOf lib.types.lines;
        default = { };
        internal = true;
      };
    };
    xdg = {
      configHome = lib.options.mkOption {
        type = lib.types.str;
        default = "${config.home.homeDirectory}/.config";
        description = "Config home used by the borrowed AI program modules";
      };
      configFile = lib.options.mkOption {
        type = fileType "xdg.configFile" "the config home" config.xdg.configHome;
        default = { };
        internal = true;
      };
    };
  };
  config = {
    home.file = lib.attrsets.mapAttrs' (
      _: file: lib.attrsets.nameValuePair file.target file
    ) config.xdg.configFile;
  };
}
