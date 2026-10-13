# Run in an elevated 64-bit Windows PowerShell. Self-contained capability installer.
$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or -not [Environment]::Is64BitProcess) { throw 'Use 64-bit PowerShell as Administrator.' }
$installerMutex = [Threading.Mutex]::new($false, 'Global\DroverMachineInstaller')
$installerLocked = $false
try {
$installerLocked = $installerMutex.WaitOne(0)
if (-not $installerLocked) { throw 'Another Drover installer is running. Retry after it finishes.' }
$keyUrl = '__DROVER_KEY_URL__'
$utf8 = [Text.UTF8Encoding]::new($false)
$sshRoot = "$env:ProgramData\ssh"
$dir = "$env:ProgramData\Drover\machine-tunnel"
$ssh = "$env:WINDIR\System32\OpenSSH\ssh.exe"
$keygen = "$env:WINDIR\System32\OpenSSH\ssh-keygen.exe"
$sshd = "$env:WINDIR\System32\OpenSSH\sshd.exe"
function Assert-Path([string]$Path) {
  $p = [IO.Path]::GetFullPath($Path)
  while ($p) {
    $item = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Reparse point in installer path.' }
    $parent = Split-Path $p -Parent; if ($parent -eq $p) { break }; $p = $parent
  }
}
function Protect-Path([string]$Path) {
  Assert-Path $Path
  $item = Get-Item -LiteralPath $Path -Force
  $flags = [Security.AccessControl.InheritanceFlags]::None
  if ($item.PSIsContainer) { $acl = [Security.AccessControl.DirectorySecurity]::new(); $flags = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' }
  else { $acl = [Security.AccessControl.FileSecurity]::new() }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($id in @('S-1-5-18', 'S-1-5-32-544')) {
    $sid = [Security.Principal.SecurityIdentifier]::new($id)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $flags, 'None', 'Allow'))
  }
  $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  Set-Acl -LiteralPath $Path -AclObject $acl
}
function Write-Private([string]$Path, [string]$Value) {
  Assert-Path $Path
  [IO.File]::WriteAllText($Path, $Value, $utf8); Protect-Path $Path
}
function Key-Fingerprint([string]$Text) {
  $tmp = [IO.Path]::GetTempFileName()
  try {
    Write-Private $tmp $Text
    $out = @(& $keygen -lf $tmp -E sha256 2>$null)
    if ($LASTEXITCODE -ne 0 -or $out.Count -ne 1 -or $out[0] -notmatch '^\d+\s+(SHA256:\S+)') { throw 'Invalid SSH key.' }
    return $Matches[1]
  } finally { Remove-Item -LiteralPath $tmp -Force }
}
function Key-Identity([string]$Line) {
  if ($Line.TrimStart().StartsWith('#')) { return $null }
  $tokens = @([regex]::Matches($Line.TrimStart(), '(?:[^\s"\\]|\\.|"(?:[^"\\]|\\.)*")+') | ForEach-Object { $_.Value })
  $index = if ($tokens.Count -gt 0 -and $tokens[0] -ceq 'ssh-ed25519') { 0 } else { 1 }
  if ($tokens.Count -gt ($index + 1) -and $tokens[$index] -ceq 'ssh-ed25519') { return $tokens[$index] + ' ' + $tokens[$index + 1] }
  return $null
}
# Preflight before consuming the one-time key download.
Assert-Path $dir; Assert-Path $sshRoot
$marker = 'Drover managed agent'
$existing = Get-LocalUser -Name agent -ErrorAction SilentlyContinue
if ($existing -and $existing.Description -ne $marker) { throw 'Existing agent account is not Drover-owned.' }
$cap = Get-WindowsCapability -Online -Name 'OpenSSH.Client*' | Select-Object -First 1
if ($cap.State -ne 'Installed') { Add-WindowsCapability -Online -Name $cap.Name | Out-Null }
$cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1
if ($cap.State -ne 'Installed') { Add-WindowsCapability -Online -Name $cap.Name | Out-Null }
$d = (Invoke-WebRequest -UseBasicParsing $keyUrl).Content | ConvertFrom-Json
if ($d.version -ne 1 -or $d.os -ne 'windows' -or $d.permissions -eq 'read-only') { throw 'Read-only Windows access is unsupported; no key installed.' }
Key-Fingerprint $d.agentsPublicKey | Out-Null
Key-Fingerprint $d.managementPublicKey | Out-Null
if ($d.agentsAuthorizedKey -cne "$($d.agentsPublicKey) drover-agents") { throw 'Unsupported Windows forced-command policy.' }
$private = $null
if ($d.bridge) {
  $private = $d.bridge.tunnelPrivateKey
  if ($private -isnot [string] -or -not $private.StartsWith("-----BEGIN OPENSSH PRIVATE KEY-----`n") -or $private.Length -gt 16384) { throw 'Missing dedicated tunnel key.' }
}
$recoveryDone = $null
if ($d.recoveryCleanup) {
  $recovery = $d.recoveryCleanup
  if (-not $existing -or $existing.Description -ne $marker -or $recovery.id -isnot [string] -or $recovery.id -notmatch '^[A-Za-z0-9_-]{1,128}$') { throw 'Invalid recovery account or request.' }
  $oldKeys = @($recovery.agentsPublicKeys) + @($recovery.managementPublicKey)
  if ($oldKeys.Count -gt 1001) { throw 'Too many recovery keys.' }
  $oldBlobs = @()
  foreach ($oldKey in $oldKeys) {
    if ($oldKey -isnot [string] -or $oldKey -cnotmatch '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-[\w-]+) ([A-Za-z0-9+/]+={0,2})$') { throw 'Invalid recovery key.' }
    $oldBlobs += $Matches[2]
  }
  $oldAuth = "$sshRoot\drover_agent_authorized_keys"; Assert-Path $oldAuth
  $oldTask = Get-ScheduledTask -TaskName 'DroverMachineTunnel' -ErrorAction SilentlyContinue
  if ($oldTask -and ($oldTask.Description -ne 'Drover managed machine tunnel' -or $oldTask.Principal.UserId -notin @('SYSTEM', 'S-1-5-18') -or $oldTask.Actions.Count -ne 1 -or $oldTask.Actions[0].Execute -ne "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -or $oldTask.Actions[0].Arguments -ne "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$dir\tunnel.ps1`"")) { throw 'Existing tunnel task is not Drover-owned.' }
  $ownedFiles = @('id_ed25519', 'id_ed25519.pub', 'derived.pub', 'known_hosts', 'ssh_config', 'tunnel.ps1')
  if (Test-Path -LiteralPath $dir) {
    foreach ($file in @(Get-ChildItem -LiteralPath $dir -Force)) {
      Assert-Path $file.FullName
      if ($file.PSIsContainer -or $file.Name -notin $ownedFiles) { throw 'Foreign file in old tunnel directory.' }
    }
  }
  # Validate all paths/ownership before stopping the task or removing any key.
  $kept = @()
  if (Test-Path -LiteralPath $oldAuth) {
    foreach ($line in [IO.File]::ReadAllLines($oldAuth)) {
      $match = [regex]::Match($line, '(?:^|\s)(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-[\w-]+)\s+([A-Za-z0-9+/]+={0,2})(?:\s|$)')
      if (-not $match.Success -or $match.Groups[1].Value -cnotin $oldBlobs) { $kept += $line }
    }
  }
  if ($oldTask) {
    Stop-ScheduledTask -TaskName 'DroverMachineTunnel'
    Unregister-ScheduledTask -TaskName 'DroverMachineTunnel' -Confirm:$false
  }
  $pattern = '(?i)-F\s+"?' + [regex]::Escape("$dir\ssh_config") + '"?(\s|$)'
  foreach ($proc in @(Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | Where-Object { $_.CommandLine -match $pattern })) {
    $owner = Invoke-CimMethod -InputObject $proc -MethodName GetOwnerSid
    if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne 'S-1-5-18') { throw 'Refusing to stop a non-SYSTEM tunnel.' }
    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.ProcessId)"
    if ($current -and $current.CreationDate -eq $proc.CreationDate) { Stop-Process -Id $proc.ProcessId -Force }
  }
  if (Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | Where-Object { $_.CommandLine -match $pattern }) { throw 'Old tunnel process is still running.' }
  if (Get-ScheduledTask -TaskName 'DroverMachineTunnel' -ErrorAction SilentlyContinue) { throw 'Old tunnel task was not removed.' }
  if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
  if (Test-Path -LiteralPath $oldAuth) { Write-Private $oldAuth (($kept -join "`n") + $(if ($kept.Count) { "`n" } else { '' })) }
  $recoveryDone = $recovery.id
}
foreach ($path in @($dir, $sshRoot)) { New-Item -ItemType Directory -Path $path -Force | Out-Null; Protect-Path $path }
if ($d.bridge) {
  Write-Private "$dir\id_ed25519" $private; $private = $null; $d.bridge.tunnelPrivateKey = $null
  Write-Private "$dir\id_ed25519.pub" ($d.bridge.tunnelPublicKey + "`n")
  $derived = "$dir\derived.pub"
  try {
    $p = Start-Process -FilePath $keygen -Wait -PassThru -NoNewWindow -RedirectStandardOutput $derived -ArgumentList ('-y -P "" -f "{0}"' -f "$dir\id_ed25519")
    if ($p.ExitCode -ne 0 -or (Key-Fingerprint ([IO.File]::ReadAllText($derived))) -cne (Key-Fingerprint $d.bridge.tunnelPublicKey)) { throw 'Tunnel key pair mismatch.' }
  } finally { Remove-Item -LiteralPath $derived -Force -ErrorAction SilentlyContinue }
}
if (-not $existing) {
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create(); $bytes = New-Object byte[] 48; $rng.GetBytes($bytes); $rng.Dispose()
  $pw = ConvertTo-SecureString ('aA1!' + [Convert]::ToBase64String($bytes)) -AsPlainText -Force
  New-LocalUser -Name agent -Password $pw -PasswordNeverExpires -AccountNeverExpires -Description $marker | Out-Null
  $pw.Dispose(); $pw = $null
}
$admins = (Get-LocalGroup -SID 'S-1-5-32-544').Name
if (-not (Get-LocalGroupMember -Group $admins | Where-Object { $_.SID -eq (Get-LocalUser agent).SID })) { Add-LocalGroupMember -Group $admins -Member agent }
$hidden = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList'
New-Item $hidden -Force | Out-Null; New-ItemProperty $hidden -Name agent -Value 0 -PropertyType DWord -Force | Out-Null
Set-Service sshd -StartupType Automatic; Start-Service sshd
# Dedicated key file: the agents key must never grant access to every administrator.
$auth = "$sshRoot\drover_agent_authorized_keys"; Assert-Path $auth
$owned = @((Key-Identity $d.agentsPublicKey), (Key-Identity $d.managementPublicKey))
$kept = ''
if (Test-Path -LiteralPath $auth) {
  foreach ($line in [regex]::Matches([IO.File]::ReadAllText($auth), '[^\n]*\n|[^\n]+$')) {
    if ((Key-Identity $line.Value) -cnotin $owned) { $kept += $line.Value }
  }
}
if ($kept -and -not $kept.EndsWith("`n")) { $kept += "`n" }
Write-Private $auth ($kept + $d.agentsAuthorizedKey + "`n" + $d.managementPublicKey + " drover-management`n")
$cfg = "$sshRoot\sshd_config"; Assert-Path $cfg
$previous = [IO.File]::ReadAllText($cfg)
$clean = [regex]::Replace($previous, '(?s)\r?\n# BEGIN DROVER MACHINE\r?\n.*?# END DROVER MACHINE\r?\n', "`n")
$block = "`n# BEGIN DROVER MACHINE`nMatch User agent`n AuthorizedKeysFile __PROGRAMDATA__/ssh/drover_agent_authorized_keys`n PubkeyAuthentication yes`n PasswordAuthentication no`n KbdInteractiveAuthentication no`n AuthenticationMethods publickey`nMatch all`n# END DROVER MACHINE`n"
# Place before the first administrator Match, after global directives.
$match = [regex]::Match($clean, '(?m)^\s*Match\s')
$candidate = if ($match.Success) { $clean.Insert($match.Index, $block) } else { $clean + $block }
Write-Private "$cfg.drover-new" $candidate
& $sshd -t -f "$cfg.drover-new"
if ($LASTEXITCODE -ne 0) { Remove-Item "$cfg.drover-new" -Force; throw 'sshd candidate rejected.' }
$effective = @(& $sshd -T -f "$cfg.drover-new" -C 'user=agent,host=localhost,addr=127.0.0.1,laddr=127.0.0.1,lport=22')
foreach ($line in @('passwordauthentication no', 'kbdinteractiveauthentication no', 'pubkeyauthentication yes')) { if ($line -notin $effective) { throw 'Agent key-only SSH policy is shadowed.' } }
try {
  Move-Item "$cfg.drover-new" $cfg -Force
  Restart-Service sshd
  if ((Get-Service sshd).Status -ne 'Running') { throw 'sshd failed to start.' }
} catch { Write-Private $cfg $previous; Restart-Service sshd; throw 'Previous sshd configuration restored after a failed reload.' }
New-Item 'HKLM:\SOFTWARE\OpenSSH' -Force | Out-Null
New-ItemProperty 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -Force | Out-Null
if ($d.bridge) {
  $b = $d.bridge
  $config = @"
Host drover-bridge
 HostName $($b.host)
 Port $($b.sshPort)
 User $($b.user)
 HostKeyAlias drover-bridge
 IdentityFile $($dir.Replace('\','/'))/id_ed25519
 UserKnownHostsFile $($dir.Replace('\','/'))/known_hosts
 GlobalKnownHostsFile NUL
 IdentitiesOnly yes
 BatchMode yes
 StrictHostKeyChecking yes
 PasswordAuthentication no
 KbdInteractiveAuthentication no
 ServerAliveInterval 30
 ServerAliveCountMax 3
 ExitOnForwardFailure yes
 ConnectTimeout 10
 RemoteForward 127.0.0.1:$($b.port) 127.0.0.1:22
"@
  Write-Private "$dir\known_hosts" ('drover-bridge ' + $b.hostKey + "`n")
  Write-Private "$dir\ssh_config" ($config + "`n")
  $loop = @"
`$ErrorActionPreference = 'Continue'
while (`$true) {
 & '$ssh' -F '$dir\ssh_config' -N -T drover-bridge
 Start-Sleep -Seconds 10
}
"@
  $taskName = 'DroverMachineTunnel'
  $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($existingTask -and ($existingTask.Description -ne 'Drover managed machine tunnel' -or $existingTask.Principal.UserId -notin @('SYSTEM', 'S-1-5-18'))) { throw 'Existing tunnel task is not Drover-owned.' }
  if ($existingTask) {
    Stop-ScheduledTask -TaskName $taskName
    # Task Scheduler can leave its child ssh.exe running; stop only this
    # protected SYSTEM tunnel, never other SSH/agent processes.
    $pattern = '(?i)-F\s+"?' + [regex]::Escape("$dir\ssh_config") + '"?(\s|$)'
    foreach ($proc in @(Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | Where-Object { $_.CommandLine -match $pattern })) {
      $owner = Invoke-CimMethod -InputObject $proc -MethodName GetOwnerSid
      if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne 'S-1-5-18') { throw 'Refusing to stop a non-SYSTEM tunnel.' }
      $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.ProcessId)"
      if ($current -and $current.CreationDate -eq $proc.CreationDate) { Stop-Process -Id $proc.ProcessId -Force }
    }
  }
  Write-Private "$dir\tunnel.ps1" $loop
  $tokens = $null; $errors = $null
  [Management.Automation.Language.Parser]::ParseFile("$dir\tunnel.ps1", [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors.Count) { throw 'Tunnel script parse failed.' }
  $action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$dir\tunnel.ps1`""
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principalTask = New-ScheduledTaskPrincipal -UserId SYSTEM -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $taskName -Description 'Drover managed machine tunnel' -Action $action -Trigger $trigger -Principal $principalTask -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
} else { Write-Host 'No public bridge selected: this machine is reachable on the LAN only.' }
$parts = ([IO.File]::ReadAllText("$sshRoot\ssh_host_ed25519_key.pub").Trim() -split '\s+')
$report = @{ machineId = $d.machineId; os = 'windows'; state = 'installed'; hostKey = ($parts[0..1] -join ' ') } | ConvertTo-Json -Compress
if ($d.recoveryCleanup) {
  if ($recoveryDone -ne $d.recoveryCleanup.id) { throw 'Recovery cleanup incomplete.' }
  $report = @{ machineId = $d.machineId; os = 'windows'; state = 'installed'; hostKey = ($parts[0..1] -join ' '); cleanupId = $recoveryDone } | ConvertTo-Json -Compress
}
Invoke-WebRequest -UseBasicParsing -Uri $d.reportUrl -Method Post -ContentType 'application/json' -Headers @{Authorization = 'Bearer ' + $d.receipt} -Body $report | Out-Null
Write-Host 'Drover machine installed. Return to Drover to verify the pinned SSH connection.'
} finally {
  if ($installerLocked) { $installerMutex.ReleaseMutex() }
  $installerMutex.Dispose()
}
