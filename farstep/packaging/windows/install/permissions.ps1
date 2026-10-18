function Protect-Path {
  param(
    [Parameter(Mandatory)]
    [string]$Path,

    [Parameter(Mandatory)]
    [Security.Principal.SecurityIdentifier]$Owner,

    [switch]$Directory
  )

  if ($Directory) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
  }
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Refusing a reparse point: $Path"
  }
  $acl = if ($Directory) {
    [Security.AccessControl.DirectorySecurity]::new()
  } else {
    [Security.AccessControl.FileSecurity]::new()
  }
  $acl.SetOwner($Owner)
  $acl.SetAccessRuleProtection($true, $false)
  $owners = @($Owner, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))
  foreach ($account in $owners) {
    $rule = if ($Directory) {
      [Security.AccessControl.FileSystemAccessRule]::new(
        $account, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'
      )
    } else {
      [Security.AccessControl.FileSystemAccessRule]::new($account, 'FullControl', 'Allow')
    }
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
}

function Initialize-InstallationIdentity {
  param(
    [Parameter(Mandatory)]
    [hashtable]$Installation
  )

  $identityPath = Join-Path $Installation.State 'installation.json'
  if (-not (Test-Path -LiteralPath $identityPath)) {
    $record = @{ installationId = [guid]::NewGuid().ToString() }
    [IO.File]::WriteAllText(
      $identityPath, ($record | ConvertTo-Json -Compress),
      [Text.UTF8Encoding]::new($false)
    )
  }
  Protect-Path -Path $identityPath -Owner $Installation.Owner
}

function Save-InstallationRecord {
  param(
    [Parameter(Mandatory)]
    [hashtable]$Installation,

    [Parameter(Mandatory)]
    [hashtable]$Change
  )

  $metadata = Get-Content -LiteralPath (
    Join-Path $Installation.PackagePath 'share/farstep/manifest.json'
  ) -Raw | ConvertFrom-Json
  $record = @{
    version        = 1
    packagePath    = $Installation.PackagePath
    owner          = $Installation.Owner.Value
    taskName       = $Installation.TaskName
    firewallRules  = @($Change.Rules | Where-Object { $_ })
    manager        = $Installation.Manager
    packageVersion = $metadata.version
    productCode    = $metadata.productCode
  }
  [IO.File]::WriteAllText(
    $Installation.RecordPath, ($record | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false)
  )
  Protect-Path -Path $Installation.RecordPath -Owner $Installation.Owner
}
