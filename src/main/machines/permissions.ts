import type { MachinePermissions } from '@shared/machines'
import { MachinesFailure, quote } from './ssh'

/** A shell allowlist is not a read-only boundary; isolate mounts, network,
 * namespaces, devices and capabilities instead. Fail if bwrap cannot launch.
 */
export const READ_ONLY_GUARD = `#!/usr/bin/env python3
import os,platform,struct,sys
command=os.environ.get('SSH_ORIGINAL_COMMAND','')
if not command:
 print('Read-only access requires a command.',file=sys.stderr);sys.exit(126)
# Read-only bind mounts do not stop writes through host Unix sockets. Deny
# socket creation/connect and cross-process access with a seccomp filter too.
arch=platform.machine()
if arch=='x86_64': audit=0xc000003e; denied=[41,42,43,49,50,53,101,288,310,311,438]
elif arch in ('aarch64','arm64'): audit=0xc00000b7; denied=[198,199,200,201,202,203,117,242,270,271,438]
else: print('Unsupported read-only sandbox architecture.',file=sys.stderr);sys.exit(126)
# io_uring can perform socket operations without the blocked socket syscalls.
denied += [425,426,427] # io_uring_setup, io_uring_enter, io_uring_register
instructions=[(0x20,0,0,4),(0x15,1,0,audit),(0x06,0,0,0x80000000),(0x20,0,0,0)]
# x32 can bypass x86_64 syscall numbers; fail closed on that ABI.
if arch=='x86_64': instructions += [(0x45,0,1,0x40000000),(0x06,0,0,0x80000000)]
for syscall in denied: instructions += [(0x15,0,1,syscall),(0x06,0,0,0x00050001)]
instructions += [(0x06,0,0,0x7fff0000)]
fd=os.memfd_create('drover-read-only',0)
os.write(fd,b''.join(struct.pack('HBBI',*instruction) for instruction in instructions));os.lseek(fd,0,0)
os.set_inheritable(fd,True)
os.execvp('bwrap',['bwrap','--unshare-all','--die-with-parent','--new-session','--ro-bind','/','/','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--tmpfs','/run','--tmpfs','/sys','--cap-drop','ALL','--seccomp',str(fd),'/bin/sh','-c',command])
`

/** Parse the key fields, including options with quoted spaces. Comments are
 * not credentials: only exact identities generated/recorded by this install
 * may be replaced or removed. Key type + blob identifies its fingerprint.
 */
const OWNED_KEY_FILTER = `function owned(line, tokens, n, token, quoted, escaped, i, c, kind, blob) {
  n=0; token=""; quoted=0; escaped=0
  sub(/^[ \\t]+/, "", line)
  sub(/\\r$/, "", line)
  if (line ~ /^#/) return 0
  for (i=1; i<=length(line)+1; i++) {
    c=substr(line,i,1)
    if (i>length(line) || (!quoted && c ~ /[ \\t]/)) {
      if (token!="") { tokens[++n]=token; token=""; if (n==3) break }
    } else {
      token=token c
      if (escaped) escaped=0
      else if (c=="\\\\") escaped=1
      else if (c=="\\\"") quoted=!quoted
    }
  }
  if (n>=2 && tokens[1]=="ssh-ed25519") { kind=tokens[1]; blob=tokens[2] }
  else if (n>=3) { kind=tokens[2]; blob=tokens[3] }
  else return 0
  return kind=="ssh-ed25519" && ((agent!="" && blob==agent) || (manager!="" && blob==manager) || (old!="" && blob==old))
}
!owned($0) { print }`

function managedKey(key: string): string {
  if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [^\r\n]*)?$/.test(key)) throw new MachinesFailure('invalid_key', 'Invalid managed public key.')
  return key.split(/\s+/).slice(0, 2).join(' ')
}

/** Idempotently replace only identities owned by this installation. */
export function keyInstallScript(publicKey: string, managementPublicKey: string, permissions: MachinePermissions, oldPublicKey?: string): string {
  const agent = managedKey(publicKey), manager = managedKey(managementPublicKey)
  const old = oldPublicKey ? managedKey(oldPublicKey).split(' ')[1] : ''
  const guard = permissions.mode === 'read-only' ? `
[ "$(uname -s)" = Linux ] || { echo 'Drover sandbox requires Linux' >&2; exit 73; }
command -v bwrap >/dev/null || { echo 'Drover sandbox needs bubblewrap' >&2; exit 73; }
command -v python3 >/dev/null || { echo 'Drover sandbox needs Python 3' >&2; exit 73; }
guard="$HOME/.ssh/drover-read-only"
cat > "$guard" <<'DROVER_GUARD'
${READ_ONLY_GUARD}DROVER_GUARD
chmod 700 "$guard"
SSH_ORIGINAL_COMMAND=/bin/true "$guard" || { echo 'Drover sandbox is unavailable' >&2; exit 73; }
line="restrict,command=\\\"$guard\\\" ${agent} drover-agents"
` : `line=${quote(agent + ' drover-agents')}`
  return `set -eu
umask 077
[ ! -L "$HOME/.ssh" ] || exit 74
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
auth="$HOME/.ssh/authorized_keys"
[ ! -L "$auth" ] || exit 74
touch "$auth"
chmod 600 "$auth"
${guard}
tmp=$(mktemp "$HOME/.ssh/drover-auth.XXXXXX")
trap 'rm -f "$tmp"' EXIT
awk -v agent=${quote(agent.split(' ')[1])} -v manager=${quote(manager.split(' ')[1])} -v old=${quote(old)} ${quote(OWNED_KEY_FILTER)} "$auth" > "$tmp"
printf '%s\\n' "$line" >> "$tmp"
printf '%s\\n' ${quote(manager + ' drover-management')} >> "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$auth"
`
}

/** Add only this install's administrator identity during bridge bootstrap. */
export function adminKeyInstallScript(managementPublicKey: string): string {
  const manager = managedKey(managementPublicKey)
  return `set -eu
umask 077
[ ! -L "$HOME/.ssh" ] || exit 74
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
auth="$HOME/.ssh/authorized_keys"
[ ! -L "$auth" ] || exit 74
touch "$auth"
chmod 600 "$auth"
tmp=$(mktemp "$HOME/.ssh/drover-auth.XXXXXX")
trap 'rm -f "$tmp"' EXIT
awk -v agent='' -v manager=${quote(manager.split(' ')[1])} -v old='' ${quote(OWNED_KEY_FILTER)} "$auth" > "$tmp"
printf '%s\\n' ${quote(manager + ' drover-management')} >> "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$auth"
`
}

export function removeKeyScript(publicKey: string, managementPublicKey: string, removeManagement = false): string {
  const agent = managedKey(publicKey), manager = managedKey(managementPublicKey)
  return `set -eu
umask 077
auth="$HOME/.ssh/authorized_keys"
[ -f "$auth" ] && [ ! -L "$auth" ] || exit 74
tmp=$(mktemp "$HOME/.ssh/drover-auth.XXXXXX")
trap 'rm -f "$tmp"' EXIT
awk -v agent=${quote(agent.split(' ')[1])} -v manager=${quote(removeManagement ? manager.split(' ')[1] : '')} -v old='' ${quote(OWNED_KEY_FILTER)} "$auth" > "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$auth"
`
}

/** Windows bridged installer uses an account-specific ProgramData key file,
 * rather than administrators_authorized_keys which grants every admin access.
 */
export function windowsKeyScript(agentsPublicKey: string, managementPublicKey: string, remove = false, removeManagement = false): string {
  const ps = (value: string) => `'${value.replace(/'/g, "''")}'`
  const agent = managedKey(agentsPublicKey), manager = managedKey(managementPublicKey)
  return `$ErrorActionPreference='Stop'
$file=Join-Path $env:ProgramData 'ssh\\drover_agent_authorized_keys'
$item=Get-Item -LiteralPath $file -Force
if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Unsafe key file'}
$agent=${ps(agent.split(' ')[1])};$manager=${ps(removeManagement || !remove ? manager.split(' ')[1] : '')}
$kept=''
foreach($line in [regex]::Matches([IO.File]::ReadAllText($file), '[^\\n]*\\n|[^\\n]+$')) {
 $value=$line.Value
 $tokens=@([regex]::Matches($value.TrimStart(), '(?:[^\\s"\\\\]|\\\\.|"(?:[^"\\\\]|\\\\.)*")+')|ForEach-Object {$_.Value})
 $index=if($tokens.Count -gt 0 -and $tokens[0] -ceq 'ssh-ed25519'){0}else{1}
 if($value.TrimStart().StartsWith('#') -or -not ($tokens.Count -gt ($index+1) -and $tokens[$index] -ceq 'ssh-ed25519' -and ($tokens[$index+1] -ceq $agent -or ($manager -and $tokens[$index+1] -ceq $manager)))){$kept+=$value}
}
${remove ? '' : `if($kept -and -not $kept.EndsWith("\u0060n")){$kept+="\u0060n"}
$kept+=${ps(agent + ' drover-agents')}+"\u0060n"+${ps(manager + ' drover-management')}+"\u0060n"`}
[IO.File]::WriteAllText($file,$kept,[Text.UTF8Encoding]::new($false))
`
}
