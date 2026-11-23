{
  pkgs,
  bun,
  bun2nix,
  farstep,
  ai-javascript,
  rustToolchain,
  nativeOnly ? false,
}:
let
  inherit (pkgs) lib;
  linux = pkgs.stdenv.hostPlatform.isLinux;
  cargoBin = lib.getExe' rustToolchain "cargo";
  cargo =
    if linux then
      cargoBin
    else
      let
        vendor = farstep.desktop.cargoVendorDir;
      in
      lib.getExe (
        pkgs.writeShellScriptBin "cargo" ''
          configuration=(--config "${vendor}/config.toml")
          # Clippy forwards subcommand arguments to its nested Cargo invocation
          if [[ "''${1-}" == clippy ]]; then
            shift
            exec ${cargoBin} clippy "''${configuration[@]}" "$@"
          fi
          exec ${cargoBin} "''${configuration[@]}" "$@"
        ''
      );
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
      inherit bun bun2nix rustToolchain;
      inherit (pkgs)
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
        uv
        pandoc
        rumdl
        ;
    }
    // lib.attrsets.optionalAttrs (linux && !nativeOnly) {
      inherit (pkgs.qt6) qtdeclarative;
      inherit (pkgs.kdePackages) kwin;
      inherit (pkgs) gjs;
    }
  );
  env = {
    RUST_SRC_PATH = "${rustToolchain}/lib/rustlib/src/rust/library";
    CARGO = cargo;
    RUSTC = lib.getExe' rustToolchain "rustc";
  }
  // lib.attrsets.optionalAttrs pkgs.stdenv.hostPlatform.isDarwin {
    # inputsFrom inherits compiler inputs, but not the package's linker flags
    inherit (farstep.desktop) NIX_LDFLAGS;
  }
  // lib.attrsets.optionalAttrs (!nativeOnly && farstep.skyRuntime != null) {
    FARSTEP_SKY_RUNTIME = toString farstep.skyRuntime;
  };
  shellHook = ''
    export PATH="$PWD/node_modules/.bin:${dirOf cargo}:${rustToolchain}/bin:$PATH"
  '';
}
