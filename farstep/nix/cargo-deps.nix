{
  lib,
  runCommand,
  rustPlatform,
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
  vendor = rustPlatform.importCargoLock { lockFile = ../../Cargo.lock; };
in
{
  inherit crates;
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
  vendorDir =
    if stdenv.hostPlatform.isDarwin then
      runCommand "cargo-vendor-dir" { } ''
        cp -R ${vendor} "$out"
        chmod u+w "$out"
        for crate in "$out"/{apple-cf-*,apple-metal-*,axuielement-*,screencapturekit-*}; do
          source=$(readlink "$crate")
          rm "$crate"
          cp -R "$source" "$crate"
          chmod -R u+w "$crate"
          cp ${../packaging/swift/swift.rs} "$crate/build.rs"
        done
      ''
    else
      vendor;
}
