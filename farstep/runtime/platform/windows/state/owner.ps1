$ErrorActionPreference = 'Stop'
$path = @PATH@
$acl = Get-Acl -LiteralPath $path
$acl.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User)
Set-Acl -LiteralPath $path -AclObject $acl
