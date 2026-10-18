#Requires -Version 5.1
#Requires -Modules @{ ModuleName = 'PSScriptAnalyzer'; ModuleVersion = '1.25.0' }

param(
  [switch]$Check,
  [switch]$FormatOnly,
  [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
  [string[]]$Paths
)

$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$settings = Join-Path $PSScriptRoot 'settings.psd1'
$failed = $false
$count = 0
$formatOnlyMode = $FormatOnly -and -not $Check
$placeholder = '@([A-Z][A-Z0-9_]*)@'
$expression = "'__POWERSHELL_TEMPLATE_`$1__'"
$renderedPlaceholder = "'__POWERSHELL_TEMPLATE_([A-Z][A-Z0-9_]*)__'"

Push-Location -LiteralPath $root
try {
  $files = $Paths
  if (-not $PSBoundParameters.ContainsKey('Paths')) {
    $files = & rg --files --hidden -g '*.ps1' -g '*.psm1' -g '*.psd1'
    if ($LASTEXITCODE -ne 0) {
      throw 'Cannot discover PowerShell files with rg'
    }
  }

  foreach ($path in $files) {
    $fullPath = if ([IO.Path]::IsPathRooted($path)) {
      $path
    } else {
      Join-Path $root $path
    }
    $source = [IO.File]::ReadAllText($fullPath)
    $sourcePlaceholders = [regex]::Matches($source, $placeholder)
    # Render template expressions before parsing, then restore them after formatting
    $rendered = $source -replace $placeholder, $expression
    $tokens = $null
    $parseErrors = $null
    $null = [Management.Automation.Language.Parser]::ParseInput(
      $rendered, [ref]$tokens, [ref]$parseErrors
    )
    if ($parseErrors) {
      foreach ($diagnostic in $parseErrors) {
        $line = $diagnostic.Extent.StartLineNumber
        Write-Warning "${path}:${line}: $($diagnostic.Message)"
      }
      if ($formatOnlyMode) {
        throw "${path}: PowerShell parsing failed"
      }
      $failed = $true
      continue
    }

    $formatted = Invoke-Formatter -ScriptDefinition $rendered -Settings $settings
    $formatted = $formatted -replace $renderedPlaceholder, '@$1@'
    $formatted = ($formatted -replace "`r`n", "`n").TrimEnd() + "`n"
    $formattedPlaceholders = [regex]::Matches($formatted, $placeholder)
    if ($sourcePlaceholders.Count -ne $formattedPlaceholders.Count) {
      throw "${path}: template placeholder restoration failed"
    }
    for ($index = 0; $index -lt $sourcePlaceholders.Count; $index++) {
      if ($sourcePlaceholders[$index].Value -cne $formattedPlaceholders[$index].Value) {
        throw "${path}: template placeholder restoration failed"
      }
    }

    $analysis = $formatted -replace $placeholder, $expression
    $null = [Management.Automation.Language.Parser]::ParseInput(
      $analysis, [ref]$tokens, [ref]$parseErrors
    )
    if ($parseErrors) {
      foreach ($diagnostic in $parseErrors) {
        $line = $diagnostic.Extent.StartLineNumber
        Write-Warning "${path}:${line}: $($diagnostic.Message)"
      }
      if ($formatOnlyMode) {
        throw "${path}: formatted PowerShell parsing failed"
      }
      $failed = $true
      continue
    }

    if ($formatted -cne $source) {
      if ($Check) {
        Write-Warning "${path}: formatting differs; run just fmt powershell"
        $failed = $true
      } else {
        [IO.File]::WriteAllText(
          $fullPath, $formatted, [Text.UTF8Encoding]::new($false)
        )
        Write-Output "Formatted $path"
      }
    }

    if (-not $formatOnlyMode) {
      $diagnostics = Invoke-ScriptAnalyzer -ScriptDefinition $analysis -Settings $settings
      foreach ($diagnostic in $diagnostics) {
        $location = "${path}:$($diagnostic.Line)"
        Write-Warning "${location}: $($diagnostic.RuleName): $($diagnostic.Message)"
        $failed = $true
      }
    }
    $count++
  }
} finally {
  Pop-Location
}

if ($failed) {
  throw 'PowerShell checks failed'
}
if ($formatOnlyMode) {
  Write-Output "Formatted $count PowerShell files"
} else {
  Write-Output "Checked $count PowerShell files"
}
