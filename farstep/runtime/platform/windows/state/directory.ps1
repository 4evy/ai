$ErrorActionPreference = 'Stop'
$path = @PATH@
$item = Get-Item -LiteralPath $path -Force
if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
  throw 'Private directory is a reparse point'
}

$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$principals = @($sid, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))
foreach ($principal in $principals) {
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    $principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'
  )
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $path -AclObject $acl
