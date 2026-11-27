{
  lib,
  runCommand,
  stdenv,
  craneLib,
}:
let
  source = import ../../tools/nix/source/source.nix { inherit lib; };
  crates = [
    "protocol"
    "desktop/api"
    "desktop/image"
    "desktop/runtime"
    "desktop/platform"
    "systemd"
    "desktop/cli"
    "service"
  ];
  manifests = [
    ../../Cargo.toml
    ../../Cargo.lock
  ]
  ++ map (crate: ../native + "/${crate}/Cargo.toml") crates;
  targets = lib.concatMap (
    crate:
    builtins.filter builtins.pathExists [
      (../native + "/${crate}/src/lib.rs")
      (../native + "/${crate}/src/main.rs")
    ]
  ) crates;
  # Crane reads target names, not their contents, when generating dummy sources
  dummy = craneLib.mkDummySrc { src = source (manifests ++ targets); };
  swiftCrates = [
    "apple-cf"
    "apple-metal"
    "axuielement"
    "screencapturekit"
  ];
  vendorDir = craneLib.vendorMultipleCargoDeps {
    cargoLockList = [ ../../Cargo.lock ];
    outputHashes."git+https://github.com/enigo-rs/enigo?rev=bdbbb413f60c2cb82f74e10411de74e77fc56ea2#bdbbb413f60c2cb82f74e10411de74e77fc56ea2" =
      "sha256-uLEtXo8HfdNYgOvQR18LS6KGY48kYZBIvsY+NmBlIW4=";
    overrideVendorCargoPackage =
      pkg: drv:
      if stdenv.hostPlatform.isDarwin && builtins.elem pkg.name swiftCrates then
        drv.overrideAttrs (old: {
          postPatch = (old.postPatch or "") + ''
            cp ${../packaging/swift/swift.rs} build.rs
          '';
        })
      else
        drv;
  };
in
{
  inherit crates vendorDir;
  # Keep the same unpacked path, manifests and profile in every compilation stage
  sourceFor =
    implementations:
    let
      real = source (manifests ++ implementations);
    in
    runCommand "source" { } ''
      mkdir -p "$out"
      cp -R ${dummy}/. "$out/"
      chmod -R u+w "$out"
      cp -R ${real}/. "$out/"
      chmod -R u+w "$out"
      ${lib.optionalString stdenv.hostPlatform.isDarwin ''
        daemon="$out/farstep/native/desktop/platform/src/macos/daemon.rs"
        if [ -f "$daemon" ]; then
          substituteInPlace "$daemon" \
            --replace-fail 'lib/farstep/farstep/runtime/main.ts' \
              'lib/farstep/farstep/runtime/main.js'
        fi
      ''}
    '';
}
