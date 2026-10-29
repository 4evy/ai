{
  lib,
  callPackage,
  runCommand,
  ai-javascript-dependencies,
}:
let
  metadata = lib.trivial.importJSON ../../../packages/values/package.json;
  modules = (callPackage ./modules.nix { }) {
    pname = "ai-shared-modules";
    inherit (metadata) version;
    projects = [
      "packages/values"
      "packages/runtime"
      "packages/toolkit"
    ];
    paths = [
      ../../../packages/values
      ../../../packages/runtime
      ../../../packages/toolkit
    ];
  };
in
runCommand "ai-shared-${metadata.version}"
  {
    meta = {
      description = "Compiled harness-independent shared packages";
      license = lib.licenses.mit;
      platforms = modules.meta.platforms;
    };
    passthru = { inherit modules; };
  }
  ''
    mkdir -p "$out"
    cp -R ${modules}/. "$out/"
    bash ${./link-dependencies.sh} ${ai-javascript-dependencies.production} "$out/node_modules"
    mkdir -p "$out/node_modules/@ai"
    for package in values runtime toolkit; do
      ln -s "../../packages/$package" "$out/node_modules/@ai/$package"
    done
  ''
