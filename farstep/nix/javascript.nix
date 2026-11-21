{
  lib,
  callPackage,
  runCommand,
  ai-shared,
}:
let
  metadata = lib.trivial.importJSON ../package.json;
  source = import ../../tools/nix/source/source.nix { inherit lib; };
  modules = (callPackage ../../tools/nix/javascript/modules.nix { }) {
    pname = "farstep-modules";
    inherit (metadata) version;
    projects = [ "farstep" ];
    paths = [
      ../package.json
      ../vite.config.ts
      ../tsconfig.json
      ../farstep.ts
      ../installation.ts
      ../client
      ../protocol
      ../transport
      ../runtime
      ../remote
      ../skylight
      ../integration
      (lib.fileset.difference ../packaging (
        lib.fileset.unions [
          ../packaging/install
          ../packaging/swift
        ]
      ))
    ];
  };
  skyTypes = source [ ../sky ];
  dependencies = (callPackage ../../tools/nix/javascript/locked-dependencies.nix { }) ../dependencies;
in
runCommand "farstep-javascript-${metadata.version}"
  {
    passthru = { inherit modules skyTypes dependencies; };
    meta = {
      description = "Farstep JavaScript runtime and harness-independent APIs";
      license = lib.licenses.mit;
      platforms = modules.meta.platforms;
      sourceProvenance = [
        lib.sourceTypes.fromSource
        lib.sourceTypes.binaryNativeCode
      ];
    };
  }
  ''
    mkdir -p "$out"
    cp -R ${modules}/. "$out/"
    chmod -R u+w "$out"
    ln -s ${skyTypes}/farstep/sky "$out/farstep/sky"
    # Keep Farstep and its shared packages in one module-resolution tree
    cp -R ${ai-shared.modules}/. "$out/"
    bash ${../../tools/nix/javascript/link-dependencies.sh} ${dependencies} "$out/node_modules"
    mkdir -p "$out/node_modules/@ai" "$out/node_modules/@oai"
    for package in values runtime toolkit; do
      ln -s "../../packages/$package" "$out/node_modules/@ai/$package"
    done
    ln -s ../../farstep/sky "$out/node_modules/@oai/sky"
    ln -s ../farstep "$out/node_modules/farstep"
  ''
