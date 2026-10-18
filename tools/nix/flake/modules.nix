{
  config,
  inputs,
  lib,
  ...
}:
let
  inherit (config.flake.lib) packagesFor mkSettings;
in
{
  flake = {
    modules = {
      homeManager.default = lib.modules.importApply ../home/home.nix {
        inherit packagesFor mkSettings;
      };
      nixos.default = lib.modules.importApply ../system/system.nix {
        inherit packagesFor;
      };
      darwin.default = lib.modules.importApply ../darwin/darwin.nix {
        inherit packagesFor mkSettings;
        homeManager = inputs.home-manager;
      };
    };

    homeModules.default = config.flake.modules.homeManager.default;
    homeManagerModules.default = config.flake.homeModules.default;
    nixosModules.default = config.flake.modules.nixos.default;
    darwinModules.default = config.flake.modules.darwin.default;
  };
}
