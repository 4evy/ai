{
  lib,
  stdenv,
  fetchurl,
  rpm,
  cpio,
  unzip,
  autoPatchelfHook,
  chatgpt,
  nodejs-slim_24,
}:
let
  pins = lib.trivial.importJSON ../runtime/sky/runtime/pins.json;
  artifact = lib.lists.findFirst (
    entry:
    entry.platform == stdenv.hostPlatform.node.platform && entry.arch == stdenv.hostPlatform.node.arch
  ) (throw "No Sky runtime for this platform") pins.artifacts;
  linux = stdenv.hostPlatform.isLinux;
in
stdenv.mkDerivation {
  pname = "farstep-sky";
  inherit (pins) version;
  src = fetchurl { inherit (artifact) url sha256; };
  nativeBuildInputs =
    if linux then
      [
        rpm
        cpio
        autoPatchelfHook
      ]
    else
      [ unzip ];
  buildInputs = lib.lists.optionals linux chatgpt.buildInputs;
  runtimeDependencies = lib.lists.optionals linux chatgpt.runtimeDependencies;
  dontConfigure = true;
  dontBuild = true;
  dontStrip = true;
  dontWrapQtApps = true;
  dontWrapGApps = true;
  unpackPhase =
    if linux then
      ''
        mkdir source
        cd source
        rpm2cpio "$src" | cpio --extract --make-directories --quiet \
          --no-absolute-filenames './usr/lib/chatgpt/resources/cua_node/*'
      ''
    else
      ''
        unzip -q "$src"
      '';
  installPhase = ''
    runHook preInstall
    mkdir -p "$out"/${lib.strings.escapeShellArg artifact.resources}
    cp -R ${lib.strings.escapeShellArg artifact.resources}/cua_node "$out"/${lib.strings.escapeShellArg artifact.resources}/
    ${lib.strings.optionalString linux ''
      ln -sf ${lib.meta.getExe nodejs-slim_24} "$out"/${lib.strings.escapeShellArg artifact.resources}/cua_node/bin/node
    ''}
    ${lib.strings.optionalString (!linux) ''
      cp -R ${lib.strings.escapeShellArg artifact.resources}/codex-cli "$out"/${lib.strings.escapeShellArg artifact.resources}/
    ''}
    cp ${
      builtins.toFile "sky-receipt.json" (
        builtins.toJSON {
          version = pins.version;
          inherit artifact;
        }
      )
    } "$out/complete.json"
    runHook postInstall
  '';
  meta = {
    description = "Pinned Sky computer-use runtime";
    license = lib.licenses.unfree;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
    platforms = [
      "x86_64-linux"
      "aarch64-darwin"
    ];
  };
}
