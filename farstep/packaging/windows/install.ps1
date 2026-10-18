param(
  [Parameter(Mandatory)]
  [string]$PackagePath,

  [ValidateSet('install', 'upgrade', 'uninstall', 'activate')]
  [string]$Action = 'install',

  [ValidateSet('winget')]
  [string]$Manager,

  [string]$Owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($identity.User.Value -ne $Owner) {
  throw 'Farstep setup must run as the original Windows account'
}
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $quote = {
    param([string]$Text)
    "'" + $Text.Replace("'", "''") + "'"
  }
  $command = '& {0} -PackagePath {1} -Action {2} -Owner {3}' -f (
    (& $quote $PSCommandPath), (& $quote $PackagePath), (& $quote $Action), (& $quote $Owner)
  )
  if ($Manager) {
    $command += ' -Manager ' + (& $quote $Manager)
  }
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  $elevation = @{
    FilePath     = 'powershell.exe'
    Verb         = 'RunAs'
    ArgumentList = @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded
    )
    Wait         = $true
    PassThru     = $true
  }
  $child = Start-Process @elevation
  if ($child.ExitCode -ne 0) {
    throw "Elevated Farstep setup failed ($($child.ExitCode))"
  }
  exit 0
}
$sid = $identity.User
$root = Join-Path $env:LOCALAPPDATA 'Farstep'
$state = Join-Path $root 'state'
$recordPath = Join-Path $state 'installer.json'
$taskName = "Farstep-Desktop-$($sid.Value)"
$marker = "Farstep desktop v1 owner=$($sid.Value)"
$PackagePath = (Resolve-Path -LiteralPath $PackagePath).Path
$binary = Join-Path $PackagePath 'bin\farstep-desktop.exe'
$bun = Join-Path $PackagePath 'bin\bun.exe'
$system = Join-Path $PackagePath 'bin\farstep-service.exe'

foreach ($module in @('permissions.ps1', 'desktop.ps1', 'activation.ps1')) {
  . (Join-Path $PSScriptRoot "install/$module")
}

foreach ($path in @($root, $state, (Join-Path $root 'data'), (Join-Path $root 'runtime'))) {
  Protect-Path -Path $path -Directory -Owner $sid
}
$old = if (Test-Path -LiteralPath $recordPath) {
  Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
} else {
  $null
}
if ($Action -eq 'activate') {
  $Action = if ($old) { 'upgrade' } else { 'install' }
}
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task -and $task.Description -ne $marker) {
  throw 'Refusing an unrelated scheduled task'
}
if ($old -and $old.owner -ne $sid.Value) {
  throw 'Refusing an unrelated installation record'
}
if ($old) {
  Protect-Path -Path $recordPath -Owner $sid
}
$installation = @{
  Owner       = $sid
  PackagePath = $PackagePath
  State       = $state
  RecordPath  = $recordPath
  TaskName    = $taskName
  Marker      = $marker
  Desktop     = $binary
  Runtime     = $bun
  Service     = $system
  Record      = $old
  Task        = $task
  Manager     = $Manager
}
$lock = Join-Path $state 'maintenance.lock'
New-Item -ItemType Directory -Path $lock -ErrorAction Stop | Out-Null
try {
  Protect-Path -Path $lock -Directory -Owner $sid
  Assert-MaintenanceReady -Installation $installation
  if ($Action -eq 'uninstall') {
    Invoke-DesktopRemoval -Installation $installation
    exit 0
  }
  Invoke-DesktopInstallation -Installation $installation -Action $Action
  @{
    installed     = $true
    administrator = $true
    task          = $taskName
    defender      = 'unchanged'
    firewall      = 'allowed'
    packagePath   = $PackagePath
  } | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $lock -Recurse -Force
}
