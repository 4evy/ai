{
  lib,
  stdenv,
  callPackage,
  makeBinaryWrapper,
  replaceVars,
  ai-javascript,
  farstep-native,
  farstep-sky ? null,
  nix,
}:
let
  metadata = lib.trivial.importJSON ./package.json;
  source = import ../tools/nix/source/source.nix { inherit lib; };
  desktop = farstep-native;
  platform = callPackage (if stdenv.hostPlatform.isLinux then ./nix/linux.nix else ./nix/darwin.nix) {
    inherit desktop;
    inherit (metadata) version;
  };
in
stdenv.mkDerivation {
  pname = "farstep";
  inherit (metadata) version;
  src = source [
    ./manifest.json
    ./native/desktop/platform
  ];
  postUnpack = ''
    sourceRoot="$sourceRoot/farstep"
  '';
  nativeBuildInputs = lib.attrsets.attrValues (
    { inherit makeBinaryWrapper; } // platform.nativeBuildInputs
  );
  inherit (platform) buildInputs postFixup;
  dontUseCmakeConfigure = true;
  dontWrapQtApps = true;
  dontConfigure = true;
  dontBuild = true;
  strictDeps = true;
  dontStrip = stdenv.hostPlatform.isDarwin;

  installPhase = ''
    source ${replaceVars ./packaging/install/install.sh { JAVASCRIPT = ai-javascript; }}
    cp ${desktop}/bin/farstep-service "$out/bin/farstep-service"
    source ${platform.installScript}
    ${lib.strings.optionalString (farstep-sky != null) ''
      ln -s ${farstep-sky} "$out/share/farstep/sky"
    ''}
    wrapProgram "$out/bin/farstep" \
      --prefix PATH : ${lib.strings.makeBinPath [ nix ]} \
      ${lib.strings.optionalString (farstep-sky != null) "--set FARSTEP_SKY_RUNTIME ${farstep-sky}"}
    wrapProgram "$out/bin/farstep-desktop" \
      --prefix PATH : ${lib.strings.makeBinPath [ nix ]} \
      ${lib.strings.optionalString (farstep-sky != null) "--set FARSTEP_SKY_RUNTIME ${farstep-sky}"}
    runHook postInstall
  '';

  passthru = {
    inherit desktop;
    nativeInputs = desktop.buildInputs;
    skyRuntime = farstep-sky;
  };
  meta = {
    description = "Agent jobs, coordination, and desktop automation";
    homepage = "https://github.com/4evy/ai";
    license = lib.licenses.mit;
    inherit (ai-javascript.meta) sourceProvenance;
    maintainers = [ lib.maintainers._4evy ];
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
      "aarch64-darwin"
    ];
    mainProgram = "farstep";
  }
  // lib.attrsets.optionalAttrs stdenv.hostPlatform.isDarwin {
    mainDarwinApp = "Farstep.app";
  };
}
