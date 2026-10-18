{
  lib,
  stdenvNoCC,
  bun,
  makeBinaryWrapper,
  ai-javascript,
  ghidra-mcp,
  nix,
  bash,
  curl,
  git,
  gnutar,
  patch,
  unzip,
  zstd,
  stdenv,
}:
let
  runtimePath = lib.strings.makeBinPath [
    bun
    nix
    bash
    curl
    git
    gnutar
    patch
    unzip
    zstd
  ];
  nativeLibraries = lib.strings.makeLibraryPath [
    stdenv.cc.cc.lib
    zstd
  ];
  launchers = {
    codex = "apps/codex/codex";
    claude = "apps/claude/claude";
    opencode = "apps/opencode/opencode";
    omp = "tools/scripts/omp/runtime/launch";
  };
in
stdenvNoCC.mkDerivation {
  pname = "ai-tools";
  inherit (lib.trivial.importJSON ./package.json) version;
  dontUnpack = true;
  dontConfigure = true;
  dontBuild = true;
  nativeBuildInputs = [ makeBinaryWrapper ];
  strictDeps = true;
  installPhase = ''
    runHook preInstall
    root="$out/lib/ai-tools"
    mkdir -p "$out/lib" "$out/bin"
    ln -s ${ai-javascript} "$root"
    makeWrapper ${lib.meta.getExe bun} "$out/bin/ai" \
      --add-flag "$root/tools/scripts/cli/cli.js" \
      --set AI_TOOLS_SUFFIX js \
      --set AI_TOOLS_WRAPPER_BIN "$out/bin/ai" \
      --set-default CODEX_CLI_PATH "$out/bin/codex" \
      --prefix PATH : ${lib.strings.escapeShellArg runtimePath} \
      --set-default GHIDRA_MCP_PACKAGE ${ghidra-mcp} \
      ${lib.strings.optionalString stdenv.hostPlatform.isLinux "--prefix LD_LIBRARY_PATH : ${lib.strings.escapeShellArg nativeLibraries} --prefix NIX_LD_LIBRARY_PATH : ${lib.strings.escapeShellArg nativeLibraries}"}
    ${lib.strings.concatMapAttrsStringSep "\n" (name: script: ''
      makeWrapper ${lib.meta.getExe bun} "$out/bin/${name}" \
        --add-flag "$root/${script}.js" \
        --set AI_TOOLS_SUFFIX js \
        --set DISABLE_AUTOUPDATER 1 \
        --set OPENCODE_DISABLE_AUTOUPDATE true \
        --set AI_TOOLS_WRAPPER_BIN "$out/bin/${name}" \
        --prefix PATH : ${lib.strings.escapeShellArg runtimePath} \
        ${lib.strings.optionalString stdenv.hostPlatform.isLinux "--prefix NIX_LD_LIBRARY_PATH : ${lib.strings.escapeShellArg nativeLibraries}"} \
        ${lib.strings.optionalString (
          stdenv.hostPlatform.isLinux && name == "omp"
        ) "--prefix LD_LIBRARY_PATH : ${lib.strings.escapeShellArg nativeLibraries}"}
    '') launchers}
    runHook postInstall
  '';
  meta = {
    description = "AI launchers, browser helpers, and coding agent extensions";
    homepage = "https://github.com/4evy/ai";
    license = lib.licenses.mit;
    inherit (ai-javascript.meta) sourceProvenance platforms;
    maintainers = [ lib.maintainers._4evy ];
    mainProgram = "ai";
  };
}
