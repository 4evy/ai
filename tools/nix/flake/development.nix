{ config, ... }:
let
  inherit (config.flake.lib) rustFor;
in
{
  perSystem =
    {
      config,
      pkgs,
      ...
    }:
    {
      devShells.default = pkgs.callPackage ../dev/dev.nix {
        rustToolchain = (rustFor pkgs).minimal.override {
          extensions = [
            "clippy"
            "rust-src"
            "rustfmt"
          ];
        };
        inherit (config.packages)
          bun
          bun2nix
          farstep
          ai-javascript
          ;
      };
      devShells.native = config.devShells.default.override { nativeOnly = true; };

      treefmt = {
        imports = [ ../fmt/fmt.nix ];
        _module.args.aiFormatters = {
          inherit (config.packages) ai-javascript bun powershell-analyzer;
        };
      };
    };
}
