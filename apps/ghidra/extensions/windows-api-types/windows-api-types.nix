{
  lib,
  callPackage,
  fetchFromGitHub,
  aiUpdateScript,
}:
let
  pin = lib.trivial.importJSON ./source.json;
  buildHeaderExtension = callPackage ../header-extension.nix { };
  types = (lib.trivial.importJSON ../profiles.json).windows;
in
(buildHeaderExtension {
  pname = "ghidra-windows-api-types";
  inherit (pin) version;
  src = fetchFromGitHub {
    owner = "winsiderss";
    repo = "systeminformer";
    inherit (pin) rev hash;
  };
  inherit (types)
    extensionName
    description
    headersRoot
    licenseFile
    entryHeaders
    includePaths
    profiles
    ;
  homepage = "https://github.com/winsiderss/systeminformer/tree/master/phnt";
  license = lib.licenses.mit;
}).overrideAttrs
  {
    passthru.updateScript = aiUpdateScript {
      attrPath = "ghidra-windows-api-types";
      extraArgs = [
        "--version=branch=master"
        "--override-filename=apps/ghidra/extensions/windows-api-types/source.json"
      ];
      checkFiles = [ "apps/ghidra/extensions/windows-api-types/source.json" ];
    };
  }
