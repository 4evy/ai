{
  lib,
  rustPlatform,
  bash,
  coreutils,
  nix,
}:
let
  source = import ../../tools/nix/source/source.nix { inherit lib; };
  metadata = lib.trivial.importJSON ../package.json;
in
rustPlatform.buildRustPackage {
  pname = "farstep-service";
  inherit (metadata) version;
  src = source [
    # Keep workspace metadata for locked resolution, not unrelated implementations
    ../../Cargo.toml
    ../../Cargo.lock
    ../native/protocol/Cargo.toml
    ../native/desktop-runtime/Cargo.toml
    ../native/desktop/Cargo.toml
    ../native/service/Cargo.toml
    ../native/service/src
  ];
  cargoDeps = rustPlatform.importCargoLock { lockFile = ../../Cargo.lock; };
  cargoBuildFlags = [
    "--locked"
    "--package"
    "farstep-service"
  ];
  env = {
    FARSTEP_SERVICE_PATH = lib.strings.makeBinPath [
      bash
      coreutils
      nix
    ];
    FARSTEP_NIX_STORE = lib.meta.getExe' nix "nix-store";
    FARSTEP_STORE_DIR = builtins.storeDir;
  };
  # This package has no test suite; keep Cargo from rebuilding it for checks
  doCheck = false;
  meta = {
    description = "Privileged machine service executable";
    homepage = "https://github.com/4evy/ai";
    license = lib.licenses.mit;
    maintainers = [ lib.maintainers._4evy ];
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
      "aarch64-darwin"
    ];
    mainProgram = "farstep-service";
  };
}
