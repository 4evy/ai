{ pkgs, analyzer }:
pkgs.writeShellApplication {
  name = "format-powershell";
  runtimeInputs = [
    pkgs.powershell
    pkgs.ripgrep
  ];
  inheritPath = false;
  runtimeEnv.PSModulePath = "${analyzer}/share/powershell/Modules";
  text = ''
    if (( $# == 0 )); then
      exit 0
    fi
    exec ${pkgs.lib.getExe pkgs.powershell} \
      -NoLogo -NoProfile -NonInteractive \
      -File "$PWD/tools/scripts/powershell/powershell.ps1" -FormatOnly "$@"
  '';
}
