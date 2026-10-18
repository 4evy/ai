{
  lib,
  bun,
  replaceVars,
  cmake,
  qt6,
  kdePackages,
  gjs,
  coreutils,
  niri,
  hyprland,
  grim,
  sway-unwrapped,
  pkg-config,
  dbus,
  util-linux,
  zstd,
  desktop,
  ...
}:
{
  nativeBuildInputs = {
    inherit cmake pkg-config;
    inherit (qt6) wrapQtAppsHook;
  };
  buildInputs = [
    kdePackages.kwin
    qt6.qtdeclarative
  ];
  installScript = replaceVars ../packaging/install/linux.sh {
    BUN = lib.meta.getExe bun;
    DESKTOP = lib.meta.getExe' desktop "farstep-desktop";
    SWAY = lib.meta.getExe' sway-unwrapped "sway";
    GRIM = lib.meta.getExe grim;
    GJS_BINARY = lib.meta.getExe gjs;
    # Replaced in the installed service template
    GJS = null;
    GATEWAY_PATH = lib.strings.makeBinPath (
      lib.attrsets.attrValues {
        inherit zstd gjs sway-unwrapped;
        inherit (kdePackages) kconfig;
      }
    );
    DESKTOP_PATH = lib.strings.makeBinPath (
      lib.attrsets.attrValues {
        inherit
          gjs
          sway-unwrapped
          niri
          hyprland
          coreutils
          dbus
          util-linux
          ;
      }
    );
  };
  postFixup = "";
}
