#!/bin/bash
# Self-contained Linux/macOS installer served through a one-time capability.
set -euo pipefail
umask 077
[ "$(id -u)" = 0 ] || { echo 'Run this installer with sudo.' >&2; exit 1; }
OS='__DROVER_OS__'
KEY_URL='__DROVER_KEY_URL__'
case "$OS:$(uname -s)" in linux:Linux|macos:Darwin) ;; *) echo 'Installer does not match this operating system.' >&2; exit 1;; esac
if [ "$OS" = linux ]; then
  command -v systemctl >/dev/null || { echo 'Linux installer needs systemd.' >&2; exit 1; }
  packages=()
  command -v python3 >/dev/null || packages+=(python3)
  command -v ssh >/dev/null || packages+=(openssh-client)
  command -v sshd >/dev/null || packages+=(openssh-server)
  # Policy tools grant the dedicated agent access; root runs the installer directly.
  command -v visudo >/dev/null || packages+=(sudo)
  command -v curl >/dev/null || packages+=(curl ca-certificates)
  if [ "${#packages[@]}" -gt 0 ]; then
    if command -v apt-get >/dev/null; then
      apt-get update -qq || echo 'Package indexes could not fully update; trying available indexes.' >&2
      apt-get install -y "${packages[@]}"
    elif command -v dnf >/dev/null; then
      for i in "${!packages[@]}"; do [ "${packages[$i]}" != openssh-client ] || packages[$i]=openssh-clients; done
      dnf install -y "${packages[@]}"
    else echo 'Install the missing Python 3, OpenSSH, sudo policy tools and curl first.' >&2; exit 1; fi
  fi
else
  command -v python3 >/dev/null || { echo 'Install Python 3 before running this macOS installer.' >&2; exit 1; }
fi
work=$(mktemp -d); chmod 700 "$work"
trap 'rm -rf "$work"' EXIT
cat > "$work/run.sh" <<'DROVER_INSTALL_LOCKED'
set -euo pipefail
curl --fail --silent --show-error "$KEY_URL" > "$work/credentials.json"
python3 - "$work" <<'DROVER_CREDENTIALS'
import json,pathlib,sys
r=pathlib.Path(sys.argv[1]);d=json.loads((r/'credentials.json').read_text())
if d['version']!=1 or d['os'] not in ('linux','macos'):raise ValueError('unsupported credentials')
if d['permissions']=='read-only' and (d['os']!='linux' or not d['permissionSetupScript']):raise ValueError('unsupported read-only policy')
for name,value in [('agents.pub',d['agentsPublicKey']),('authorized_key',d['agentsAuthorizedKey']),('management.pub',d['managementPublicKey']),('policy.sh',d['permissionSetupScript'])]:
 (r/name).write_text(value+'\n' if name!='policy.sh' else value)
if d['bridge']:
 b=d['bridge'];private=b['tunnelPrivateKey']
 if not isinstance(private,str) or not private.startswith('-----BEGIN OPENSSH PRIVATE KEY-----\n') or len(private)>16384:raise ValueError('missing tunnel private key')
 (r/'id_ed25519').write_text(private);(r/'id_ed25519').chmod(0o600)
 (r/'tunnel.pub').write_text(b['tunnelPublicKey']+'\n')
 # HostKeyAlias makes nonstandard ports/IPv6 irrelevant to host key lookup.
 (r/'known_hosts').write_text('drover-bridge '+b['hostKey']+'\n')
 (r/'ssh_config').write_text('Host drover-bridge\n HostName '+b['host']+'\n Port '+str(b['sshPort'])+'\n User '+b['user']+'\n HostKeyAlias drover-bridge\n IdentityFile __TUNNEL_DIR__/id_ed25519\n UserKnownHostsFile __TUNNEL_DIR__/known_hosts\n GlobalKnownHostsFile /dev/null\n IdentitiesOnly yes\n BatchMode yes\n StrictHostKeyChecking yes\n PasswordAuthentication no\n KbdInteractiveAuthentication no\n ServerAliveInterval 30\n ServerAliveCountMax 3\n ExitOnForwardFailure yes\n ConnectTimeout 10\n RemoteForward 127.0.0.1:'+str(b['port'])+' 127.0.0.1:22\n')
DROVER_CREDENTIALS
ssh-keygen -lf "$work/agents.pub" >/dev/null
ssh-keygen -lf "$work/management.pub" >/dev/null
bridged=0; [ ! -f "$work/id_ed25519" ] || bridged=1
if [ "$bridged" = 1 ]; then
  ssh-keygen -y -P '' -f "$work/id_ed25519" > "$work/derived.pub"
  [ "$(awk '{print $1,$2}' "$work/derived.pub")" = "$(awk '{print $1,$2}' "$work/tunnel.pub")" ] || { echo 'Tunnel key pair mismatch.' >&2; exit 1; }
fi
cat > "$work/recovery.py" <<'DROVER_RECOVERY'
__DROVER_RECOVERY_UNIX__
DROVER_RECOVERY
python3 "$work/recovery.py" "$work"
marker='Drover managed agent'
if [ "$OS" = linux ]; then
  if getent passwd agent >/dev/null; then
    [ "$(getent passwd agent | cut -d: -f5)" = "$marker" ] || { echo 'Existing agent account is not Drover-owned.' >&2; exit 1; }
  else useradd --user-group --create-home --shell /bin/bash --comment "$marker" agent; usermod -p '*' agent; fi
  account_home=$(getent passwd agent | cut -d: -f6); group=$(id -gn agent)
else
  if dscl . -read /Users/agent >/dev/null 2>&1; then
    [ "$(dscl . -read /Users/agent RealName | sed 's/^RealName: //')" = "$marker" ] || { echo 'Existing agent account is not Drover-owned.' >&2; exit 1; }
  else
    # Separate account with an unrecorded random password; SSH is key-only below.
    pw=$(openssl rand -base64 48)
    sysadminctl -addUser agent -fullName "$marker" -home /Users/agent -shell /bin/bash -password "$pw" >/dev/null 2>&1
    unset pw
    dscl . -create /Users/agent IsHidden 1
  fi
  account_home=$(dscl . -read /Users/agent NFSHomeDirectory | sed 's/^NFSHomeDirectory: //'); group=staff
  if dscl . -read /Groups/com.apple.access_ssh >/dev/null 2>&1; then
    dseditgroup -o edit -a agent -t user com.apple.access_ssh
  fi
fi
[ "$(id -u agent)" != 0 ] || { echo 'Refusing UID 0 agent account.' >&2; exit 1; }
for path in "$account_home" "$account_home/.ssh" "$account_home/.ssh/authorized_keys" /etc/sudoers.d/drover-agent; do [ ! -L "$path" ] || { echo 'Unsafe account path.' >&2; exit 1; }; done
install -d -m 700 -o agent -g "$group" "$account_home/.ssh"
if [ "$OS" = linux ] && python3 - "$work/credentials.json" <<'DROVER_READ_ONLY'
import json,sys
sys.exit(0 if json.load(open(sys.argv[1]))['permissions']=='read-only' else 1)
DROVER_READ_ONLY
then
  command -v bwrap >/dev/null || { if command -v apt-get >/dev/null; then apt-get install -y bubblewrap; elif command -v dnf >/dev/null; then dnf install -y bubblewrap; else exit 1; fi; }
fi
# The backend owns key policy. Its script runs as the dedicated account so HOME,
# file ownership and the forced-command path refer to agent, never root.
if [ -s "$work/policy.sh" ]; then
  policy=$(cat "$work/policy.sh")
  printf '%s\n' "$policy" | runuser -u agent -- env HOME="$account_home" /bin/bash -s
else
  if grep -q 'command=' "$work/authorized_key"; then echo 'Missing server-enforced key policy.' >&2; exit 1; fi
  tmp=$(mktemp "$account_home/.ssh/.drover-auth.XXXXXX")
  python3 - "$work" "$account_home/.ssh/authorized_keys" "$tmp" <<'DROVER_INSTALL_KEYS'
import pathlib,shlex,sys
work,auth,dest=map(pathlib.Path,sys.argv[1:])
def identity(line):
 try:
  fields=shlex.split(line.decode('utf-8'),comments=True)
 except (ValueError,UnicodeDecodeError):return None
 index=0 if fields and fields[0]=='ssh-ed25519' else 1
 return tuple(fields[index:index+2]) if len(fields)>index+1 and fields[index]=='ssh-ed25519' else None
owned={identity((work/name).read_bytes()) for name in ('agents.pub','management.pub')}
owned.discard(None)
kept=b''.join(line for line in (auth.read_bytes().splitlines(keepends=True) if auth.exists() else []) if identity(line) not in owned)
if kept and not kept.endswith(b'\n'):kept+=b'\n'
dest.write_bytes(kept+(work/'authorized_key').read_bytes()+b' '.join((work/'management.pub').read_bytes().split()[:2])+b' drover-management\n')
DROVER_INSTALL_KEYS
  chown "agent:$group" "$tmp"; chmod 600 "$tmp"; mv -f "$tmp" "$account_home/.ssh/authorized_keys"
fi
printf 'agent ALL=(ALL) NOPASSWD: ALL\n' > "$work/sudoers"
visudo -cf "$work/sudoers" >/dev/null
install -d -m 755 /etc/sudoers.d
install -m 440 "$work/sudoers" /etc/sudoers.d/drover-agent
visudo -c >/dev/null
# Key-only policy is limited to agent. Administrator access is preserved.
sshd_cfg=/etc/ssh/sshd_config
python3 - "$sshd_cfg" "$work/sshd_config" <<'DROVER_SSHD'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1])
if p.is_symlink():raise ValueError('sshd config symlink')
s=p.read_text();s=re.sub(r'\n# BEGIN DROVER MACHINE\n.*?# END DROVER MACHINE\n','\n',s,flags=re.S)
policy='\n# BEGIN DROVER MACHINE\nMatch User agent\n PubkeyAuthentication yes\n PasswordAuthentication no\n KbdInteractiveAuthentication no\n AuthenticationMethods publickey\nMatch all\n# END DROVER MACHINE\n'
# Preserve global-only directives; verify effective settings for shadowing Includes.
first=re.search(r'^\s*Match\s',s,re.M)
candidate=s[:first.start()]+policy+s[first.start():] if first else s+policy
pathlib.Path(sys.argv[2]).write_text(candidate)
DROVER_SSHD
sshd=/usr/sbin/sshd
ssh-keygen -A
if [ "$OS" = linux ]; then
  mkdir -p /run/sshd
fi
"$sshd" -t -f "$work/sshd_config"
effective=$("$sshd" -T -f "$work/sshd_config" -C user=agent,host=localhost,addr=127.0.0.1,laddr=127.0.0.1,lport=22)
printf '%s\n' "$effective" | grep -qx 'passwordauthentication no'
printf '%s\n' "$effective" | grep -qx 'kbdinteractiveauthentication no'
printf '%s\n' "$effective" | grep -qx 'pubkeyauthentication yes'
cp -p "$sshd_cfg" "$work/sshd-backup"
install -m 644 "$work/sshd_config" "$sshd_cfg"
if [ "$OS" = linux ]; then
  svc=sshd; systemctl cat ssh.service >/dev/null 2>&1 && svc=ssh
  if ! systemctl enable --now "$svc" || ! systemctl reload "$svc"; then cp -p "$work/sshd-backup" "$sshd_cfg"; systemctl reload "$svc" || true; echo 'sshd failed; previous config restored.' >&2; exit 1; fi
else
  # Remote Login permission may require Full Disk Access on recent macOS versions.
  if ! systemsetup -setremotelogin on >/dev/null; then cp -p "$work/sshd-backup" "$sshd_cfg"; echo 'Enable Remote Login locally and retry.' >&2; exit 1; fi
  launchctl kickstart -k system/com.openssh.sshd
fi
if [ "$bridged" = 1 ]; then
  tunnel_dir=/var/lib/drover-machine-tunnel
  [ "$OS" != macos ] || tunnel_dir=/Library/Drover/machine-tunnel
  for path in "$tunnel_dir" "$tunnel_dir/id_ed25519" "$tunnel_dir/known_hosts" "$tunnel_dir/ssh_config"; do [ ! -L "$path" ] || exit 1; done
  install -d -m 700 "$tunnel_dir"
  install -m 600 "$work/id_ed25519" "$tunnel_dir/id_ed25519"
  install -m 600 "$work/tunnel.pub" "$tunnel_dir/id_ed25519.pub"
  install -m 600 "$work/known_hosts" "$tunnel_dir/known_hosts"
  sed "s#__TUNNEL_DIR__#$tunnel_dir#g" "$work/ssh_config" > "$tunnel_dir/ssh_config"; chmod 600 "$tunnel_dir/ssh_config"
  if [ "$OS" = linux ]; then
    cat > "$work/drover-machine-tunnel.service" <<DROVER_TUNNEL
[Unit]
Description=Drover machine reverse SSH tunnel
After=network-online.target ssh.service sshd.service
Wants=network-online.target
[Service]
ExecStart=/usr/bin/ssh -F $tunnel_dir/ssh_config -N -T drover-bridge
Restart=always
RestartSec=10
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
CapabilityBoundingSet=
[Install]
WantedBy=multi-user.target
DROVER_TUNNEL
    systemd-analyze verify "$work/drover-machine-tunnel.service"
    install -m 644 "$work/drover-machine-tunnel.service" /etc/systemd/system/drover-machine-tunnel.service
    systemctl daemon-reload; systemctl enable drover-machine-tunnel; systemctl restart drover-machine-tunnel
  else
    cat > "$work/tunnel.plist" <<DROVER_PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>dev.drover.machine-tunnel</string>
<key>ProgramArguments</key><array><string>/usr/bin/ssh</string><string>-F</string><string>$tunnel_dir/ssh_config</string><string>-N</string><string>-T</string><string>drover-bridge</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
</dict></plist>
DROVER_PLIST
    plutil -lint "$work/tunnel.plist"
    destination=/Library/LaunchDaemons/dev.drover.machine-tunnel.plist
    [ ! -L "$destination" ] || exit 1
    launchctl bootout system/dev.drover.machine-tunnel 2>/dev/null || true
    install -m 644 "$work/tunnel.plist" "$destination"
    launchctl bootstrap system "$destination"
  fi
else
  echo 'No public VPS bridge selected: this machine is reachable on the LAN only.'
fi
python3 - "$work" <<'DROVER_REPORT'
import json,pathlib,sys,urllib.request
r=pathlib.Path(sys.argv[1]);d=json.loads((r/'credentials.json').read_text())
k=pathlib.Path('/etc/ssh/ssh_host_ed25519_key.pub').read_text().split()
report=dict(machineId=d['machineId'],os=d['os'],state='installed',hostKey=' '.join(k[:2]))
if d.get('recoveryCleanup'):
 if (r/'recovery.done').read_text()!=d['recoveryCleanup']['id']:raise ValueError('recovery incomplete')
 report['cleanupId']=d['recoveryCleanup']['id']
req=urllib.request.Request(d['reportUrl'],json.dumps(report).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+d['receipt']},method='POST')
with urllib.request.urlopen(req,timeout=15) as response:
 if response.status!=200:raise ValueError('report failed')
DROVER_REPORT
echo 'Drover machine installed. Return to Drover to check the pinned SSH connection.'
DROVER_INSTALL_LOCKED
# Lock BEFORE consuming /key. A waiting/stale copy must fetch the capability
# again rather than carrying downloaded credentials into a concurrent install.
python3 - "$work" "$OS" "$KEY_URL" <<'DROVER_INSTALL_MUTEX'
import fcntl,os,pathlib,subprocess,sys
work,os_name,key_url=sys.argv[1:]
path=pathlib.Path('/var/run/drover-machine-installer.lock')
if path.is_symlink():raise ValueError('unsafe installer lock')
fd=os.open(path,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
if os.fstat(fd).st_uid!=0:raise ValueError('unowned installer lock')
os.fchmod(fd,0o600)
fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
subprocess.run(['/bin/bash',work+'/run.sh'],env={**os.environ,'work':work,'OS':os_name,'KEY_URL':key_url},check=True)
DROVER_INSTALL_MUTEX
