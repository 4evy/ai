{
  pkgs,
  bun,
  bun2nix,
  farstep,
  ai-javascript,
  nativeOnly ? false,
}:
let
  inherit (pkgs) lib;
  linux = pkgs.stdenv.hostPlatform.isLinux;
  cargo =
    if linux then
      pkgs.cargo
    else
      let
        vendor = pkgs.callPackage ../../../farstep/nix/cargo-deps.nix { };
      in
      pkgs.writeShellScriptBin "cargo" ''
        configuration=(
          --config 'source.crates-io.replace-with="nix-vendor"'
          --config 'source.nix-vendor.directory="${vendor}"'
        )
        # Clippy forwards subcommand arguments to its nested Cargo invocation
        if [[ "''${1-}" == clippy ]]; then
          shift
          exec ${lib.meta.getExe pkgs.cargo} clippy "''${configuration[@]}" "$@"
        fi
        exec ${lib.meta.getExe pkgs.cargo} "''${configuration[@]}" "$@"
      '';
in
pkgs.mkShell {
  inputsFrom =
    if nativeOnly then
      [ farstep.desktop ]
    else
      [
        ai-javascript
        farstep.desktop
        farstep
      ];
  packages = lib.attrsets.attrValues (
    {
      inherit bun bun2nix cargo;
      inherit (pkgs)
        rustc
        rustfmt
        clippy
        rust-analyzer
        just
        actionlint
        zizmor
        curl
        jq
        git
        patch
        gnutar
        pkg-config
        cmake
        ninja
        deadnix
        nixfmt
        statix
        nix-update
        pandoc
        rumdl
        ;
    }
    // lib.attrsets.optionalAttrs (!linux) {
      inherit (pkgs) clang swift;
    }
    // lib.attrsets.optionalAttrs (linux && !nativeOnly) {
      inherit (pkgs.qt6) qtdeclarative;
      inherit (pkgs.kdePackages) kwin;
      inherit (pkgs) gjs;
    }
  );
  env = {
    RUST_SRC_PATH = "${pkgs.rustPlatform.rustLibSrc}";
    CARGO = lib.meta.getExe cargo;
  }
  // lib.attrsets.optionalAttrs (!nativeOnly && farstep.skyRuntime != null) {
    FARSTEP_SKY_RUNTIME = toString farstep.skyRuntime;
  };
  shellHook = ''
    export PATH="$PWD/node_modules/.bin:$PATH"
  '';
}
