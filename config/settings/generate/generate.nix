{ pkgs, configs }:
let
  inherit (pkgs) lib;
  generated = lib.attrsets.mapAttrs (
    path: entry: (pkgs.formats.${entry.format} { }).generate (baseNameOf path) entry.settings
  ) configs;
  manifest = pkgs.writeText "ai-configs-manifest.json" (
    builtins.toJSON {
      version = 1;
      files = lib.attrsets.mapAttrsToList (path: entry: {
        inherit path;
        inherit (entry) private;
      }) configs;
    }
  );
  files = pkgs.linkFarm "ai-configs-files" (generated // { "manifest.json" = manifest; });
in
lib.meta.addMetaAttrs
  {
    description = "Portable settings export for AI tools";
    homepage = "https://github.com/4evy/ai";
    license = lib.licenses.mit;
    maintainers = [ lib.maintainers._4evy ];
    platforms = lib.platforms.all;
  }
  (
    pkgs.runCommandLocal "ai-configs" { } ''
      cp -RL ${files} "$out"
    ''
  )
