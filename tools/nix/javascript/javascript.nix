{
  lib,
  callPackage,
  runCommand,
  ai-shared,
  ai-javascript-dependencies,
  farstep-javascript,
}:
let
  metadata = lib.trivial.importJSON ../../../packages/values/package.json;
  source = import ../source/source.nix { inherit lib; };
  modules = (callPackage ./modules.nix { }) {
    pname = "ai-app-modules";
    inherit (metadata) version;
    projects = [
      "."
      "apps/chatgpt"
      "apps/omp"
    ];
    paths = [
      ../../../package.json
      ../../../vite.config.ts
      ../../../apps/browser
      ../../../apps/codex
      ../../../apps/claude
      ../../../apps/opencode
      ../../../config/settings
      ../../../apps/ghidra
      ../../../apps/chatgpt
      ../../../apps/omp
      ../../scripts
    ];
  };
  upstream = source [
    ../../../apps/omp/runtime/upstream/package.json
    ../../../apps/omp/runtime/upstream/bun.lock
  ];
in
runCommand "ai-javascript-${metadata.version}"
  {
    outputs = [
      "out"
      "biome"
    ];
    passthru = {
      inherit modules;
      inherit (ai-javascript-dependencies) workspaces;
    };
    meta = {
      description = "Compiled AI tooling assembled from independent JavaScript components";
      homepage = "https://github.com/4evy/ai";
      license = lib.licenses.mit;
      inherit (farstep-javascript.meta) sourceProvenance platforms;
      maintainers = [ lib.maintainers._4evy ];
    };
  }
  ''
    mkdir -p "$out/packages" "$biome/node_modules/@biomejs"
    cp -R ${modules}/. "$out/"
    chmod -R u+w "$out"
    cp -R ${upstream}/apps/omp/runtime/upstream "$out/apps/omp/runtime/"
    for package in values runtime toolkit; do
      ln -s ${ai-shared}/packages/"$package" "$out/packages/$package"
    done
    ln -s ${farstep-javascript}/farstep "$out/farstep"
    bash ${./link-dependencies.sh} ${ai-javascript-dependencies.production} "$out/node_modules"
    mkdir -p "$out/node_modules/@ai" "$out/node_modules/@oai"
    for package in values runtime toolkit; do
      ln -s ${ai-shared}/packages/"$package" "$out/node_modules/@ai/$package"
    done
    ln -s ${farstep-javascript}/farstep "$out/node_modules/farstep"
    ln -s ${farstep-javascript}/farstep/sky "$out/node_modules/@oai/sky"
    ln -s ../apps/omp "$out/node_modules/omp-agent-runtime"
    for package in ${ai-javascript-dependencies}/node_modules/@biomejs/*; do
      ln -s "$package" "$biome/node_modules/@biomejs/$(basename "$package")"
    done
  ''
