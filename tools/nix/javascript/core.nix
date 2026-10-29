{
  lib,
  callPackage,
  runCommand,
  ai-javascript-dependencies,
}:
let
  metadata = lib.trivial.importJSON ../../../packages/core/package.json;
  modules = (callPackage ./modules.nix { }) {
    pname = "ai-core-modules";
    inherit (metadata) version;
    projects = [ "packages/core" ];
    paths = [ ../../../packages/core ];
  };
in
runCommand "ai-core-${metadata.version}"
  {
    meta = {
      description = "Compiled harness-independent core utilities";
      license = lib.licenses.mit;
      platforms = modules.meta.platforms;
    };
    passthru = { inherit modules; };
  }
  ''
    mkdir -p "$out"
    cp -R ${modules}/. "$out/"
    bash ${./link-dependencies.sh} ${ai-javascript-dependencies.production} "$out/node_modules"
  ''
