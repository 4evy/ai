{
  lib,
  stdenv,
  rustPlatform,
  callPackage,
  makeBinaryWrapper,
  pkg-config,
  clang,
  swift,
  glib,
  dbus,
  libsysprof-capture,
  pcre2,
  libselinux,
  libsepol,
  util-linux,
  libunwind,
  elfutils,
  gst_all_1,
  pipewire,
  libxkbcommon,
  xkeyboard_config,
  wayland,
}:
let
  source = import ../../tools/nix/source/source.nix { inherit lib; };
  metadata = lib.trivial.importJSON ../package.json;
  linux = stdenv.hostPlatform.isLinux;
  nativeInputs = lib.attrsets.attrValues (
    lib.attrsets.optionalAttrs linux {
      inherit
        glib
        libsysprof-capture
        pcre2
        libselinux
        libsepol
        util-linux
        libunwind
        elfutils
        pipewire
        libxkbcommon
        wayland
        ;
      inherit (gst_all_1) gstreamer gst-plugins-base gst-plugins-good;
    }
  );
  pluginPath = lib.strings.makeSearchPath "lib/gstreamer-1.0" (
    lib.attrsets.attrValues {
      gstreamer = lib.attrsets.getLib gst_all_1.gstreamer;
      inherit (gst_all_1) gst-plugins-base gst-plugins-good;
      inherit pipewire;
    }
  );
in
rustPlatform.buildRustPackage {
  pname = "farstep-desktop";
  inherit (metadata) version;
  src = source [
    # Keep workspace metadata for locked resolution, not unrelated implementations
    ../../Cargo.toml
    ../../Cargo.lock
    ../native/protocol
    ../native/desktop-runtime/Cargo.toml
    ../native/desktop-runtime/src
    ../native/desktop/Cargo.toml
    ../native/desktop/build.rs
    ../native/desktop/src
    ../native/service/Cargo.toml
  ];
  cargoDeps = callPackage ./cargo-deps.nix { };
  postPatch = lib.strings.optionalString stdenv.hostPlatform.isDarwin ''
    substituteInPlace farstep/native/desktop/src/platform/macos/daemon.rs \
      --replace-fail 'lib/farstep/farstep/runtime/main.ts' \
        'lib/farstep/farstep/runtime/main.js'
  '';
  cargoBuildFlags = [
    "--locked"
    "--package"
    "farstep-desktop"
  ];
  nativeBuildInputs = lib.attrsets.attrValues (
    {
      inherit pkg-config makeBinaryWrapper;
    }
    // lib.attrsets.optionalAttrs stdenv.hostPlatform.isDarwin { inherit clang swift; }
  );
  buildInputs = nativeInputs;
  # This package has no test suite; keep Cargo from rebuilding it for checks
  doCheck = false;
  postInstall = lib.strings.optionalString linux ''
    wrapProgram "$out/bin/farstep-desktop" \
      --set GST_PLUGIN_SYSTEM_PATH_1_0 "${pluginPath}" \
      --set GST_PLUGIN_SCANNER_1_0 "${lib.attrsets.getLib gst_all_1.gstreamer}/libexec/gstreamer-1.0/gst-plugin-scanner" \
      --set XKB_CONFIG_ROOT "${xkeyboard_config}/share/X11/xkb" \
      --set FARSTEP_WORKSPACE_DBUS_CONFIG "${dbus}/share/dbus-1/session.conf" \
      --prefix PATH : "${
        lib.strings.makeBinPath (lib.attrsets.attrValues { inherit dbus util-linux; })
      }" \
      --prefix LD_LIBRARY_PATH : "${
        lib.strings.makeLibraryPath (lib.attrsets.attrValues { inherit libxkbcommon wayland; })
      }"
  '';
  meta = {
    description = "Native desktop automation executable";
    homepage = "https://github.com/4evy/ai";
    license = lib.licenses.mit;
    maintainers = [ lib.maintainers._4evy ];
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
      "aarch64-darwin"
    ];
    mainProgram = "farstep-desktop";
  };
}
