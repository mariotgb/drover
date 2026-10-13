import type { MachineOs } from '@shared/machines'

/** Run after changing authorization, in the same management SSH command.
 * Only the installer's marked, non-root agent account is eligible. Preserve
 * management ancestry; the tunnel runs as root/SYSTEM, outside agent sessions.
 */
export const UNIX_SESSION_CLEANUP = `import json,os,pwd,re,signal,subprocess,time
def emit(terminated,incomplete):
 print('DROVER_SESSIONS '+json.dumps(dict(terminated=terminated,incomplete=incomplete)),flush=True)
try:
 account=pwd.getpwnam('agent')
 if account.pw_uid==0 or account.pw_gecos!='Drover managed agent': raise ValueError('Account is not Drover-owned')
 def snapshot():
  rows={}
  for line in subprocess.check_output(['ps','-axo','pid=,ppid=,uid=,stat=,command='],text=True).splitlines():
   fields=line.strip().split(None,4)
   if len(fields)==5: rows[int(fields[0])]=(int(fields[1]),int(fields[2]),fields[3],fields[4])
  return rows
 rows=snapshot();keep=set();pid=os.getpid()
 while pid in rows and pid not in keep: keep.add(pid);pid=rows[pid][0]
 sessions={pid for pid,row in rows.items() if pid not in keep and re.search(r'^sshd: agent(?:@|\\s|$)',row[3])}
 roots={pid for pid in sessions if rows[pid][0] not in sessions}
 victims=sessions|{pid for pid,row in rows.items() if row[1]==account.pw_uid and pid not in keep}
 while True:
  descendants={pid for pid,row in rows.items() if row[0] in victims and pid not in keep}
  if descendants<=victims: break
  victims|=descendants
 for pid in victims:
  try: os.kill(pid,signal.SIGKILL)
  except ProcessLookupError: pass
 time.sleep(0.1);remaining=snapshot()
 live={pid for pid in victims if pid in remaining and not remaining[pid][2].startswith('Z')}
 emit(len(roots-live),bool(live))
except Exception:
 emit(0,True)
`

const WINDOWS_SESSION_CLEANUP = `$ended=0;$incomplete=$false
try {
 $account=Get-LocalUser agent -ErrorAction Stop
 if($account.Description -ne 'Drover managed agent'){throw 'Account is not Drover-owned'}
 $rows=@(Get-CimInstance Win32_Process);$keep=[Collections.Generic.HashSet[int]]::new();$current=$PID
 while($current -and $keep.Add($current)){$row=$rows|Where-Object ProcessId -eq $current|Select-Object -First 1;$current=[int]$row.ParentProcessId}
 $victims=[Collections.Generic.HashSet[int]]::new();$sessions=[Collections.Generic.HashSet[int]]::new()
 foreach($row in $rows){
  if($keep.Contains([int]$row.ProcessId)){continue}
  $owner=Invoke-CimMethod -InputObject $row -MethodName GetOwner
  if($owner.User -eq 'agent' -and $owner.Domain -eq $env:COMPUTERNAME){[void]$victims.Add([int]$row.ProcessId);if($row.Name -eq 'sshd.exe' -or $row.Name -eq 'sshd-session.exe'){[void]$sessions.Add([int]$row.ProcessId)}}
 }
 do{$added=$false;foreach($row in $rows){if($victims.Contains([int]$row.ParentProcessId) -and -not $keep.Contains([int]$row.ProcessId)){if($victims.Add([int]$row.ProcessId)){$added=$true}}}}while($added)
 foreach($victim in $victims){Stop-Process -Id $victim -Force -ErrorAction SilentlyContinue}
 foreach($session in $sessions){if(Get-Process -Id $session -ErrorAction SilentlyContinue){$incomplete=$true}else{$ended++}}
 foreach($victim in $victims){if(Get-Process -Id $victim -ErrorAction SilentlyContinue){$incomplete=$true}}
}catch{$incomplete=$true}
Write-Output ('DROVER_SESSIONS '+(@{terminated=$ended;incomplete=$incomplete}|ConvertTo-Json -Compress))
`

export function sessionCleanupScript(os: MachineOs | undefined): string {
  return os === 'windows' ? WINDOWS_SESSION_CLEANUP : `\nif ! sudo -n python3 - <<'DROVER_SESSION_CLEANUP'\n${UNIX_SESSION_CLEANUP}DROVER_SESSION_CLEANUP\nthen printf '%s\\n' 'DROVER_SESSIONS {"terminated":0,"incomplete":true}'; fi\n`
}
