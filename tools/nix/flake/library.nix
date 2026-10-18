{
  inputs,
  lib,
  withSystem,
  ...
}:
let
  mkSettings = args: import ../../../config/settings/settings.nix ({ inherit lib; } // args);
in
{
  flake.lib = {
    inherit mkSettings;
    packagesFor = import ../packages/packages.nix { inherit (inputs) bun2nix; };
    mkConfigs =
      {
        system,
        host ? { },
        overrides ? { },
      }:
      withSystem system (
        { pkgs, ... }:
        pkgs.callPackage ../../../config/settings/generate/generate.nix {
          configs = mkSettings { inherit host overrides; };
        }
      );
  };
}
