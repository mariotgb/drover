#!/usr/bin/env python3
"""Real key login/reverse forwarding inside a disposable container only."""
import json
import os
import secrets
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path('/fixture/remote')
if os.environ.get('DROVER_MACHINE_CONTAINER_TEST') != '1' or not Path('/.dockerenv').exists() or not ROOT.is_dir():
    sys.exit('Run only in the isolated Machines check container.')
work = Path('/tmp/drover-install-check'); work.mkdir(mode=0o700)


def run(*args, **kw):
    try: return subprocess.check_output(args, text=True, **kw).strip()
    except subprocess.CalledProcessError as error:
        print(error.output, file=sys.stderr); raise


def key(name):
    path = work / name
    run('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(path))
    return ' '.join(Path(str(path)+'.pub').read_text().split()[:2])


agent_key, management_key, tunnel_key = (key(n) for n in ('agents', 'management', 'tunnel'))
bridge_key = ' '.join(Path('/etc/ssh/ssh_host_ed25519_key.pub').read_text().split()[:2])
# This test double changes only service lifecycle, not SSH/key/policy operations.
# Container PID 1 is not systemd; real sshd/ssh still run on loopback.
fake = work/'bin'; fake.mkdir()
(fake/'systemctl').write_text('''#!/bin/bash
set -eu
case "${1:-}:${2:-}" in
 cat:ssh.service) exit 0;;
 restart:drover-machine-tunnel)
  /usr/bin/ssh -F /var/lib/drover-machine-tunnel/ssh_config -N -T drover-bridge > /tmp/drover-tunnel.log 2>&1 &
  exit 0;;
 reload:ssh|reload:sshd)
  if [ -f /run/sshd.pid ]; then kill -HUP "$(cat /run/sshd.pid)"; else /usr/sbin/sshd; fi
  exit 0;;
 enable:--now)
  if [ "${3:-}" = ssh ]; then [ -f /run/sshd.pid ] || /usr/sbin/sshd; fi
  exit 0;;
esac
exit 0
''')
(fake/'systemd-analyze').write_text('#!/bin/sh\nexit 0\n')
for p in fake.iterdir(): p.chmod(0o755)
env = {**os.environ, 'PATH': str(fake)+':'+os.environ['PATH']}
run('/usr/sbin/sshd', '-e', stderr=subprocess.STDOUT)
run('systemctl', 'reload', 'ssh', env=env, stderr=subprocess.STDOUT)
manifest = work/'manifest.json'
manifest.write_text(json.dumps(dict(action='setup', agentsPublicKey=agent_key, origin='https://fixture.invalid', phone=False, phonePort=8780,
                                   targets=[dict(id='fixture', user='dt-'+'a'*16, port=24567, publicKey=tunnel_key)])))
run('bash', str(ROOT/'machines/bridge.sh'), str(manifest), env=env, stderr=subprocess.STDOUT)
token = secrets.token_urlsafe(32); receipt = secrets.token_urlsafe(32)
credentials = dict(version=1, machineId='fixture', os='linux', agentsPublicKey=agent_key,
                   agentsAuthorizedKey=agent_key+' drover-agents', managementPublicKey=management_key,
                   permissionSetupScript='', permissions='full', receipt=receipt,
                   reportUrl=f'http://127.0.0.1:8791/machines/install/{token}/report',
                   bridge=dict(host='127.0.0.1', sshPort=22, user='dt-'+'a'*16, port=24567, hostKey=bridge_key, tunnelPublicKey=tunnel_key,
                               tunnelPrivateKey=(work/'tunnel').read_text()))
capfile = Path('/var/lib/drover-machines/capabilities')/(token+'.json')
capfile.write_text(json.dumps(dict(expiresAt=time.time()*1000+7200000, credentials=credentials, receipt=receipt,
                                 machineId='fixture', os='linux', script='')))
server = subprocess.Popen(['python3', str(ROOT/'machines/capability-server.py')], stdout=subprocess.DEVNULL)
try:
    time.sleep(0.2)
    script = (ROOT/'machines/install-unix.sh').read_text().replace('__DROVER_OS__', 'linux').replace('__DROVER_KEY_URL__', f'http://127.0.0.1:8791/machines/install/{token}/key').replace('__DROVER_RECOVERY_UNIX__', (ROOT/'machines/recovery-unix.py').read_text())
    result = subprocess.run(['bash'], input=script, text=True, capture_output=True,
                            env=env, timeout=30)
    if result.returncode:
        print(result.stdout); print(result.stderr, file=sys.stderr); sys.exit(result.returncode)
    installed_key = Path('/var/lib/drover-machine-tunnel/id_ed25519')
    assert installed_key.stat().st_mode & 0o777 == 0o600
    assert installed_key.read_text() == (work/'tunnel').read_text()
    known = work/'known_hosts'; known.write_text('fixture '+bridge_key+'\n')
    base = ['ssh', '-F', '/dev/null', '-o', 'HostKeyAlias=fixture', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile='+str(known),
            '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=3']
    for _ in range(30):
        result = subprocess.run(base+['-i', str(work/'agents'), '-p', '24567', 'agent@127.0.0.1', 'id -un'], text=True, capture_output=True)
        if result.returncode == 0: break
        time.sleep(0.1)
    if result.returncode: print(result.stderr, file=sys.stderr); sys.exit(result.returncode)
    assert result.stdout.strip() == 'agent'
    assert run(*(base+['-i', str(work/'management'), '-p', '24567', 'agent@127.0.0.1', 'sudo -n id -u'])) == '0'
    shell = subprocess.run(base+['-i', str(work/'tunnel'), 'dt-'+'a'*16+'@127.0.0.1', 'id'], capture_output=True)
    assert shell.returncode != 0, 'Tunnel account unexpectedly allowed a command'
    cap = json.loads(capfile.read_text())
    assert cap['credentials'] is None and cap['report']['state'] == 'installed'
    run('bash', str(ROOT/'machines/bridge.sh'), str(manifest), env=env, stderr=subprocess.STDOUT)
    jump_keys = Path('/home/drover-jump/.ssh/authorized_keys')
    revoke_jump = work/'revoke-jump.json'
    revoke_jump.write_text(json.dumps(dict(action='revoke-jump', publicKey=agent_key)))
    run('bash', str(ROOT/'machines/bridge.sh'), str(revoke_jump), env=env, stderr=subprocess.STDOUT)
    assert jump_keys.read_text() == ''
    remove = work/'remove.json'
    remove.write_text(json.dumps(dict(action='remove', ids=['fixture'], agentsPublicKey=management_key)))
    run('bash', str(ROOT/'machines/bridge.sh'), str(remove), env=env, stderr=subprocess.STDOUT)
    assert jump_keys.read_text() == '', 'Delayed tunnel cleanup revived a revoked jump key'
    assert json.loads(Path('/var/lib/drover-machines/state.json').read_text())['agentsPublicKey'] == agent_key
    retire = work/'retire.json'; retire.write_text(json.dumps(dict(action='retire')))
    run('bash', str(ROOT/'machines/bridge.sh'), str(retire), env=env, stderr=subprocess.STDOUT)
    assert not capfile.exists()
    assert Path('/home/drover-jump/.ssh/authorized_keys').read_text() == ''
    assert Path('/home/dt-'+ 'a'*16 + '/.ssh/authorized_keys').read_text() == ''
    print('Container: real agent + management key login, reverse forward, no tunnel shell, single-use report, retirement OK')
finally:
    server.terminate(); server.wait(timeout=5)
