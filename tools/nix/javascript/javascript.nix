{
  lib,
  stdenv,
  callPackage,
  bun,
  bun2nix,
  autoPatchelfHook,
}:
let
  manifest = lib.trivial.importJSON ../../../package.json;
  source = import ../source/source.nix { inherit lib; };
  patches = lib.attrsets.mapAttrs (_: path: ../../.. + "/${path}") manifest.patchedDependencies;
  workspaceSource =
    path:
    if path == "farstep" then
      lib.fileset.difference ../../../farstep (
        lib.fileset.unions [
          ../../../farstep/native/protocol
          ../../../farstep/native/desktop-runtime
          ../../../farstep/native/service
          ../../../farstep/native/desktop/Cargo.toml
          ../../../farstep/native/desktop/build.rs
          ../../../farstep/native/desktop/src
        ]
      )
    else
      ../../.. + "/${path}";
  platform = if stdenv.hostPlatform.isDarwin then "darwin" else "linux";
  arch = if stdenv.hostPlatform.isAarch64 then "arm64" else "x64";
in
assert lib.asserts.assertMsg (manifest.packageManager == "bun@${bun.version}")
  "The JavaScript workspace requires ${manifest.packageManager}, but Nix supplies bun@${bun.version}";
stdenv.mkDerivation {
  pname = "ai-javascript";
  inherit (lib.trivial.importJSON ../../../packages/core/package.json) version;
  src = source (
    [
      ../../../package.json
      ../../../bun.lock
      ../../../tsconfig.json
      ../../../biome.jsonc
      ../../../.github/scripts
      ../../../vite.config.ts
      ../../../apps/browser
      ../../../apps/codex
      ../../../apps/claude
      ../../../apps/opencode
      ../../../config/settings
      ../../../apps/ghidra
      ../../scripts
    ]
    ++ map workspaceSource manifest.workspaces.packages
  );
  bunDeps = bun2nix.fetchBunDeps {
    # Workspaces and file dependencies are installed from src, not the cache
    # Keeping their contents out of the cache lets source-only changes reuse it
    bunNix = args: callPackage ./bun.nix (args // { copyPathToStore = _: null; });
    overrides = bun2nix.patchedDependenciesToOverrides { patchedDependencies = patches; };
  };
  nativeBuildInputs = [
    bun
    bun2nix.hook
  ]
  ++ lib.lists.optional stdenv.hostPlatform.isLinux autoPatchelfHook;
  buildInputs = lib.lists.optional stdenv.hostPlatform.isLinux stdenv.cc.cc.lib;
  strictDeps = true;
  dontStrip = stdenv.hostPlatform.isDarwin;
  dontRunLifecycleScripts = true;
  dontUseBunBuild = true;
  dontUseBunCheck = true;
  dontUseBunInstall = true;
  bunInstallFlags = [
    "--frozen-lockfile"
    "--offline"
    "--linker=hoisted"
    "--backend=copyfile"
  ];
  buildPhase = ''
    runHook preBuild
    bun run build
    runHook postBuild
  '';
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    bun run typecheck
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    # Bun does not prune an existing install when switching to production
    rm -rf node_modules ${
      lib.strings.escapeShellArgs (map (path: "${path}/node_modules") manifest.workspaces.packages)
    }
    bun install --production --frozen-lockfile --offline --ignore-scripts \
      --linker=hoisted --backend=copyfile
    bun tools/scripts/vite/install.ts "$out"
    cp -R node_modules "$out/"
    rm -rf "$out/node_modules/@oai/sky"
    mkdir -p "$out/node_modules/@oai"
    ln -s ../../farstep/sky "$out/node_modules/@oai/sky"
    rm -f "$out/node_modules/.bin/omp"
    rm -rf "$out/node_modules/@img/"*linuxmusl*
    onnx="$out/node_modules/onnxruntime-node/bin/napi-v6"
    if [ -d "$onnx" ]; then
      for directory in "$onnx"/*; do
        if [ "$(basename "$directory")" != ${lib.strings.escapeShellArg platform} ]; then
          rm -rf "$directory"
        else
          for architecture in "$directory"/*; do
            if [ "$(basename "$architecture")" != ${lib.strings.escapeShellArg arch} ]; then
              rm -rf "$architecture"
            fi
          done
        fi
      done
    fi
    runHook postInstall
  '';
  passthru.workspaces = manifest.workspaces.packages;
  meta = {
    description = "Compiled AI tooling and shared JavaScript runtime dependencies";
    longDescription = ''
      Contains compiled workspace tools, coding agent extensions, and production
      dependencies shared by the launcher and machine automation packages.
      Native addons are taken from published platform packages. This package
      provides runtime files rather than a standalone command.
    '';
    homepage = "https://github.com/4evy/ai";
    license = lib.licenses.mit;
    sourceProvenance = [
      lib.sourceTypes.fromSource
      lib.sourceTypes.binaryNativeCode
    ];
    maintainers = [ lib.maintainers._4evy ];
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
      "aarch64-darwin"
    ];
  };
}
