{
  bun,
  fetchurl,
  lib,
  stdenvNoCC,
  aiUpdateScript,
  nix,
  jq,
}:
let
  hashes = {
    aarch64-darwin = "sha256-wkDX8My5DCY6hJ/NsJt+5iYw2SE0jtaq/ahrnVd7xRA=";
    aarch64-linux = "sha256-uqa7NvUdblhWHgK76oJQOKnfRU9nPW13bou/hvjHhQ4=";
    x86_64-linux = "sha256-4ERutVmVdy65iUvrrppr42jZhai5Jx7hJEhvmUbu3XY=";
  };
in
bun.overrideAttrs (
  finalAttrs: old: {
    version = "1.4.4";
    src = finalAttrs.passthru.sources.${stdenvNoCC.hostPlatform.system};
    passthru = old.passthru // {
      sources = lib.attrsets.mapAttrs (
        system: source:
        fetchurl {
          url = lib.strings.replaceString "bun-v${bun.version}" "bun-v${finalAttrs.version}" source.url;
          hash = hashes.${system};
        }
      ) (builtins.intersectAttrs hashes bun.sources);
      updateScript = aiUpdateScript {
        attrPath = "bun";
        extraArgs = [
          "--override-filename=tools/nix/javascript/runtime/runtime.nix"
        ]
        ++ lib.lists.concatMap (system: [ "--subpackage=sources.${system}" ]) (builtins.attrNames hashes);
        runtimeInputs = [
          nix
          jq
        ];
        afterUpdate = ''
          version=$(nix eval --raw .#bun.version)
          for manifest in package.json farstep/package.json farstep/dependencies/package.json; do
            temporary=$(mktemp "$manifest.XXXXXX")
            jq --arg version "bun@$version" '.packageManager = $version' "$manifest" > "$temporary"
            mv "$temporary" "$manifest"
          done
        '';
      };
    };
    meta = old.meta // {
      description = "JavaScript and TypeScript runtime, bundler, and package manager";
      maintainers = [ lib.maintainers._4evy ];
      platforms = builtins.attrNames finalAttrs.passthru.sources;
    };
  }
)
