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
  # Match option-default priority so an explicit package list still replaces it
  selectedPackage =
    enable: package: lib.modules.mkIf enable (lib.modules.mkOptionDefault [ package ]);
in
{
  imports = [ (lib.modules.importApply ../common/common.nix { inherit packagesFor; }) ];
  options.programs.ai = {
    packages = lib.options.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ ];
      defaultText = lib.options.literalExpression ''
        Packages selected by programs.ai.enable and the individual tool switches
      '';
      description = ''
        AI packages installed for all users
        On nix-darwin, enable programs.ai.user.enable for native user settings
        On NixOS, import the Home Manager module for each user's settings
      '';
    };
  };
  config = {
    programs.ai.packages = lib.modules.mkMerge (
      [
        (selectedPackage (
          cfg.enable || cfg.codex.enable || cfg.claude.enable || cfg.opencode.enable || cfg.omp.enable
        ) packages.ai-tools)
      ]
      ++ map (name: selectedPackage cfg.${name}.enable cfg.${name}.package) [
        "farstep"
        "ghidra"
      ]
      ++ [
        (selectedPackage (cfg.chatgpt.enable && cfg.chatgpt.package != null) cfg.chatgpt.package)
      ]
    );
    environment.systemPackages = cfg.packages;
  };
}
