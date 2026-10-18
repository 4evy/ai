$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
& ([scriptblock]::Create([Console]::In.ReadToEnd()))
$success = $?
if ($null -ne $LASTEXITCODE) {
  exit $LASTEXITCODE
}
if (-not $success) {
  exit 1
}
