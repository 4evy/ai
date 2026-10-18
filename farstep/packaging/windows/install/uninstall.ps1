param()
$ErrorActionPreference = 'Stop'
if ($args.Count -gt 0) {
  throw 'Windows uninstall does not accept additional arguments'
}
$recordPath = Join-Path $env:LOCALAPPDATA 'Farstep/state/installer.json'
if (Test-Path -LiteralPath $recordPath) {
  $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
  if ($record.manager -ne 'winget') {
    $null = & (Join-Path $record.packagePath 'share/farstep/install.ps1') `
      -PackagePath $record.packagePath -Action uninstall
    if ($LASTEXITCODE -eq 0) {
      @{ installed = $false; platform = 'win32' } | ConvertTo-Json -Compress
    }
    exit $LASTEXITCODE
  }
}
$productCode = if ($record.productCode) {
  $record.productCode
} elseif (-not $record -and $env:FARSTEP_PACKAGE_PATH) {
  (Get-Content -LiteralPath (
    Join-Path $env:FARSTEP_PACKAGE_PATH 'share/farstep/manifest.json'
  ) -Raw | ConvertFrom-Json).productCode
} else {
  'Farstep_is1'
}
if (-not $productCode) {
  throw 'Cannot identify the installed Farstep package'
}
# Run outside the packaged Bun process so the uninstaller can remove it
$output = & winget.exe uninstall --product-code $productCode --exact `
  --silent --accept-source-agreements --disable-interactivity
if ($LASTEXITCODE -ne 0) {
  throw "WinGet uninstall failed ($LASTEXITCODE): $($output -join [Environment]::NewLine)"
}
@{ installed = $false; platform = 'win32'; manager = 'winget' } | ConvertTo-Json -Compress
