{
  lib,
  craneLib,
  farstep-cargo,
  bash,
  coreutils,
  nix,
}:
let
  cargo = farstep-cargo;
  metadata = lib.trivial.importJSON ../package.json;
  commonArgs = {
    inherit (metadata) version;
    cargoVendorDir = cargo.vendorDir;
    cargoExtraArgs = "--locked --package farstep-service";
    CARGO_PROFILE = "release";
    strictDeps = true;
    doCheck = false;
    env = {
      FARSTEP_SERVICE_PATH = lib.strings.makeBinPath [
        bash
        coreutils
        nix
      ];
      FARSTEP_NIX_STORE = lib.meta.getExe' nix "nix-store";
      FARSTEP_STORE_DIR = builtins.storeDir;
    };
  };
  # The service has its own feature graph and no desktop native dependencies
  external = craneLib.mkCargoDerivation (
    commonArgs
    // {
      pname = "farstep-service-external";
      src = cargo.sourceFor [ ];
      cargoArtifacts = null;
      buildPhaseCargoCommand = "cargoWithProfile build ${commonArgs.cargoExtraArgs}";
      postBuild = "cargoWithProfile clean --package farstep-service";
      doInstallCargoArtifacts = true;
    }
  );
in
craneLib.buildPackage (
  commonArgs
  // {
    pname = "farstep-service";
    src = cargo.sourceFor [ ../native/service/src ];
    cargoArtifacts = external;
    preBuild = ''
      find farstep/native/service/src -type f -exec touch {} +
    '';
    passthru.artifacts = { inherit external; };
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
)
