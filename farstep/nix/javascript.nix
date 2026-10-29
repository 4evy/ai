{
  lib,
  callPackage,
  runCommand,
  ai-shared,
  ai-javascript-dependencies,
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
in
runCommand "farstep-javascript-${metadata.version}"
  {
    passthru = { inherit modules; };
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
    mkdir -p "$out/packages"
    cp -R ${modules}/. "$out/"
    chmod -R u+w "$out/farstep"
    ln -s ${skyTypes}/farstep/sky "$out/farstep/sky"
    for package in values runtime toolkit; do
      ln -s ${ai-shared}/packages/"$package" "$out/packages/$package"
    done
    bash ${../../tools/nix/javascript/link-dependencies.sh} ${ai-javascript-dependencies.production} "$out/node_modules"
    mkdir -p "$out/node_modules/@ai" "$out/node_modules/@oai"
    for package in values runtime toolkit; do
      ln -s ${ai-shared}/packages/"$package" "$out/node_modules/@ai/$package"
    done
    ln -s ../../farstep/sky "$out/node_modules/@oai/sky"
    ln -s ../farstep "$out/node_modules/farstep"
  ''
