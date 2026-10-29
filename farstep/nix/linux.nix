{
  lib,
  bun,
  replaceVars,
  farstep-extensions,
  farstep-kde-bridge,
  kdePackages,
  gjs,
  coreutils,
  niri,
  hyprland,
  grim,
  sway-unwrapped,
  dbus,
  util-linux,
  zstd,
  desktop,
  ...
}:
{
  nativeBuildInputs = { };
  buildInputs = [ ];
  installScript = replaceVars ../packaging/install/linux.sh {
    BUN = lib.meta.getExe bun;
    DESKTOP = lib.meta.getExe' desktop "farstep-desktop";
    EXTENSIONS = farstep-extensions;
    KDE_BRIDGE = farstep-kde-bridge;
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
