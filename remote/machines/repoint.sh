#!/bin/bash
# Management SSH on the old tunnel; credentials remain on the target.
set -euo pipefail
umask 077
case "$(uname -s)" in Linux) dir=/var/lib/drover-machine-tunnel; unit=drover-machine-tunnel;; Darwin) dir=/Library/Drover/machine-tunnel; unit=dev.drover.machine-tunnel;; *) exit 73;; esac
[ -d "$dir" ] && [ ! -L "$dir" ] && [ ! -L "$dir/ssh_config" ] && [ ! -L "$dir/known_hosts" ] || exit 74
python3 - "$dir" "$DROVER_REPOINT" <<'DROVER_REPOINT_DATA'
import base64,json,pathlib,sys
r=pathlib.Path(sys.argv[1]);d=json.loads(base64.b64decode(sys.argv[2]))
s=(r/'ssh_config').read_text()
values={'HostName':d['host'],'Port':str(d['sshPort']),'User':d['user'],'RemoteForward':'127.0.0.1:'+str(d['port'])+' 127.0.0.1:22'}
out=[]
for line in s.splitlines():
 t=line.strip().split(None,1)
 if t and t[0] in values:line=' '+t[0]+' '+values[t[0]]
 out.append(line)
(r/'ssh_config.new').write_text('\n'.join(out)+'\n');(r/'known_hosts.new').write_text('drover-bridge '+d['hostKey']+'\n')
for name in ('ssh_config.new','known_hosts.new'):(r/name).chmod(0o600)
DROVER_REPOINT_DATA
# Check candidate parsing before scheduling a restart which drops this connection.
ssh -G -F "$dir/ssh_config.new" drover-bridge >/dev/null
cp -p "$dir/ssh_config" "$dir/ssh_config.previous"; cp -p "$dir/known_hosts" "$dir/known_hosts.previous"
mv -f "$dir/ssh_config.new" "$dir/ssh_config"; mv -f "$dir/known_hosts.new" "$dir/known_hosts"
if [ "$(uname -s)" = Linux ]; then
  # Transient service survives the SSH transport disconnect; only our tunnel restarts.
  systemd-run --unit="drover-repoint-$(date +%s)" --on-active=3s /bin/systemctl restart "$unit"
else
  # launchd kickstart drops SSH too; return before the deferred restart.
  nohup /bin/sh -c 'sleep 3; /bin/launchctl kickstart -k system/dev.drover.machine-tunnel' </dev/null >/dev/null 2>&1 &
fi
printf 'DROVER_REPOINTED\n'
