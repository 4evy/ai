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
  perSystem =
    {
      config,
      pkgs,
      final,
      system,
      ...
    }:
    let
      packages = packagesFor pkgs;
    in
    {
      _module.args.pkgs = import inputs.nixpkgs {
        inherit system;
        config.allowUnfreePredicate =
          package:
          builtins.elem (lib.getName package) [
            "chatgpt"
            "farstep-sky"
            "claude-code"
          ];
      };

      # Use the consumer's final package set so later overlays affect dependencies
      overlayAttrs.aiTools = packagesFor final;

      packages = packages // {
        ai-configs = pkgs.callPackage ../../../config/settings/generate/generate.nix {
          configs = mkSettings { };
        };
        default = lib.mkDefault config.packages.ai-tools;
      };

      apps =
        lib.mapAttrs
          (name: package: {
            program = package;
            meta.description = package.meta.description or name;
          })
          (
            lib.filterAttrs (_: package: package.meta ? mainProgram) (removeAttrs config.packages [ "bun2nix" ])
          );

      checks = removeAttrs config.packages [
        "default"
        "bun"
        "bun2nix"
        "powershell-analyzer"
      ];
    };
}
