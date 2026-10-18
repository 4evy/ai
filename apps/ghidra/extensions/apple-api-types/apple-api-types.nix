{
  lib,
  callPackage,
  fetchFromGitHub,
  aiUpdateScript,
}:
let
  pin = lib.trivial.importJSON ./source.json;
  buildHeaderExtension = callPackage ../header-extension.nix { };
  types = (lib.trivial.importJSON ../profiles.json).apple;
in
(buildHeaderExtension {
  pname = "ghidra-apple-api-types";
  inherit (pin) version;
  src = fetchFromGitHub {
    owner = "PoomSmart";
    repo = "IDAObjcTypes";
    inherit (pin) rev hash;
  };
  # Empty include paths let nested Types.h imports resolve to their own files
  inherit (types)
    extensionName
    description
    headersRoot
    licenseFile
    entryHeaders
    includePaths
    profiles
    ;
  homepage = "https://github.com/PoomSmart/IDAObjcTypes";
  license = [
    lib.licenses.mit
    lib.licenses.bsd2
  ];
  patches = [ ./lp64-types.patch ];
}).overrideAttrs
  {
    passthru.updateScript = aiUpdateScript {
      attrPath = "ghidra-apple-api-types";
      extraArgs = [
        "--version=branch=master"
        "--override-filename=apps/ghidra/extensions/apple-api-types/source.json"
      ];
      checkFiles = [ "apps/ghidra/extensions/apple-api-types/source.json" ];
    };
  }
