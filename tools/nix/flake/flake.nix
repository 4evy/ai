{ inputs, ... }:
{
  imports = [
    inputs.flake-parts.flakeModules.easyOverlay
    inputs.flake-parts.flakeModules.modules
    inputs.home-manager.flakeModules.home-manager
    inputs.treefmt-nix.flakeModule
    ./library.nix
    ./packages.nix
    ./modules.nix
    ./development.nix
  ];

  systems = [
    "x86_64-linux"
    "aarch64-linux"
    "aarch64-darwin"
  ];
}
