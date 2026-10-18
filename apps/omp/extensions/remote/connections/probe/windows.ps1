$ErrorActionPreference = 'Stop'
$directory = @DIRECTORY@
if ($directory -eq '~') {
  $directory = $env:USERPROFILE
} elseif ($directory.StartsWith('~/') -or $directory.StartsWith('~\')) {
  $directory = Join-Path $env:USERPROFILE $directory.Substring(2)
}

$resolved = (Resolve-Path -LiteralPath $directory).Path
if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
  throw 'Remote cwd is not a directory'
}
@{
  home = $env:USERPROFILE
  cwd  = $resolved
  bash = 'powershell.exe'
  arch = $env:PROCESSOR_ARCHITECTURE
} | ConvertTo-Json -Compress
