<#
.SYNOPSIS
  Drover agent access for a Windows 10/11 PC: OpenSSH Server, local admin "agent",
  key-only login, and a reverse tunnel to the VPS (127.0.0.1:2223 on the VPS).

.DESCRIPTION
  Run in an ELEVATED Windows PowerShell (Run as administrator):

    Set-ExecutionPolicy -Scope Process Bypass
    .\install.ps1 -VpsHost <VPS address> -AgentKeyFile .\agents_ed25519.pub

  Copy agents_ed25519.pub (the Mac's public key) next to this script first.
  Agents get FULL control of this PC (local administrator); that is intentional.

  What it does
   1. Installs and starts the built-in OpenSSH Server (sshd, automatic start).
      Default shell is set EXPLICITLY to Windows PowerShell (see -DefaultShell).
   2. Creates the local administrator "agent" (random password nobody sees;
      key login only; hidden from the sign-in screen).
   3. Writes the Mac's key to C:\ProgramData\ssh\administrators_authorized_keys
      (the file sshd uses for members of Administrators) with the ACL sshd demands.
   4. sshd_config: PasswordAuthentication no (backup + `sshd -t` + automatic rollback).
   5. The inbound "OpenSSH-Server-In-TCP" firewall rule is DISABLED (the tunnel only
      needs localhost:22); -KeepLanSsh keeps it.
   6. Tunnel: scheduled task "DroverTunnel" as SYSTEM at boot (no sign-in needed),
      running a retry loop around the built-in ssh.exe; restarts on failure.
      Its key lives in C:\ProgramData\drover-tunnel, readable by SYSTEM/Administrators only.

  Re-running is safe. Nothing here connects to the VPS except ssh-keyscan (host key
  fingerprint, which you must confirm) and the tunnel itself.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$VpsHost,
  [Parameter(Mandatory)][string]$AgentKeyFile,
  [string]$VpsUser = 'bridge-pc',
  [ValidateRange(1,65535)][int]$VpsPort = 22,
  [string]$DefaultShell = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe',
  [switch]$KeepPasswordLogin,
  [switch]$KeepLanSsh,
  [switch]$KeyLoginConfirmed,
  [switch]$VerifyLocalKeyLogin,
  [string]$TunnelKeyFile,
  [string]$VpsKnownHostsFile,
  [switch]$NoStart,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$TunnelPort = 2223
$Dir        = 'C:\ProgramData\drover-tunnel'
$SshDir     = 'C:\ProgramData\ssh'
$SshExe     = 'C:\Windows\System32\OpenSSH\ssh.exe'
$Keygen     = 'C:\Windows\System32\OpenSSH\ssh-keygen.exe'
$Keyscan    = 'C:\Windows\System32\OpenSSH\ssh-keyscan.exe'
$SidSystem  = '*S-1-5-18'        # NT AUTHORITY\SYSTEM
$SidAdmins  = '*S-1-5-32-544'    # BUILTIN\Administrators

function Say($m)  { Write-Host $m }
function Warn($m) { Write-Warning $m }
function Die($m)  { throw $m }

# Fresh DACLs, not /grant on an inherited or attacker-controlled ACL.
function Assert-NoReparse([string]$Path) {
  $p = [IO.Path]::GetFullPath($Path)
  while ($p) {
    # Inspect the entry itself, including dangling links; Test-Path may follow
    # their target and incorrectly classify a reparse point as a missing file.
    $entry = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
    if ($entry -and ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { Die "Reparse point refused: $p" }
    $parent = Split-Path -Path $p -Parent
    if ($parent -eq $p) { break }
    $p = $parent
  }
}
function Get-SafeChildren([string]$Path) {
  foreach ($child in @(Get-ChildItem -LiteralPath $Path -Force)) {
    Assert-NoReparse $child.FullName
    $child
    if ($child.PSIsContainer) { Get-SafeChildren $child.FullName }
  }
}
function Invoke-Icacls([string[]]$Arguments) {
  & icacls.exe @Arguments | Out-Null
  if ($LASTEXITCODE -ne 0) { Die "icacls failed: $($Arguments -join ' ')" }
}
function Set-PrivateAcl([string]$Path) {
  Assert-NoReparse $Path
  $item = Get-Item -LiteralPath $Path -Force
  $system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
  $admins = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
  if ($item.PSIsContainer) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $flags = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  } else {
    $acl = New-Object Security.AccessControl.FileSecurity
    $flags = [Security.AccessControl.InheritanceFlags]::None
  }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($system, $admins)) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $flags, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
  }
  # /setowner may require privileges enabled by icacls; check its own exit code.
  Invoke-Icacls -Arguments @($Path, '/setowner', $SidSystem)
  Set-Acl -LiteralPath $Path -AclObject $acl
  $actual = Get-Acl -LiteralPath $Path
  $owner = $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value
  $rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($owner -ne 'S-1-5-18' -or -not $actual.AreAccessRulesProtected -or $rules.Count -ne 2) { Die "Exact ACL verification failed: $Path" }
  foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
    $matching = @($rules | Where-Object { $_.IdentityReference.Value -eq $sid -and -not $_.IsInherited -and $_.AccessControlType -eq 'Allow' -and $_.FileSystemRights -eq 'FullControl' -and $_.InheritanceFlags -eq $flags -and $_.PropagationFlags -eq 'None' })
    if ($matching.Count -ne 1) { Die "Unexpected DACL entry on $Path" }
  }
}
function Assert-SshDirectoryTrusted {
  Assert-NoReparse $SshDir
  if (-not (Test-Path -LiteralPath $SshDir)) { return }
  $acl = Get-Acl -LiteralPath $SshDir
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  $actor = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $trusted = @('S-1-5-18', 'S-1-5-32-544', $actor)
  if ($owner -notin $trusted) { Die "Untrusted owner on $SshDir; inspect the SSH directory before installing." }
  $danger = [Security.AccessControl.FileSystemRights]'Write, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership'
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trusted -and ($rule.FileSystemRights -band $danger)) {
      # Even inherited/InheritOnly grants can permit deletion/replacement of
      # children. Do not trust files that were writable by an unrelated user.
      Die "Unsafe SSH parent DACL ($($rule.IdentityReference.Value)); inspect files and fix permissions before installing."
    }
  }
}
function Secure-SshDirectory {
  Assert-SshDirectoryTrusted
  New-Item -ItemType Directory -Path $SshDir -Force | Out-Null
  # Freeze the parent before reading config/authorized_keys or starting sshd.
  Set-PrivateAcl $SshDir
  foreach ($child in @(Get-SafeChildren $SshDir)) { Set-PrivateAcl $child.FullName }
  # Set-PrivateAcl verifies the exact protected DACL and SYSTEM ownership.
  Assert-SshDirectoryTrusted
}
function Start-CheckedTunnelTask {
  Start-ScheduledTask -TaskName DroverTunnel -TaskPath '\' -ErrorAction Stop
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    $task = Get-ManagedTunnelTask
    if ($task -and $task.State -eq 'Running') { return }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  Die 'DroverTunnel did not reach Running state after Start-ScheduledTask.'
}
function Get-ManagedTunnelTask {
  try { $task = Get-ScheduledTask -TaskName DroverTunnel -TaskPath '\' -ErrorAction Stop }
  catch {
    if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { return $null }
    throw # Access/query errors must not be mistaken for a first installation.
  }
  if (-not $task) { return $null }
  $loopFile = Join-Path $Dir 'tunnel.ps1'
  $execute = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
  if ($task.Principal.UserId -notin @('SYSTEM', 'S-1-5-18', 'NT AUTHORITY\SYSTEM') -or $task.Actions.Count -ne 1 -or $task.Actions[0].Execute -ne $execute -or $task.Actions[0].Arguments -ne "-NoProfile -ExecutionPolicy Bypass -File `"$loopFile`"") { Die 'Existing DroverTunnel is not the task managed by this script.' }
  return $task
}
function Restore-TunnelInstallation([string]$Backup, [bool]$HadScript, [bool]$HadConfig, [bool]$HadTask) {
  # Also stop a new task whose start succeeded before a later error was detected.
  Stop-TunnelTask
  $loopFile = Join-Path $Dir 'tunnel.ps1'
  $configFile = Join-Path $Dir 'ssh_config'
  foreach ($entry in @(@($loopFile, 'tunnel.ps1', $HadScript), @($configFile, 'ssh_config', $HadConfig))) {
    Assert-NoReparse $entry[0]
    if ($entry[2]) {
      $bytes = [IO.File]::ReadAllBytes((Join-Path $Backup $entry[1]))
      [IO.File]::WriteAllBytes($entry[0], $bytes)
      Set-PrivateAcl $entry[0]
      if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($entry[0])) -cne [Convert]::ToBase64String($bytes)) { Die "Restored file verification failed: $($entry[0])" }
    } elseif (Test-Path -LiteralPath $entry[0]) { Remove-Item -LiteralPath $entry[0] -Force }
  }
  if ($HadTask) {
    $xml = [IO.File]::ReadAllText((Join-Path $Backup 'task.xml'))
    Register-ScheduledTask -TaskName DroverTunnel -TaskPath '\' -Xml $xml -Force -ErrorAction Stop | Out-Null
    if (-not (Get-ManagedTunnelTask)) { Die 'Registered DroverTunnel is missing.' }
    Start-CheckedTunnelTask
  } elseif (Get-ManagedTunnelTask) {
    Unregister-ScheduledTask -TaskName DroverTunnel -TaskPath '\' -Confirm:$false -ErrorAction Stop
  }
}

function Get-KeyFingerprint([string]$Line) {
  # Ask OpenSSH to parse the entire authorized_keys line, including its options.
  # Never look for a key body among words in a comment.
  $tmp = [IO.Path]::GetTempFileName()
  try {
    [IO.File]::WriteAllText($tmp, $Line + "`n", (New-Object Text.UTF8Encoding $false))
    $previousPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue' # invalid/comment lines must be preserved, not terminate PS 5.1
      $output = @(& $Keygen -lf $tmp -E sha256 2>$null)
      $keyExitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($keyExitCode -ne 0 -or $output.Count -ne 1 -or $output[0] -notmatch '^\d+\s+(SHA256:\S+)\s') { return $null }
    return $Matches[1]
  } finally { Remove-Item -LiteralPath $tmp -Force }
}
function Test-AgentKeyLogin {
  # A real fresh SSH login, not a fingerprint check. Only a temporary local
  # test key is used; the Mac's private agents key is never distributed.
  $testDir = Join-Path $SshDir ('drover-login-test-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $testDir | Out-Null
  Set-PrivateAcl $testDir
  $testKey = Join-Path $testDir 'key'
  $testFingerprint = $null
  try {
    $p = Start-Process -FilePath $Keygen -PassThru -Wait -NoNewWindow -ArgumentList ('-q -t ed25519 -N "" -f "{0}"' -f $testKey)
    if ($p.ExitCode -ne 0) { Die 'Could not generate the temporary login-test key.' }
    Set-PrivateAcl $testKey
    $testPublic = [IO.File]::ReadAllText("$testKey.pub").Trim()
    $testFingerprint = Get-KeyFingerprint $testPublic
    if (-not $testFingerprint) { Die 'Invalid login-test public key.' }
    [IO.File]::AppendAllText($akFile, "`nrestrict $testPublic drover-local-login-test`n", (New-Object Text.UTF8Encoding $false))
    $hostKey = Join-Path $SshDir 'ssh_host_ed25519_key.pub'
    if (-not (Test-Path -LiteralPath $hostKey)) { Die 'Local ed25519 SSH host key is missing.' }
    $hostParts = ([IO.File]::ReadAllText($hostKey).Trim() -split '\s+')
    $localKnown = Join-Path $testDir 'known_hosts'
    [IO.File]::WriteAllText($localKnown, "127.0.0.1 $($hostParts[0]) $($hostParts[1])`n", (New-Object Text.UTF8Encoding $false))
    $emptyConfig = Join-Path $testDir 'ssh_config'
    [IO.File]::WriteAllText($emptyConfig, '# isolated local login test')
    $remoteCode = '$p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent()); if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 41 }; if ([Security.Principal.WindowsIdentity]::GetCurrent().Name -notmatch "\\agent$") { exit 42 }; exit 0'
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($remoteCode))
    $arguments = '-F "{0}" -i "{1}" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile={2}" -o ConnectTimeout=10 -o ConnectionAttempts=1 agent@127.0.0.1 "powershell.exe -NoProfile -NonInteractive -EncodedCommand {3}"' -f $emptyConfig, $testKey, $localKnown, $encoded
    $p = Start-Process -FilePath $SshExe -PassThru -NoNewWindow -ArgumentList $arguments
    if (-not $p.WaitForExit(30000)) { $p.Kill(); Die 'Local agent key login timed out.' }
    if ($p.ExitCode -ne 0) { Die "Fresh local key login as administrator agent failed (SSH exit $($p.ExitCode)). Password/LAN hardening refused." }
    Say 'verified a fresh local SSH key login as administrator agent'
  } finally {
    if ($testFingerprint) {
      $keptKeys = @(Get-Content -LiteralPath $akFile | Where-Object { (Get-KeyFingerprint $_) -cne $testFingerprint })
      [IO.File]::WriteAllLines($akFile, [string[]]$keptKeys, (New-Object Text.UTF8Encoding $false))
      Set-PrivateAcl $akFile
    }
    if (Test-Path -LiteralPath $testDir) { Remove-Item -LiteralPath $testDir -Recurse -Force }
  }
}
function Stop-TunnelTask {
  $task = Get-ManagedTunnelTask
  if (-not $task) { return }
  $loopFile = Join-Path $Dir 'tunnel.ps1'
  # Task Scheduler can leave the child ssh.exe alive. Capture this task's process
  # tree and creation times, then kill descendants as well (no global ssh kill).
  $all = @(Get-CimInstance Win32_Process)
  $roots = @($all | Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -match ('(?i)-File\s+"' + [regex]::Escape($loopFile) + '"\s*$') })
  $tree = @($roots)
  $front = @($roots)
  while ($front.Count) {
    $ids = @($front | ForEach-Object { $_.ProcessId })
    $front = @($all | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin @($tree | ForEach-Object { $_.ProcessId }) })
    $tree += $front
  }
  foreach ($proc in $tree) {
    $owner = Invoke-CimMethod -InputObject $proc -MethodName GetOwnerSid
    if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne 'S-1-5-18') { Die 'Refusing to stop a non-SYSTEM tunnel process.' }
  }
  Stop-ScheduledTask -TaskName DroverTunnel -TaskPath '\'
  [array]::Reverse($tree)
  foreach ($proc in $tree) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.ProcessId)"
    if ($current -and $current.CreationDate -eq $proc.CreationDate) {
      try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop }
      catch {
        $remaining = Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.ProcessId)"
        if ($remaining -and $remaining.CreationDate -eq $proc.CreationDate) { throw }
      }
    }
  }
}

# ---- checks ------------------------------------------------------------------
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Die 'Run this script as administrator.' }
if ($VpsHost -notmatch '^[A-Za-z0-9.:-]+$')       { Die '-VpsHost: unexpected characters.' }
if ($VpsUser -notmatch '^[a-z_][a-z0-9_-]*$')      { Die '-VpsUser: unexpected characters.' }
if (-not (Test-Path -LiteralPath $AgentKeyFile))   { Die "Cannot read $AgentKeyFile" }
if (-not (Test-Path -LiteralPath $DefaultShell))   { Die "DefaultShell not found: $DefaultShell" }
foreach ($inputPath in @($TunnelKeyFile, $VpsKnownHostsFile)) {
  if ($inputPath) {
    Assert-NoReparse $inputPath
    if (-not (Test-Path -LiteralPath $inputPath -PathType Leaf)) { Die "Cannot read provisioned input: $inputPath" }
  }
}
if ($TunnelKeyFile -and -not (Test-Path -LiteralPath "$TunnelKeyFile.pub" -PathType Leaf)) { Die 'Provisioned tunnel public key is missing.' }

$AgentMarker = 'Drover managed agent v1 (key login only)'
$existingAgent = Get-LocalUser -Name agent -ErrorAction SilentlyContinue
if ($existingAgent -and $existingAgent.Description -ne $AgentMarker) { Die "Existing user agent is not script-owned; refusing to change it." }
if (-not (Test-Path -LiteralPath $Keygen)) { Die 'OpenSSH Client/ssh-keygen is required before installation.' }
if ($TunnelKeyFile) {
  Assert-NoReparse "$TunnelKeyFile.pub"
  $suppliedFingerprint = Get-KeyFingerprint ([IO.File]::ReadAllText("$TunnelKeyFile.pub"))
  if (-not $suppliedFingerprint) { Die 'Invalid provisioned tunnel public key.' }
  $derived = [IO.Path]::GetTempFileName()
  try {
    $p = Start-Process -FilePath $Keygen -PassThru -Wait -NoNewWindow -RedirectStandardOutput $derived -ArgumentList ('-y -P "" -f "{0}"' -f $TunnelKeyFile)
    if ($p.ExitCode -ne 0 -or (Get-KeyFingerprint ([IO.File]::ReadAllText($derived))) -cne $suppliedFingerprint) { Die 'Invalid/encrypted provisioned private key or mismatched public key.' }
  } finally { Remove-Item -LiteralPath $derived -Force }
  $existingTunnelKey = Join-Path $Dir 'id_ed25519'
  if (Test-Path -LiteralPath $existingTunnelKey) {
    Assert-NoReparse "$existingTunnelKey.pub"
    if (-not (Test-Path -LiteralPath "$existingTunnelKey.pub") -or (Get-KeyFingerprint ([IO.File]::ReadAllText("$existingTunnelKey.pub"))) -cne $suppliedFingerprint) { Die 'Existing tunnel key differs from provisioned key; no system settings changed.' }
  }
}
if ($VpsKnownHostsFile) {
  & $Keygen -lf $VpsKnownHostsFile | Out-Null
  if ($LASTEXITCODE -ne 0) { Die 'Invalid provisioned known_hosts file.' }
  $vpsHostAlias = if ($VpsPort -eq 22) { $VpsHost } else { "[$VpsHost]:$VpsPort" }
  & $Keygen -F $vpsHostAlias -f $VpsKnownHostsFile | Out-Null
  if ($LASTEXITCODE -ne 0) { Die 'Provisioned known_hosts has no VPS entry.' }
}
# Check all SYSTEM-used paths and their existing children before modifying them.
foreach ($path in @($Dir, $SshDir, (Join-Path $SshDir 'administrators_authorized_keys'), (Join-Path $SshDir 'sshd_config'), (Join-Path $SshDir 'sshd_config.drover-bak'))) { Assert-NoReparse $path }
Assert-SshDirectoryTrusted
if (Test-Path -LiteralPath $Dir) {
  foreach ($child in @(Get-SafeChildren $Dir)) { Assert-NoReparse $child.FullName }
}

$keyLines = @(Get-Content -LiteralPath $AgentKeyFile | Where-Object { $_.Trim() })
if ($keyLines.Count -ne 1) { Die "$AgentKeyFile must contain exactly one public key." }
$keyParts = $keyLines[0].Trim() -split '\s+'
if ($keyParts.Count -lt 2 -or $keyParts[0] -notmatch '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+|sk-\S+)$') { Die 'That is not a single-line OpenSSH public key.' }

$agentFingerprint = Get-KeyFingerprint $keyLines[0]
if (-not $agentFingerprint) { Die 'ssh-keygen rejected the supplied public key.' }

if (-not $Yes) {
  Say "Will enable OpenSSH Server, create local administrator 'agent', install the agents' key,"
  Say ("  " + $(if ($KeepPasswordLogin) { 'keep' } else { 'DISABLE' }) + " password login in sshd, and install a boot-time tunnel to $VpsUser@${VpsHost}:$VpsPort (VPS port 127.0.0.1:$TunnelPort).")
  Say 'Keep your current access to this PC until you have tested a key login.'
  if ((Read-Host 'Continue? [y/N]') -notmatch '^[yY]$') { Die 'Aborted.' }
}

Secure-SshDirectory

# ---- 1. OpenSSH Server ---------------------------------------------------------
$cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1
if ($cap.State -ne 'Installed') { Say 'Installing OpenSSH Server (needs Windows Update access) ...'; Add-WindowsCapability -Online -Name $cap.Name | Out-Null }
Secure-SshDirectory # Recheck files/ACLs created by capability installation before service start.
if (-not (Test-Path $SshExe)) { Die 'OpenSSH client (ssh.exe) is missing; install the "OpenSSH Client" optional feature.' }
Set-Service -Name sshd -StartupType Automatic
if ((Get-Service sshd).Status -ne 'Running') { Start-Service sshd }   # first start generates host keys

# Default shell for SSH logins: explicit PowerShell.
New-Item -Path 'HKLM:\SOFTWARE\OpenSSH' -Force | Out-Null
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value $DefaultShell -PropertyType String -Force | Out-Null
Say "sshd default shell: $DefaultShell"

# ---- 2. local administrator "agent" ----------------------------------------------
function New-RandomPassword {
  $chars = (48..57) + (65..90) + (97..122) + [char[]]'!@#$%^&*-_=+'
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $bytes = New-Object byte[] 40; $rng.GetBytes($bytes)
  -join ($bytes | ForEach-Object { [char]$chars[$_ % $chars.Count] })
}
$adminsGroup = (Get-LocalGroup -SID 'S-1-5-32-544').Name
$currentAgent = Get-LocalUser -Name agent -ErrorAction SilentlyContinue
if ($currentAgent -and $currentAgent.Description -ne $AgentMarker) { Die 'User agent changed since preflight; refusing to change it.' }
if (-not $currentAgent) {
  $pw = ConvertTo-SecureString (New-RandomPassword) -AsPlainText -Force
  New-LocalUser -Name agent -Password $pw -PasswordNeverExpires -AccountNeverExpires -Description $AgentMarker | Out-Null
  Say 'created local user agent (random password, never shown; reset with: net user agent *)'
} else { Say 'user agent exists (script-owned)' }
if (-not (Get-LocalGroupMember -Group $adminsGroup -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*\agent' })) {
  Add-LocalGroupMember -Group $adminsGroup -Member agent
}
# Hide from the sign-in screen.
$sp = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList'
New-Item -Path $sp -Force | Out-Null
New-ItemProperty -Path $sp -Name agent -Value 0 -PropertyType DWord -Force | Out-Null

# ---- 3. authorized key for administrators -------------------------------------------
$akFile = Join-Path $SshDir 'administrators_authorized_keys'
$body = $keyParts[1]
$existing = @()
if (Test-Path -LiteralPath $akFile) { Set-PrivateAcl $akFile; $existing = @(Get-Content -LiteralPath $akFile) }
# Replace only the same parsed key; preserve blank/comment/invalid/other lines.
$kept = @($existing | Where-Object { (Get-KeyFingerprint $_) -cne $agentFingerprint })
$newLines = $kept + ("{0} {1} drover-agents" -f $keyParts[0], $body)
$tmpAk = "$akFile.new"
Assert-NoReparse $tmpAk
if (Test-Path -LiteralPath $tmpAk) { Die "Temporary key file already exists: $tmpAk; inspect/remove it before retrying." }
New-Item -ItemType File -Path $tmpAk | Out-Null
Set-PrivateAcl $tmpAk
[IO.File]::WriteAllLines($tmpAk, [string[]]$newLines, (New-Object Text.UTF8Encoding $false))
Set-PrivateAcl $tmpAk
Move-Item -LiteralPath $tmpAk -Destination $akFile -Force
Set-PrivateAcl $akFile
Say "key installed in $akFile (ACL: SYSTEM + Administrators only)"

# A parsed key is not proof that a fresh login works. --Yes never skips this.
$localLoginVerified = $false
if ($VerifyLocalKeyLogin) { Test-AgentKeyLogin; $localLoginVerified = $true }
if ((-not $KeepPasswordLogin -or -not $KeepLanSsh) -and -not $KeyLoginConfirmed -and -not $localLoginVerified) {
  Say 'From another terminal/Mac, confirm a NEW public-key login as agent now.'
  if ((Read-Host 'Type KEY LOGIN VERIFIED after successful login (or abort and use -KeepPasswordLogin -KeepLanSsh)') -cne 'KEY LOGIN VERIFIED') { Die 'Hardening refused: new key login is not confirmed.' }
}

# ---- 4. sshd_config: key-only login (backup, syntax check, rollback) ---------------------
$cfg = Join-Path $SshDir 'sshd_config'
if (-not $KeepPasswordLogin) {
  $bak = "$cfg.drover-bak"
  if (-not (Test-Path $bak)) { Copy-Item -LiteralPath $cfg -Destination $bak }
  $lines = @(Get-Content -LiteralPath $cfg)
  $drop = '^\s*(PasswordAuthentication|KbdInteractiveAuthentication|PubkeyAuthentication)\s'
  $lines = @($lines | Where-Object { $_ -notmatch $drop })
  $firstMatch = ($lines | Select-String -Pattern '^\s*Match\s' | Select-Object -First 1)
  $block = @('# drover: public-key login only', 'PubkeyAuthentication yes', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no')
  if ($firstMatch) {
    $i = $firstMatch.LineNumber - 1
    $lines = if ($i -eq 0) { $block + $lines } else { @($lines[0..($i-1)]) + $block + @($lines[$i..($lines.Count-1)]) }
  }
  else             { $lines = $lines + $block }
  $previousConfigBytes = [IO.File]::ReadAllBytes($cfg)
  $cfgNew = "$cfg.drover-new"
  Assert-NoReparse $cfgNew
  if (Test-Path -LiteralPath $cfgNew) { Die "Stale candidate $cfgNew; inspect/remove before retrying." }
  New-Item -ItemType File -Path $cfgNew | Out-Null
  Set-PrivateAcl $cfgNew
  [IO.File]::WriteAllLines($cfgNew, [string[]]$lines, (New-Object Text.UTF8Encoding $false))
  & "$env:WINDIR\System32\OpenSSH\sshd.exe" -t -f $cfgNew
  if ($LASTEXITCODE -ne 0) {
    Remove-Item -LiteralPath $cfgNew -Force
    Die 'sshd -t rejected the candidate; live sshd_config unchanged.'
  }
  $restoreSnapshot = Join-Path $SshDir ('sshd_config.restore-' + [guid]::NewGuid().ToString('N'))
  [IO.File]::WriteAllBytes($restoreSnapshot, $previousConfigBytes)
  Set-PrivateAcl $restoreSnapshot
  try {
    Move-Item -LiteralPath $cfgNew -Destination $cfg -Force
    Restart-Service sshd -ErrorAction Stop
    if ((Get-Service sshd -ErrorAction Stop).Status -ne 'Running') { Die 'sshd did not reach Running state.' }
  } catch {
    $restartFailure = $_.Exception.Message
    try {
      Assert-NoReparse $cfg
      [IO.File]::WriteAllBytes($cfg, $previousConfigBytes)
      if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($cfg)) -cne [Convert]::ToBase64String($previousConfigBytes)) { Die 'Restored sshd_config differs from its snapshot.' }
      Set-PrivateAcl $cfg
      & "$env:WINDIR\System32\OpenSSH\sshd.exe" -t -f $cfg
      if ($LASTEXITCODE -ne 0) { Die 'Restored sshd_config failed sshd -t.' }
      Restart-Service sshd -ErrorAction Stop
      if ((Get-Service sshd -ErrorAction Stop).Status -ne 'Running') { Die 'Restored sshd did not reach Running state.' }
    } catch {
      Die "sshd restart failed ($restartFailure); restoration/restart also failed ($($_.Exception.Message)). Snapshot: $restoreSnapshot; manual recovery required."
    }
    Die "sshd restart failed ($restartFailure); previous config verified, restored and sshd running."
  }
  try { Remove-Item -LiteralPath $restoreSnapshot -Force -ErrorAction Stop }
  catch { Warn "sshd running; snapshot retained: $restoreSnapshot" }
  Say 'sshd: password login OFF (backup: sshd_config.drover-bak)'
} else { Warn 'password login left as it was (-KeepPasswordLogin)' }

if ($VerifyLocalKeyLogin) { Test-AgentKeyLogin }

# ---- 5. firewall: sshd is only needed on localhost for the tunnel -------------------------
if (-not $KeepLanSsh) {
  Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue | Disable-NetFirewallRule
  Say 'inbound rule OpenSSH-Server-In-TCP disabled (sshd reachable only through the tunnel)'
}

# ---- 6. tunnel -------------------------------------------------------------------------------
# Secure the directory and EVERY existing file before writing a SYSTEM script.
New-Item -ItemType Directory -Path $Dir -Force | Out-Null
Set-PrivateAcl $Dir
foreach ($child in @(Get-SafeChildren $Dir)) { Set-PrivateAcl $child.FullName }
$key = Join-Path $Dir 'id_ed25519'
$kh  = Join-Path $Dir 'known_hosts'
$cfgEmpty = Join-Path $Dir 'ssh_config'

if ($TunnelKeyFile) {
  $suppliedFingerprint = Get-KeyFingerprint ([IO.File]::ReadAllText("$TunnelKeyFile.pub"))
  if (-not $suppliedFingerprint) { Die 'Invalid provisioned tunnel public key.' }
  if (Test-Path -LiteralPath $key) {
    if (-not (Test-Path -LiteralPath "$key.pub") -or (Get-KeyFingerprint ([IO.File]::ReadAllText("$key.pub"))) -cne $suppliedFingerprint) {
      Die 'Existing tunnel key differs from the provisioned key; refusing to replace a running installation.'
    }
  } else {
    # Destination inherits the already protected tunnel-directory DACL.
    [IO.File]::WriteAllBytes($key, [IO.File]::ReadAllBytes($TunnelKeyFile))
    [IO.File]::WriteAllBytes("$key.pub", [IO.File]::ReadAllBytes("$TunnelKeyFile.pub"))
  }
}
if (-not (Test-Path $key)) {
  # Start-Process so the empty passphrase survives both Windows PowerShell and PowerShell 7.
  $keyProcess = Start-Process -FilePath $Keygen -PassThru -Wait -NoNewWindow -ArgumentList ('-q -t ed25519 -N "" -C "tunnel-pc@{0}" -f "{1}"' -f $env:COMPUTERNAME, $key)
  if ($keyProcess.ExitCode -ne 0 -or -not (Test-Path $key)) { Die 'ssh-keygen failed' }
}
# Existing private keys receive the same exact ACL, not only newly generated ones.
Set-PrivateAcl $key
# Preserve an empty -P argument in Windows PowerShell 5.1 too; reject encrypted
# keys instead of prompting (the SYSTEM tunnel cannot unlock them at boot).
$derivedFile = Join-Path $Dir ("derived-" + [guid]::NewGuid().ToString('N') + '.pub')
$deriveProcess = Start-Process -FilePath $Keygen -PassThru -Wait -NoNewWindow -RedirectStandardOutput $derivedFile -ArgumentList ('-y -P "" -f "{0}"' -f $key)
try {
  if ($deriveProcess.ExitCode -ne 0) { Die 'Invalid/encrypted existing tunnel private key.' }
  $derivedPublic = Get-Content -LiteralPath $derivedFile -Raw
} finally { Remove-Item -LiteralPath $derivedFile -Force }
$derivedFingerprint = Get-KeyFingerprint ($derivedPublic -join "`n")
if (-not $derivedFingerprint -or (Get-KeyFingerprint (Get-Content -LiteralPath "$key.pub" -Raw)) -cne $derivedFingerprint) { Die 'Tunnel public key does not match private key.' }
Set-PrivateAcl "$key.pub"

if ($VpsKnownHostsFile) {
  & $Keygen -lf $VpsKnownHostsFile | Out-Null
  if ($LASTEXITCODE -ne 0) { Die 'Invalid provisioned known_hosts file.' }
  & $Keygen -F $(if ($VpsPort -eq 22) { $VpsHost } else { "[$VpsHost]:$VpsPort" }) -f $VpsKnownHostsFile | Out-Null
  if ($LASTEXITCODE -ne 0) { Die 'Provisioned known_hosts has no entry for the VPS.' }
  [IO.File]::WriteAllBytes($kh, [IO.File]::ReadAllBytes($VpsKnownHostsFile))
}
if (-not (Test-Path $kh) -or -not (Get-Content $kh -ErrorAction SilentlyContinue)) {
  Say 'Fetching the VPS host key ...'
  $scan = & $Keyscan -T 10 -p $VpsPort -t ed25519 $VpsHost 2>$null
  if (-not $scan) { Die "Could not fetch an ed25519 host key from ${VpsHost}:$VpsPort" }
  $tmpScan = Join-Path $Dir 'scan.tmp'
  Set-Content -LiteralPath $tmpScan -Value $scan -Encoding ASCII
  & $Keygen -lf $tmpScan
  if ($LASTEXITCODE -ne 0) { Die 'ssh-keygen rejected scanned host key.' }
  Set-PrivateAcl $tmpScan
  Say 'Compare with the VPS:  ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub'
  if ((Read-Host 'Does it match? [y/N]') -notmatch '^[yY]$') { Remove-Item $tmpScan -Force; Die 'Aborted before installing the tunnel.' }
  Move-Item -LiteralPath $tmpScan -Destination $kh -Force
}

Set-PrivateAcl $kh
& $Keygen -lf $kh | Out-Null
if ($LASTEXITCODE -ne 0) { Die 'Invalid known_hosts file.' }

# Retry loop run by the scheduled task. The last ssh error stays in tunnel.log.
$loop = @"
`$ErrorActionPreference = 'Continue'
`$log = '$Dir\tunnel.log'
while (`$true) {
  Start-Process -FilePath '$SshExe' -Wait -NoNewWindow -RedirectStandardError `$log -ArgumentList @(
    '-F','$cfgEmpty','-N','-T',
    '-R','127.0.0.1:${TunnelPort}:localhost:22',
    '-p','$VpsPort','-i','$key',
    '-o','IdentitiesOnly=yes','-o','BatchMode=yes',
    '-o','ServerAliveInterval=30','-o','ServerAliveCountMax=3',
    '-o','ExitOnForwardFailure=yes','-o','StrictHostKeyChecking=yes',
    '-o','UserKnownHostsFile=$kh','-o','LogLevel=ERROR',
    '$VpsUser@$VpsHost')
  Start-Sleep -Seconds 10
}
"@
$loopFile = Join-Path $Dir 'tunnel.ps1'
$loopCandidate = Join-Path $Dir 'tunnel.new.ps1'
Assert-NoReparse $loopCandidate
Set-Content -LiteralPath $loopCandidate -Value $loop -Encoding UTF8
Set-PrivateAcl $loopCandidate
$parseTokens = $null; $parseErrors = $null
[Management.Automation.Language.Parser]::ParseFile($loopCandidate, [ref]$parseTokens, [ref]$parseErrors) | Out-Null
if ($parseErrors.Count) { Die 'Generated tunnel script failed PowerShell parsing.' }
# Snapshot before stopping/replacing anything. Backup files live in the secured
# tunnel directory and remain available if rollback itself fails.
$previousTask = Get-ManagedTunnelTask
$hadTask = $null -ne $previousTask
$hadScript = Test-Path -LiteralPath $loopFile
$hadConfig = Test-Path -LiteralPath $cfgEmpty
if ($hadTask -and -not $hadScript) { Die 'Existing tunnel task has no script; cannot make a recoverable installation.' }
$backupDir = Join-Path $Dir ("backup-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $backupDir | Out-Null
Set-PrivateAcl $backupDir
if ($hadScript) { Copy-Item -LiteralPath $loopFile -Destination (Join-Path $backupDir 'tunnel.ps1'); Set-PrivateAcl (Join-Path $backupDir 'tunnel.ps1') }
if ($hadConfig) { Copy-Item -LiteralPath $cfgEmpty -Destination (Join-Path $backupDir 'ssh_config'); Set-PrivateAcl (Join-Path $backupDir 'ssh_config') }
if ($hadTask) {
  $previousXml = Export-ScheduledTask -TaskName DroverTunnel -TaskPath '\' -ErrorAction Stop
  [IO.File]::WriteAllText((Join-Path $backupDir 'task.xml'), $previousXml, (New-Object Text.UTF8Encoding $false))
  Set-PrivateAcl (Join-Path $backupDir 'task.xml')
}
# Build the task definition while the old task is still running.
$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$loopFile`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$principalT = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
try {
  Stop-TunnelTask
  Set-Content -LiteralPath $cfgEmpty -Value '# intentionally empty: keeps user/global ssh config out of the tunnel' -Encoding ASCII
  Set-PrivateAcl $cfgEmpty
  Move-Item -LiteralPath $loopCandidate -Destination $loopFile -Force
  Set-PrivateAcl $loopFile
  Register-ScheduledTask -TaskName DroverTunnel -TaskPath '\' -Action $action -Trigger $trigger -Principal $principalT -Settings $settings -Force -ErrorAction Stop | Out-Null
  if (-not (Get-ManagedTunnelTask)) { Die 'Registered DroverTunnel is missing.' }
  if (-not $NoStart) { Start-CheckedTunnelTask }
} catch {
  $installFailure = $_.Exception.Message
  try { Restore-TunnelInstallation $backupDir $hadScript $hadConfig $hadTask }
  catch { Die "Tunnel installation failed ($installFailure); rollback incomplete ($($_.Exception.Message)). Backups retained: $backupDir" }
  if ($hadTask) { Die "Tunnel installation failed ($installFailure); previous script/config/XML restored and previous task running. Backups: $backupDir" }
  Die "Tunnel installation failed ($installFailure); new task removed and previous files restored. Backups: $backupDir"
}
try { Remove-Item -LiteralPath $backupDir -Recurse -Force -ErrorAction Stop }
catch { Warn "Installation succeeded; could not remove backup $backupDir" }
Say 'scheduled task DroverTunnel registered (runs as SYSTEM at boot)'
if (-not $NoStart) { Say 'tunnel task restarted with the new configuration' }

Say ''
Say 'Tunnel public key — give THIS to the VPS (vps-setup.sh --pc-key <file>):'
Get-Content "$key.pub"
Say ''
Say 'Status: Get-ScheduledTask DroverTunnel | Get-ScheduledTaskInfo ;  Get-Content C:\ProgramData\drover-tunnel\tunnel.log'
Say 'From the Mac, once the VPS side is ready:  ssh pc     (lands in Windows PowerShell as administrator "agent")'
