param(
  [string]$Owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($identity.User.Value -ne $Owner) {
  throw 'WinGet setup must run as the original Windows account'
}
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $command = '& ' + "'" + $PSCommandPath.Replace("'", "''") + "' -Owner '$Owner'"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  $elevation = @{
    FilePath     = 'powershell.exe'
    Verb         = 'RunAs'
    ArgumentList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded)
    Wait         = $true
    PassThru     = $true
  }
  $child = Start-Process @elevation
  if ($child.ExitCode -ne 0) {
    throw "Cannot enable local WinGet manifests ($($child.ExitCode))"
  }
  exit 0
}
& winget.exe settings --enable LocalManifestFiles --disable-interactivity
if ($LASTEXITCODE -ne 0) {
  throw "Cannot enable local WinGet manifests ($LASTEXITCODE)"
}
