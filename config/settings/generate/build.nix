{
  repository,
  system,
  hostFile ? "",
  overridesFile ? "",
}:
let
  inherit (builtins) getFlake;
  flake = getFlake ("path:" + repository);
  json = path: if path == "" then { } else builtins.fromJSON (builtins.readFile path);
in
flake.lib.mkConfigs {
  inherit system;
  host = json hostFile;
  overrides = json overridesFile;
}
