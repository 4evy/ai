{
  inputs,
  lib,
  withSystem,
  ...
}:
let
  mkSettings = args: import ../../../config/settings/settings.nix ({ inherit lib; } // args);
  rustVersion = (lib.importTOML ../../../Cargo.toml).workspace.package.rust-version;
  rustFor = pkgs: (pkgs.extend inputs.rust-overlay.overlays.default).rust-bin.stable.${rustVersion};
in
{
  flake.lib = {
    inherit mkSettings rustFor;
    packagesFor = import ../packages/packages.nix {
      inherit (inputs) bun2nix crane;
      inherit rustFor;
    };
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
