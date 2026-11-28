{ packagesFor }:
{
  config,
  lib,
  aiBundleEnabled,
  ...
}:
let
  cfg = config.programs.ai;
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
        Import the Home Manager module for each user's settings
      '';
    };
  };
  config = {
    programs.ai.packages = lib.modules.mkMerge [
      (selectedPackage aiBundleEnabled cfg.package)
      (selectedPackage cfg.farstep.enable cfg.farstep.package)
      (selectedPackage (cfg.chatgpt.enable && cfg.chatgpt.package != null) cfg.chatgpt.package)
    ];
    environment.systemPackages = cfg.packages;
  };
}
