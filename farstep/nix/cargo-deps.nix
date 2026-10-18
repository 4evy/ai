{
  runCommand,
  rustPlatform,
  stdenv,
}:
let
  vendor = rustPlatform.importCargoLock { lockFile = ../../Cargo.lock; };
in
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
  vendor
