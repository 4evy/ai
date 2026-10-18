{ lib }:
paths:
let
  root = ../../..;
  clean = lib.sources.cleanSourceWith {
    src = root;
    filter =
      path: type:
      lib.sources.cleanSourceFilter path type
      && !(builtins.elem (baseNameOf path) [
        "node_modules"
        "dist"
        "target"
        "build"
        "tmp"
        ".generated"
        ".cache"
        ".venv"
        ".fallow"
        ".rumdl_cache"
      ]);
  };
in
lib.fileset.toSource {
  inherit root;
  fileset = lib.fileset.intersection (lib.fileset.unions paths) (lib.fileset.fromSource clean);
}
