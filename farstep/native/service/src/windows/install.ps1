param(
  [Parameter(Mandatory)]
  [string]$Binary,

  [Parameter(Mandatory)]
  [string]$Owner,

  [Parameter(Mandatory)]
  [ValidateSet('install', 'uninstall')]
  [string]$Action
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Security.Principal.SecurityIdentifier]::new($Owner) | Out-Null
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $elevation = @{
    FilePath     = $Binary
    Verb         = 'RunAs'
    ArgumentList = $Action, $Owner
    Wait         = $true
    PassThru     = $true
  }
  $child = Start-Process @elevation
  if ($child.ExitCode -ne 0) {
    throw "Elevated service setup failed ($($child.ExitCode))"
  }
  exit 0
}
$name = "Farstep-System-$Owner"
$marker = "Farstep system service v1 owner=$Owner"
$directory = Join-Path $env:ProgramData "Farstep\service-$Owner"
$destination = Join-Path $directory 'farstep-service.exe'
$serviceCommand = "`"$destination`" run $Owner"
$service = Get-CimInstance -ClassName Win32_Service -Filter "Name='$name'"
if ($service -and ($service.Description -ne $marker -or
    $service.PathName -ne $serviceCommand -or
    $service.StartName -ne 'LocalSystem')) {
  throw 'Refusing an unrelated system service'
}
function Assert-Directory {
  param(
    [Parameter(Mandatory)]
    [string]$Path
  )

  $item = Get-Item -LiteralPath $Path -Force
  if (-not $item.PSIsContainer -or
    ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Refusing an unrelated service path: $Path"
  }
  $acl = Get-Acl -LiteralPath $Path
  $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  $allowedAccounts = @('S-1-5-18', 'S-1-5-32-544')
  if ($ownerSid -notin $allowedAccounts) {
    throw "Untrusted directory owner: $Path"
  }
  $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -eq 'Allow' -and
      $rule.IdentityReference.Value -notin $allowedAccounts -and
      ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Write)) {
      throw "Service directory is writable by another account: $Path"
    }
  }
}
function Initialize-Directory {
  param(
    [Parameter(Mandatory)]
    [string]$Path
  )

  if (Test-Path -LiteralPath $Path) {
    Assert-Directory -Path $Path
    return
  }
  New-Item -ItemType Directory -Path $Path | Out-Null
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
    $principal = [Security.Principal.SecurityIdentifier]::new($sid)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'
    )
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
}
if (Test-Path -LiteralPath $directory) {
  Assert-Directory $directory
  $ownerFile = Join-Path $directory 'owner'
  if (-not (Test-Path -LiteralPath $ownerFile -PathType Leaf) -or
    (Get-Content -LiteralPath $ownerFile -Raw) -ne $marker) {
    throw 'Refusing an unrelated service installation'
  }
}
if ($service) {
  $process = if ($service.ProcessId) {
    Get-Process -Id $service.ProcessId -ErrorAction SilentlyContinue
  } else {
    $null
  }
  Stop-Service -Name $name -ErrorAction Stop
  (Get-Service -Name $name).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
  if ($process -and -not $process.WaitForExit(30000)) {
    throw 'System service process did not exit'
  }
}
if ($Action -eq 'uninstall') {
  if ($service) {
    & sc.exe delete $name | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw 'Cannot delete the system service'
    }
  }
  if (Test-Path -LiteralPath $directory) {
    Remove-Item -LiteralPath $directory -Recurse -Force
  }
  exit 0
}
Initialize-Directory -Path (Join-Path $env:ProgramData 'Farstep')
Initialize-Directory -Path $directory
$backup = if (Test-Path -LiteralPath $destination) {
  [IO.File]::ReadAllBytes($destination)
} else {
  $null
}
try {
  Copy-Item -LiteralPath $Binary -Destination $destination -Force
  [IO.File]::WriteAllText((Join-Path $directory 'owner'), $marker)
  if (-not $service) {
    $registration = @{
      Name           = $name
      DisplayName    = 'Farstep privileged system service'
      BinaryPathName = $serviceCommand
      StartupType    = 'Automatic'
      Description    = $marker
    }
    New-Service @registration | Out-Null
  } else {
    Set-Service -Name $name -StartupType Automatic
  }
  $recovery = @(
    'failure', $name, 'reset=', '86400',
    'actions=', 'restart/2000/restart/5000/restart/10000'
  )
  & sc.exe @recovery | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw 'Cannot configure service recovery'
  }
  & sc.exe failureflag $name 1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw 'Cannot configure service failure reporting'
  }
  Start-Service -Name $name
  (Get-Service -Name $name).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
} catch {
  Stop-Service -Name $name -ErrorAction SilentlyContinue
  if ($backup) {
    [IO.File]::WriteAllBytes($destination, $backup)
    if ($service) {
      Start-Service -Name $name
    }
  } else {
    & sc.exe delete $name | Out-Null
    Remove-Item -LiteralPath $directory -Recurse -Force
  }
  throw
}
