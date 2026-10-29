{ bun2nix }:
pkgs:
let
  ghidraNative = pkgs.lib.trivial.importJSON ../../../apps/ghidra/native/source.json;
  bunTools = bun2nix.packages.${pkgs.stdenv.hostPlatform.system}.default.overrideAttrs (old: {
    # Bun 1.4 keeps the package records compatible but advances the lock version
    postPatch = (old.postPatch or "") + ''
      substituteInPlace src/lib.rs \
        --replace-fail 'if lockfile.lockfile_version != 1 {' \
          'if !(1..=2).contains(&lockfile.lockfile_version) {'
    '';
    meta = old.meta // {
      description = "Converter from Bun lockfiles to Nix expressions";
      maintainers = [ pkgs.lib.maintainers._4evy ];
    };
  });
  chatgptSource =
    pkgs.lib.lists.findFirst (artifact: artifact.platform == "darwin" && artifact.arch == "arm64")
      (throw "The ChatGPT macOS archive is missing")
      (pkgs.lib.trivial.importJSON ../../../farstep/runtime/sky/runtime/pins.json).artifacts;
  scope = pkgs.lib.makeScope pkgs.newScope (
    self:
    {
      aiUpdateScript = self.callPackage ../update/update.nix { };
      bun = self.callPackage ../javascript/runtime/runtime.nix {
        inherit (pkgs) bun;
      };
      bun2nix = bunTools;
      ai-javascript-dependencies = self.callPackage ../javascript/dependencies.nix { };
      ai-shared = self.callPackage ../javascript/shared.nix { };
      ai-javascript = self.callPackage ../javascript/javascript.nix { };
      ghidra-bin = (pkgs.ghidra-bin.override { openjdk21 = pkgs.openjdk25; }).overrideAttrs (old: {
        inherit (ghidraNative.ghidra) version;
        versiondate = pkgs.lib.strings.removeSuffix ".zip" (
          pkgs.lib.lists.last (pkgs.lib.strings.splitString "_" ghidraNative.ghidra.url)
        );
        src = pkgs.fetchurl {
          inherit (ghidraNative.ghidra) url sha256;
        };
        nativeBuildInputs = old.nativeBuildInputs ++ [ pkgs.unzip ];
      });
      gradle = pkgs.gradle-packages.mkGradle {
        inherit (ghidraNative.gradle) version;
        hash = builtins.convertHash {
          hash = ghidraNative.gradle.sha256;
          hashAlgo = "sha256";
          toHashFormat = "sri";
        };
        defaultJava = pkgs.openjdk25;
      };
      ghidra-apple-api-types =
        self.callPackage ../../../apps/ghidra/extensions/apple-api-types/apple-api-types.nix
          { };
      ghidra-windows-api-types =
        self.callPackage ../../../apps/ghidra/extensions/windows-api-types/windows-api-types.nix
          { };
      ghidra-mcp = self.callPackage ../../../apps/ghidra/mcp/package.nix {
        apiTypeExtensions = [
          self.ghidra-apple-api-types
          self.ghidra-windows-api-types
        ];
      };
      farstep-desktop = self.callPackage ../../../farstep/nix/native.nix { };
      farstep-service = self.callPackage ../../../farstep/nix/service.nix { };
      farstep-javascript = self.callPackage ../../../farstep/nix/javascript.nix { };
      farstep-modules = self.farstep-javascript.modules;
      ai-app-modules = self.ai-javascript.modules;
      ai-tools = self.callPackage ../../runtime/runtime.nix { };
      farstep = self.callPackage ../../../farstep {
        farstep-sky = self.farstep-sky or null;
      };
      ghidra-mcp-bridge = self.ghidra-mcp.bridge;
      ghidra-mcp-headless-server = self.ghidra-mcp.server;
      ghidra-mcp-httpd = self.ghidra-mcp.httpd;
      ghidra-mcp-headless = self.ghidra-mcp.headless;
      ghidra-mcp-extension = self.ghidra-mcp.extension;
      powershell-analyzer = self.callPackage ../fmt/analyzer.nix { };
    }
    // pkgs.lib.attrsets.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
      farstep-extensions = self.callPackage ../../../farstep/nix/extensions.nix { };
      farstep-kde-bridge = self.callPackage ../../../farstep/nix/bridge.nix { };
    }
    //
      pkgs.lib.attrsets.optionalAttrs
        (builtins.elem pkgs.stdenv.hostPlatform.system [
          "x86_64-linux"
          "aarch64-darwin"
        ])
        {
          farstep-sky = self.callPackage ../../../farstep/nix/sky.nix { chatgpt = pkgs.chatgpt; };
        }
    // pkgs.lib.attrsets.optionalAttrs (pkgs.lib.meta.availableOn pkgs.stdenv.hostPlatform chatgpt) {
      inherit chatgpt;
    }
  );
  chatgpt = pkgs.chatgpt.overrideAttrs (old: {
    version = pkgs.lib.strings.removeSuffix ".zip" (
      pkgs.lib.strings.removePrefix "https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-arm64-" chatgptSource.url
    );
    src = pkgs.fetchurl {
      inherit (chatgptSource) url;
      sha256 = chatgptSource.sha256;
    };
    passthru = old.passthru // {
      updateScript = scope.aiUpdateScript {
        attrPath = "chatgpt";
        extraArgs = [
          "--system=aarch64-darwin"
          "--override-filename=farstep/runtime/sky/runtime/pins.json"
        ];
        runtimeInputs = [
          scope.bun
          pkgs.jq
          pkgs.curl
          pkgs.unzip
          pkgs.gnutar
        ];
        beforeUpdate = builtins.readFile ../update/chatgpt.sh;
        afterUpdate = ''
          bun install --ignore-scripts
          bun tools/scripts/sky/update.ts
        '';
      };
    };
    meta = old.meta // {
      maintainers = [ pkgs.lib.maintainers._4evy ];
      platforms = [ "aarch64-darwin" ];
      mainDarwinApp = "ChatGPT.app";
    };
  });
in
# Keep the public package set limited to derivations, without scope helpers
removeAttrs (scope.packages scope) [
  "aiUpdateScript"
  "ghidra-bin"
  "gradle"
]
