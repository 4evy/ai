function Assert-MaintenanceReady {
  param(
    [Parameter(Mandatory)]
    [hashtable]$Installation
  )

  if ($Installation.Record -and $Installation.Task -and $Installation.Task.State -eq 'Running') {
    $status = & (Join-Path $Installation.Record.packagePath 'bin\farstep.cmd') status | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or -not $status.desktop) {
      throw 'Cannot verify desktop health before maintenance'
    }
    if ($status.desktop.controlLeaseActive -or $status.desktop.sessions -gt 0) {
      throw 'Release desktop sessions before maintenance'
    }
    if ($status.desktop.systemCommands -gt 0) {
      throw 'Wait for system commands before maintenance'
    }
  }
}

function Restore-DesktopInstallation {
  param(
    [Parameter(Mandatory)]
    [hashtable]$Installation,

    [Parameter(Mandatory)]
    [hashtable]$Change
  )

  foreach ($rule in $Change.NewRules) {
    Remove-NetFirewallRule -Name $rule -ErrorAction SilentlyContinue
  }
  if ($Change.Activated) {
    Stop-ScheduledTask -TaskName $Installation.TaskName -ErrorAction SilentlyContinue
    if ($Change.OriginalTask) {
      Register-ScheduledTask -TaskName $Installation.TaskName -Xml $Change.OriginalTask -Force | Out-Null
      [IO.File]::WriteAllText(
        $Installation.RecordPath, ($Installation.Record | ConvertTo-Json -Depth 4),
        [Text.UTF8Encoding]::new($false)
      )
      Protect-Path -Path $Installation.RecordPath -Owner $Installation.Owner
      Start-ScheduledTask -TaskName $Installation.TaskName
    } else {
      $removal = @{
        TaskName    = $Installation.TaskName
        Confirm     = $false
        ErrorAction = 'SilentlyContinue'
      }
      Unregister-ScheduledTask @removal
      Remove-Item -LiteralPath $Installation.RecordPath -ErrorAction SilentlyContinue
    }
  } elseif ($Installation.Task) {
    Start-ScheduledTask -TaskName $Installation.TaskName
  }
}

function Invoke-DesktopInstallation {
  param(
    [Parameter(Mandatory)]
    [hashtable]$Installation,

    [Parameter(Mandatory)]
    [ValidateSet('install', 'upgrade')]
    [string]$Action
  )

  $policy = @{
    install = @{
      Installed = $false
      Error     = 'Farstep is already installed; use upgrade'
    }
    upgrade = @{
      Installed = $true
      Error     = 'Farstep is not installed; use install'
    }
  }[$Action]
  if ([bool]$Installation.Record -ne $policy.Installed) {
    throw $policy.Error
  }
  foreach ($path in @($Installation.Desktop, $Installation.Runtime, $Installation.Service)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Package lacks executable: $path"
    }
  }
  Initialize-InstallationIdentity -Installation $Installation
  # Share mutation state explicitly so partial firewall creation can be undone
  $change = @{
    Rules        = @($Installation.Record.firewallRules)
    NewRules     = @()
    OriginalTask = if ($Installation.Task) {
      Export-ScheduledTask -TaskName $Installation.TaskName
    } else {
      $null
    }
    Activated    = $false
  }
  try {
    Initialize-DesktopFirewall -Installation $Installation -Change $change
    if ($Installation.Task) {
      Stop-ScheduledTask -TaskName $Installation.TaskName
    }
    & $Installation.Service install $Installation.Owner.Value
    if ($LASTEXITCODE -ne 0) {
      throw 'Cannot install the system service'
    }
    Register-DesktopTask -Installation $Installation
    $change.Activated = $true
    Save-InstallationRecord -Installation $Installation -Change $change
    Start-ScheduledTask -TaskName $Installation.TaskName
    Wait-DesktopReady -Installation $Installation
  } catch {
    Restore-DesktopInstallation -Installation $Installation -Change $change
    throw
  }
}
