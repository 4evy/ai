$ErrorActionPreference = 'Stop'
$item = Get-Item -LiteralPath @PATH@ -Force
if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
  throw 'Private file is a reparse point'
}

$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl = Get-Acl -LiteralPath $item.FullName
$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
if ($owner -notin @($sid, 'S-1-5-32-544')) {
  throw 'Private file has an unrelated owner'
}

$allowedAccounts = @($sid, 'S-1-5-18')
$rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
foreach ($rule in $rules) {
  if ($rule.AccessControlType -eq 'Allow' -and
    $rule.IdentityReference.Value -notin $allowedAccounts) {
    throw 'Private file allows another account'
  }
}
if ($owner -ne $sid) {
  $acl.SetOwner([Security.Principal.SecurityIdentifier]::new($sid))
  Set-Acl -LiteralPath $item.FullName -AclObject $acl
}
