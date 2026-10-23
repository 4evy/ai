{
  lib,
  stdenvNoCC,
  fetchFromGitHub,
  python3Packages,
  openjdk25,
  gradle,
  ghidra-bin,
  unzip,
  writeShellApplication,
  symlinkJoin,
  runCommand,
  coreutils,
  findutils,
  curl,
  aiUpdateScript,
  nix,
  jq,
  gnused,
  bun,
  uv,
  makeBinaryWrapper,
  desktopToDarwinBundle,
  apiTypeExtensions ? [ ],
  extraExtensions ? [ ],
}:
let
  bridgePython = python3Packages.overrideScope (
    _self: super: {
      mcp = super.mcp.overridePythonAttrs (old: {
        inherit (pin.sdk) version;
        src = fetchFromGitHub {
          owner = "modelcontextprotocol";
          repo = "python-sdk";
          tag = "v${pin.sdk.version}";
          inherit (pin.sdk) hash;
        };
        nativeCheckInputs = old.nativeCheckInputs ++ [ python3Packages.blockbuster ];
      });
    }
  );
  pin = lib.trivial.importJSON ./source.json;
  src = fetchFromGitHub {
    owner = "bethington";
    repo = "ghidra-mcp";
    inherit (pin) rev hash;
  };
  meta = {
    homepage = "https://github.com/bethington/ghidra-mcp";
    changelog = "https://github.com/bethington/ghidra-mcp/blob/${pin.rev}/CHANGELOG.md";
    license = lib.licenses.asl20;
    sourceProvenance = [ lib.sourceTypes.fromSource ];
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
      "aarch64-darwin"
    ];
    maintainers = [ lib.maintainers._4evy ];
  };
  bridgeApp = bridgePython.buildPythonApplication {
    pname = "ghidra-mcp-bridge";
    inherit (pin) version;
    inherit src;
    patches = map (name: ./. + "/${name}") pin.patches;
    postPatch = ''
      cp ${./uv.lock} uv.lock
    '';
    pyproject = true;
    strictDeps = true;
    build-system = [ bridgePython.hatchling ];
    dependencies = with bridgePython; [
      mcp
      pydantic
    ];
    pythonImportsCheck = [ "bridge_mcp_ghidra" ];
    doCheck = false;
    meta = meta // {
      mainProgram = "bridge-mcp-ghidra";
    };
  };
  extension = stdenvNoCC.mkDerivation {
    pname = "ghidra-mcp-extension";
    inherit (pin) version;
    inherit src;
    patches = map (name: ./. + "/${name}") pin.patches;
    nativeBuildInputs = [
      openjdk25
      gradle
      unzip
    ];
    postPatch = ''
      substituteInPlace build.gradle \
        --replace-fail "new Date().format('yyyyMMdd-HHmmss')" "'19700101-000000'"
      cat >> build.gradle <<'EOF'
      tasks.withType(AbstractArchiveTask).configureEach {
          preserveFileTimestamps = false
          reproducibleFileOrder = true
      }
      EOF
    '';
    buildPhase = ''
      runHook preBuild
      export GRADLE_USER_HOME="$TMPDIR/gradle"
      gradle --offline --no-daemon buildExtension \
        -PGHIDRA_INSTALL_DIR=${ghidra-bin}/lib/ghidra
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p "$out/lib/ghidra/Ghidra/Extensions"
      unzip build/distributions/*.zip -d "$out/lib/ghidra/Ghidra/Extensions"
      touch "$out/lib/ghidra/Ghidra/Extensions/GhidraMCP/.dbDirLock"
      runHook postInstall
    '';
    inherit meta;
  };
  server =
    runCommand "ghidra-mcp-headless-server-${pin.version}"
      {
        inherit (pin) version;
        meta = meta // {
          description = "Ghidra MCP headless Java server jar";
        };
      }
      ''
        mkdir -p "$out/share/java"
        cp ${extension}/lib/ghidra/Ghidra/Extensions/GhidraMCP/lib/*.jar "$out/share/java/"
      '';
  ghidra = symlinkJoin {
    name = "ghidra-with-extensions-${lib.getVersion ghidra-bin}";
    paths = [ extension ] ++ apiTypeExtensions ++ extraExtensions;
    nativeBuildInputs = [
      makeBinaryWrapper
    ]
    ++ lib.optional stdenvNoCC.hostPlatform.isDarwin desktopToDarwinBundle;
    postBuild = ''
      touch "$out/lib/ghidra/Ghidra/.dbDirLock"
      module_paths=""
      for module in "$out/lib/ghidra/Ghidra/Extensions/"*; do
        if [[ -f "$module/Module.manifest" ]]; then
          module_paths="''${module_paths:+$module_paths:}$module"
        fi
      done
      printf '%s\n' "$module_paths" > "$out/lib/ghidra/module-path"

      # Binary distributions use Ghidra's upstream external-module property
      for command in ghidra ghidra-analyzeHeadless; do
        makeWrapper "${ghidra-bin}/bin/$command" "$out/bin/$command" \
          --prefix JAVA_TOOL_OPTIONS " " "-Dghidra.external.modules=$module_paths"
      done
      ln -s ${ghidra-bin}/share "$out/share"
    ''
    + lib.optionalString stdenvNoCC.hostPlatform.isDarwin ''
      convertDesktopFiles $prefix
    '';
    inherit (ghidra-bin) meta;
  };
  privateShellApplication =
    args:
    let
      app = writeShellApplication args;
    in
    runCommand args.name { meta = removeAttrs app.meta [ "mainProgram" ]; } ''
      mkdir -p "$out/libexec"
      ln -s ${lib.meta.getExe app} "$out/libexec/${args.name}"
    '';
  httpd = privateShellApplication {
    name = "ghidra-mcp-httpd";
    meta = meta // {
      mainProgram = "ghidra-mcp-httpd";
    };
    runtimeInputs = [
      coreutils
      findutils
    ];
    runtimeEnv = {
      GHIDRA_HOME = "${ghidra-bin}/lib/ghidra";
      GHIDRA_MCP_MODULE_PATH_FILE = "${ghidra}/lib/ghidra/module-path";
      JAVA_HOME = openjdk25.home;
      GHIDRA_MCP_JAVA = lib.meta.getExe openjdk25;
      GHIDRA_MCP_JAR = "${server}/share/java/GhidraMCP-${pin.upstreamVersion}.jar";
    };
    text = builtins.readFile ./httpd.sh;
  };
  bridge = privateShellApplication {
    name = "ghidra-mcp-bridge";
    meta = meta // {
      mainProgram = "ghidra-mcp-bridge";
    };
    runtimeInputs = [ coreutils ];
    runtimeEnv.GHIDRA_MCP_BRIDGE = lib.meta.getExe bridgeApp;
    text = builtins.readFile ./bridge.sh;
  };
  headless = privateShellApplication {
    name = "ghidra-mcp-headless";
    meta = meta // {
      mainProgram = "ghidra-mcp-headless";
    };
    runtimeInputs = [
      coreutils
      curl
    ];
    runtimeEnv = {
      GHIDRA_MCP_HTTPD = "${httpd}/libexec/ghidra-mcp-httpd";
      GHIDRA_MCP_BRIDGE = "${bridge}/libexec/ghidra-mcp-bridge";
    };
    text = builtins.readFile ./headless.sh;
  };
in
symlinkJoin {
  name = "ghidra-mcp-${pin.version}";
  inherit (pin) version;
  paths = [
    bridge
    httpd
    headless
    ghidra
  ];
  passthru = {
    inherit
      bridge
      bridgeApp
      extension
      ghidra
      server
      httpd
      headless
      src
      apiTypeExtensions
      ;
    components = {
      inherit
        bridge
        extension
        ghidra
        server
        httpd
        headless
        ;
    };
    updateScript = aiUpdateScript {
      attrPath = "ghidra-mcp";
      extraArgs = [ "--override-filename=apps/ghidra/mcp/source.json" ];
      checkFiles = [
        "apps/ghidra/mcp/source.json"
        "apps/ghidra/mcp/uv.lock"
      ];
      runtimeInputs = [
        coreutils
        nix
        jq
        gnused
        bun
        uv
      ];
      beforeUpdate = ''
        set -- "--version=branch=''${GHIDRA_MCP_BRANCH:-main}" "$@"
      '';
      afterUpdate = builtins.readFile ./update.sh;
    };
    inherit (pin) rev;
  };
  meta = meta // {
    description = "Ghidra MCP headless backend, GUI extension, and stdio bridge";
  };
}
