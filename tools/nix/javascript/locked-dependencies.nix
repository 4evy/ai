{
  lib,
  stdenv,
  callPackage,
  bun,
  bun2nix,
  autoPatchelfHook,
}:
directory:
let
  manifest = lib.importJSON (directory + "/package.json");
  linux = stdenv.hostPlatform.isLinux;
in
stdenv.mkDerivation {
  pname = manifest.name;
  inherit (manifest) version;
  src = lib.fileset.toSource {
    root = directory;
    fileset = lib.fileset.unions [
      (directory + "/package.json")
      (directory + "/bun.lock")
    ];
  };
  bunDeps = bun2nix.fetchBunDeps {
    bunNix =
      args:
      lib.filterAttrs (import ./platform-filter.nix { inherit lib stdenv; } (
        directory + "/platforms.json"
      )) (callPackage (directory + "/bun.nix") args);
  };
  strictDeps = true;
  nativeBuildInputs = [
    bun
    bun2nix.hook
  ]
  ++ lib.optional linux autoPatchelfHook;
  buildInputs = lib.optional linux stdenv.cc.cc.lib;
  dontStrip = !linux;
  dontRunLifecycleScripts = true;
  dontUseBunBuild = true;
  dontUseBunCheck = true;
  dontUseBunInstall = true;
  bunInstallFlags = [
    "--production"
    "--frozen-lockfile"
    "--offline"
    "--linker=hoisted"
    "--backend=copyfile"
  ];
  installPhase = ''
    runHook preInstall
    ${lib.optionalString linux ''
      rm -rf node_modules/@img/*linuxmusl* node_modules/*-musl node_modules/@*/*-musl
    ''}
    mkdir -p "$out"
    mv node_modules "$out/"
    runHook postInstall
  '';
}
