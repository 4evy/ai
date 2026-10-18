{
  lib,
  stdenvNoCC,
  fetchzip,
  aiUpdateScript,
}:
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "PSScriptAnalyzer";
  version = "1.25.0";
  src = fetchzip {
    url = "https://github.com/PowerShell/PSScriptAnalyzer/releases/download/${finalAttrs.version}/PSScriptAnalyzer.${finalAttrs.version}.nupkg";
    hash = "sha256-OEyOGPyFatNo68Jlx1G8UOKQu83UScZMRQ3TlzKxjl0=";
    extension = "zip";
    stripRoot = false;
  };
  dontConfigure = true;
  dontBuild = true;
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/share/powershell/Modules/PSScriptAnalyzer"
    cp -a . "$out/share/powershell/Modules/PSScriptAnalyzer/${finalAttrs.version}"
    runHook postInstall
  '';
  passthru.updateScript = aiUpdateScript { attrPath = "powershell-analyzer"; };
  meta = {
    description = "PowerShell script analyzer and formatter";
    homepage = "https://github.com/PowerShell/PSScriptAnalyzer";
    license = lib.licenses.mit;
    platforms = lib.platforms.all;
    maintainers = [ lib.maintainers._4evy ];
  };
})
