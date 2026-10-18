{
  lib,
  bun,
  replaceVars,
  rcodesign,
  desktop,
  version,
}:
{
  nativeBuildInputs = { inherit rcodesign; };
  buildInputs = [ ];
  installScript = replaceVars ../packaging/install/darwin.sh {
    DESKTOP_PACKAGE = desktop;
    PACKAGE_VERSION = version;
    BUN = lib.meta.getExe bun;
    # Replaced in the installed Info.plist
    VERSION = null;
  };
  postFixup = ''
    rcodesign sign "$out/share/Farstep.app"
  '';
}
