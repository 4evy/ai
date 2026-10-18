function Invoke-DesktopRemoval {
  param(
    [Parameter(Mandatory)]
    [hashtable]$Installation
  )

  if (-not $Installation.Record) {
    return
  }
  & $Installation.Service uninstall $Installation.Owner.Value
  if ($LASTEXITCODE -ne 0) {
    throw 'Cannot remove the system service'
  }
  if ($Installation.Task) {
    Stop-ScheduledTask -TaskName $Installation.TaskName
    Unregister-ScheduledTask -TaskName $Installation.TaskName -Confirm:$false
  }
  foreach ($rule in $Installation.Record.firewallRules) {
    $existing = Get-NetFirewallRule -Name $rule -ErrorAction SilentlyContinue
    if ($existing -and $existing.Description -ne $Installation.Marker) {
      throw 'Refusing an unrelated firewall rule'
    }
    if ($existing) {
      Remove-NetFirewallRule -Name $rule
    }
  }
  Remove-Item -LiteralPath $Installation.RecordPath
}

function Initialize-DesktopFirewall {
  param(
    [Parameter(Mandatory)]
    [hashtable]$Installation,

    [Parameter(Mandatory)]
    [hashtable]$Change
  )

  foreach ($path in @($Installation.Desktop, $Installation.Runtime)) {
    $hash = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($path))
    $hash = $hash.Replace('=', '').Replace('/', '_').Replace('+', '-')
    foreach ($direction in @('Inbound', 'Outbound')) {
      $name = "Farstep-$($Installation.Owner.Value)-$hash-$direction"
      $existing = Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue
      if ($existing -and $existing.Description -ne $Installation.Marker) {
        throw 'Refusing an unrelated firewall rule'
      }
      if (-not $existing) {
        $firewall = @{
          Name        = $name
          DisplayName = "Farstep $direction"
          Description = $Installation.Marker
          Direction   = $direction
          Program     = $path
          Action      = 'Allow'
          Profile     = 'Any'
        }
        New-NetFirewallRule @firewall | Out-Null
        $Change.NewRules += $name
        $Change.Rules += $name
      }
    }
  }
}

function Register-DesktopTask {
  param(
    [Parameter(Mandatory)]
    [hashtable]$Installation
  )

  $taskAction = @{
    Execute          = $Installation.Desktop
    Argument         = 'daemon'
    WorkingDirectory = $Installation.PackagePath
  }
  $taskPrincipal = @{
    UserId    = $Installation.Owner.Value
    LogonType = 'Interactive'
    RunLevel  = 'Highest'
  }
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $Installation.Owner.Value
  $taskSettings = @{
    ExecutionTimeLimit         = [TimeSpan]::Zero
    AllowStartIfOnBatteries    = $true
    DontStopIfGoingOnBatteries = $true
    RestartCount               = 3
    RestartInterval            = New-TimeSpan -Minutes 1
  }
  $registration = @{
    TaskName    = $Installation.TaskName
    Action      = New-ScheduledTaskAction @taskAction
    Principal   = New-ScheduledTaskPrincipal @taskPrincipal
    Trigger     = $trigger
    Settings    = New-ScheduledTaskSettingsSet @taskSettings
    Description = $Installation.Marker
    Force       = $true
  }
  Register-ScheduledTask @registration | Out-Null
}

function Wait-DesktopReady {
  param(
    [Parameter(Mandatory)]
    [hashtable]$Installation
  )

  $connection = [IO.Pipes.NamedPipeClientStream]::new(
    '.', ('farstep-desktop-' + $Installation.Owner.Value), [IO.Pipes.PipeDirection]::InOut
  )
  try {
    $connection.Connect(30000)
  } finally {
    $connection.Dispose()
  }
}
