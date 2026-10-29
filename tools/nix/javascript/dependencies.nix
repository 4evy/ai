{
  lib,
  stdenv,
  callPackage,
  runCommand,
  bun,
  bun2nix,
  autoPatchelfHook,
}:
let
  manifest = lib.trivial.importJSON ../../../package.json;
  workspaceManifests = map (path: ../../.. + "/${path}/package.json") manifest.workspaces.packages;
  localManifests = workspaceManifests ++ [ ../../../farstep/sky/package.json ];
  localNames = map (path: (lib.trivial.importJSON path).name) localManifests;
  patches = lib.attrsets.mapAttrs (_: path: ../../.. + "/${path}") manifest.patchedDependencies;
  manifestPaths = [
    "package.json"
  ]
  ++ map (path: "${path}/package.json") manifest.workspaces.packages
  ++ [ "farstep/sky/package.json" ];
  dependencyManifest =
    path:
    builtins.toFile "package.json" (
      builtins.toJSON (
        builtins.intersectAttrs (lib.attrsets.genAttrs [
          "name"
          "version"
          "dependencies"
          "devDependencies"
          "optionalDependencies"
          "peerDependencies"
          "peerDependenciesMeta"
          "overrides"
          "resolutions"
          "workspaces"
          "patchedDependencies"
          "packageManager"
          "trustedDependencies"
          "os"
          "cpu"
          "libc"
        ] (_: null)) (lib.trivial.importJSON (../../.. + "/${path}"))
      )
    );
  platform = if stdenv.hostPlatform.isDarwin then "darwin" else "linux";
  arch = if stdenv.hostPlatform.isAarch64 then "arm64" else "x64";
  platforms = lib.trivial.importJSON ./platforms.json;
  matchesPlatform =
    target: values:
    let
      allowed = builtins.filter (value: !lib.strings.hasPrefix "!" value) values;
    in
    !builtins.elem "!${target}" values
    && (allowed == [ ] || builtins.elem target allowed || builtins.elem "any" allowed);
  forHost =
    name: _:
    let
      constraints = platforms.${name} or { };
    in
    matchesPlatform platform (constraints.os or [ ]) && matchesPlatform arch (constraints.cpu or [ ]);
in
assert lib.asserts.assertMsg (manifest.packageManager == "bun@${bun.version}")
  "The JavaScript workspace requires ${manifest.packageManager}, but Nix supplies bun@${bun.version}";
stdenv.mkDerivation {
  pname = "ai-javascript-dependencies";
  inherit (lib.trivial.importJSON ../../../packages/values/package.json) version;
  outputs = [
    "out"
    "production"
  ];
  # Ignore scripts, exports, and other metadata that cannot affect installation
  src = runCommand "ai-dependency-manifests" { } ''
    mkdir -p "$out"
    cp ${../../../bun.lock} "$out/bun.lock"
    ${lib.strings.concatMapStringsSep "\n" (path: ''
      install -Dm644 ${dependencyManifest path} "$out"/${lib.strings.escapeShellArg path}
    '') manifestPaths}
    ${lib.strings.concatMapStringsSep "\n" (path: ''
      install -Dm644 ${../../.. + "/${path}"} "$out"/${lib.strings.escapeShellArg path}
    '') (builtins.attrValues manifest.patchedDependencies)}
  '';
  bunDeps = bun2nix.fetchBunDeps {
    # Local packages come from manifests in src rather than the package cache
    # Filter before extraction so foreign native binaries never enter the cache
    bunNix =
      args:
      lib.attrsets.filterAttrs forHost (callPackage ./bun.nix (args // { copyPathToStore = _: null; }));
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
  # Fix each output separately so runtime libraries never resolve into dev tools
  dontAutoPatchelf = true;
  postFixup = lib.strings.optionalString stdenv.hostPlatform.isLinux ''
    autoPatchelf -- "$out"
    autoPatchelf -- "$production"
  '';
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
  installPhase = ''
    runHook preInstall

    installDependencies() {
      local destination="$1"
      local root="$PWD/node_modules"
      local link target directory architecture onnx

      # Consumers provide their own workspace links and Sky declarations
      rm -rf ${lib.strings.escapeShellArgs (map (name: "node_modules/${name}") localNames)}
      rm -rf node_modules/@img/*linuxmusl* \
        node_modules/*-musl node_modules/@*/*-musl
      onnx="node_modules/onnxruntime-node/bin/napi-v6"
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

      # Remove nested local links and dangling workspace bins, not external bins
      while IFS= read -r -d "" link; do
        if [ ! -e "$link" ]; then
          rm -f "$link"
          continue
        fi
        target="$(readlink -f "$link")"
        case "$target" in
          "$root"/*) ;;
          *) rm -f "$link" ;;
        esac
      done < <(find "$root" -type l -print0)

      mkdir -p "$destination"
      mv node_modules "$destination/"
    }

    installDependencies "$out"
    # Bun does not prune an existing install when switching to production
    rm -rf ${
      lib.strings.escapeShellArgs (
        map (path: "${path}/node_modules") (manifest.workspaces.packages ++ [ "farstep/sky" ])
      )
    }
    bun install --production --frozen-lockfile --offline --ignore-scripts \
      --linker=hoisted --backend=copyfile
    installDependencies "$production"

    runHook postInstall
  '';
  passthru.workspaces = manifest.workspaces.packages;
  meta = {
    description = "Development and production JavaScript dependencies for AI tooling";
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
