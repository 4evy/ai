{
  lib,
  stdenv,
  cmake,
  pkg-config,
  qt6,
  kdePackages,
}:
let
  source = import ../../tools/nix/source/source.nix { inherit lib; };
  metadata = lib.trivial.importJSON ../package.json;
in
stdenv.mkDerivation {
  pname = "farstep-kde-bridge";
  inherit (metadata) version;
  src = source [ ../native/desktop/platform/linux/extensions/kde/bridge ];
  postUnpack = ''
    sourceRoot="$sourceRoot/farstep/native/desktop/platform/linux/extensions/kde/bridge"
  '';
  nativeBuildInputs = [
    cmake
    pkg-config
    qt6.wrapQtAppsHook
  ];
  buildInputs = [
    kdePackages.kwin
    qt6.qtdeclarative
  ];
  # KWin loads this QML plugin, so there is no executable to wrap
  dontWrapQtApps = true;
  strictDeps = true;

  meta = {
    description = "Farstep KWin QML bridge";
    homepage = "https://github.com/4evy/ai";
    license = lib.licenses.mit;
    maintainers = [ lib.maintainers._4evy ];
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
    ];
  };
}
