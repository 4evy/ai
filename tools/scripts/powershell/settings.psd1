@{
  IncludeDefaultRules = $true
  Rules               = @{
    PSPlaceOpenBrace           = @{
      Enable             = $true
      OnSameLine         = $true
      NewLineAfter       = $true
      IgnoreOneLineBlock = $true
    }
    PSPlaceCloseBrace          = @{
      Enable             = $true
      NewLineAfter       = $false
      IgnoreOneLineBlock = $true
      NoEmptyLineBefore  = $true
    }
    PSUseConsistentIndentation = @{
      Enable              = $true
      Kind                = 'space'
      IndentationSize     = 2
      PipelineIndentation = 'IncreaseIndentationForFirstPipeline'
    }
    PSUseConsistentWhitespace  = @{
      Enable                                  = $true
      CheckInnerBrace                         = $true
      CheckOpenBrace                          = $true
      CheckOpenParen                          = $true
      CheckOperator                           = $true
      CheckPipe                               = $true
      CheckSeparator                          = $true
      IgnoreAssignmentOperatorInsideHashTable = $true
    }
    PSAlignAssignmentStatement = @{
      Enable         = $true
      CheckHashtable = $true
    }
    PSUseCorrectCasing         = @{
      Enable        = $true
      # Cached command metadata can fail across analyzer runspaces
      CheckCommands = $false
    }
    PSUseCompatibleSyntax      = @{
      Enable         = $true
      TargetVersions = @('5.1', '7.0')
    }
  }
}
