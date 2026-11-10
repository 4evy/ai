{
  lib,
  stdenv,
  craneLib,
  farstep-cargo,
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
  cargo = farstep-cargo;
  metadata = lib.trivial.importJSON ../package.json;
  linux = stdenv.hostPlatform.isLinux;
  # Native bridges only need the compiler, not the REPL's separately built LLDB
  swiftCompiler = swift.override { enableRepl = false; };
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
  implementations = {
    protocol = [ ../native/protocol/src ];
    api = [ ../native/desktop/api/src ];
    image = [ ../native/desktop/image/src ];
    runtime = [ ../native/desktop/runtime/src ];
    platform = [
      ../native/desktop/platform/src/lib.rs
    ]
    ++ (
      if linux then
        [ ../native/desktop/platform/src/linux ]
      else
        [
          ../native/desktop/platform/src/native
          ../native/desktop/platform/src/macos
        ]
    );
    systemd = [ ../native/systemd/src ];
    cli = [
      ../native/desktop/cli/src
      ../native/desktop/cli/build.rs
    ];
  };
  packageNames = {
    protocol = "farstep-protocol";
    api = "farstep-desktop-api";
    image = "farstep-desktop-image";
    runtime = "farstep-desktop-runtime";
    platform = "farstep-desktop-platform";
    systemd = "farstep-systemd";
    cli = "farstep-desktop";
  };
  sources = names: cargo.sourceFor (lib.concatMap (name: implementations.${name}) names);
  commonArgs = {
    inherit (metadata) version;
    cargoVendorDir = cargo.vendorDir;
    cargoExtraArgs = "--locked --package farstep-desktop";
    CARGO_PROFILE = "release";
    strictDeps = true;
    doCheck = false;
    nativeBuildInputs = lib.attrsets.attrValues (
      {
        inherit pkg-config makeBinaryWrapper;
      }
      // lib.attrsets.optionalAttrs stdenv.hostPlatform.isDarwin {
        inherit clang;
        swift = swiftCompiler;
      }
    );
    buildInputs = nativeInputs;
    env = lib.attrsets.optionalAttrs stdenv.hostPlatform.isDarwin {
      # Search both Nixpkgs layouts for Swift's back-deployment archives
      NIX_LDFLAGS = "-L${swiftCompiler}/lib -L${swiftCompiler}/lib/swift/macosx";
    };
  };
  # Always resolve the final feature graph, even while compiling a smaller layer
  # Unimplemented workspace crates are Crane dummies, removed before exporting
  # artifacts so independent branches cannot overwrite each other's real crates
  stage =
    name: realCrates: previous: additional: promoted:
    craneLib.mkCargoDerivation (
      commonArgs
      // {
        pname = "farstep-desktop-${name}";
        src = sources realCrates;
        cargoArtifacts = previous;
        preBuild =
          lib.concatMapStrings (artifacts: ''
            inheritCargoArtifacts ${artifacts}
          '') additional
          # Nix normalizes source mtimes, so explicitly dirty only newly real code
          + lib.concatMapStrings (path: ''
            find ${lib.escapeShellArg (lib.removePrefix "${toString ../..}/" (toString path))} -type f -exec touch {} +
          '') (lib.concatMap (crate: implementations.${crate}) promoted);
        buildPhaseCargoCommand = "cargoWithProfile build --lib ${commonArgs.cargoExtraArgs}";
        postBuild =
          let
            dummyPackages = map (name: packageNames.${name}) (
              lib.subtractLists realCrates (builtins.attrNames packageNames)
            );
          in
          "cargoWithProfile clean "
          + lib.escapeShellArgs (
            lib.concatMap (name: [
              "--package"
              name
            ]) dummyPackages
          );
        doInstallCargoArtifacts = true;
      }
      // lib.optionalAttrs (additional != [ ]) {
        # Delta archives retain only one parent, not the imported branches
        doCompressAndInstallFullArchive = true;
      }
    );
  external = stage "external" [ ] null [ ] [ ];
  protocol = stage "protocol" [ "protocol" ] external [ ] [ "protocol" ];
  api = stage "api" [ "protocol" "api" ] protocol [ ] [ "api" ];
  runtime = stage "runtime" [ "protocol" "api" "runtime" ] api [ ] [ "runtime" ];
  image = stage "image" [ "protocol" "image" ] protocol [ ] [ "image" ];
  systemd = stage "systemd" [ "protocol" "systemd" ] protocol [ ] [ "systemd" ];
  platformCrates = [
    "protocol"
    "api"
    "runtime"
    "image"
    "platform"
  ];
  platform = stage "platform" platformCrates runtime [ image ] [ "platform" ];
  artifacts = {
    inherit
      external
      protocol
      api
      runtime
      image
      platform
      ;
  }
  // lib.optionalAttrs linux { inherit systemd; };
in
craneLib.buildPackage (
  commonArgs
  // {
    pname = "farstep-desktop";
    src = sources (platformCrates ++ [ "cli" ] ++ lib.optional linux "systemd");
    cargoArtifacts = platform;
    preBuild =
      lib.optionalString linux ''
        inheritCargoArtifacts ${systemd}
      ''
      + ''
        find farstep/native/desktop/cli -type f -exec touch {} +
      '';
    passthru = {
      inherit artifacts;
      cargoVendorDir = cargo.vendorDir;
    };
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
)
