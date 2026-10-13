#!/usr/bin/env python3
"""Full local installer recovery in an isolated container with real orphan SSH."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time

ROOT = Path('/fixture/remote/machines')
if not Path('/.dockerenv').exists() or os.environ.get('DROVER_MACHINE_CONTAINER_TEST') != '1':
    sys.exit('Run only in the isolated Machines check container.')
work = Path('/tmp/drover-recovery-check'); work.mkdir(mode=0o700)


def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def key(name):
    path = work / name
    run('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(path))
    return ' '.join(Path(str(path) + '.pub').read_text().split()[:2])


old_agent, old_management, unrelated, new_agent, new_management = [key(n) for n in ('old-agent', 'old-management', 'unrelated', 'new-agent', 'new-management')]
replacement = len(sys.argv) > 1 and sys.argv[1] == 'bridge'
new_tunnel = key('new-tunnel') if replacement else None
run('useradd', '--user-group', '--create-home', '--shell', '/bin/bash', '--comment', 'Drover managed agent', 'agent')
authdir = Path('/home/agent/.ssh'); authdir.mkdir(mode=0o700)
auth = authdir / 'authorized_keys'
auth.write_text('restrict,command="echo read only" ' + old_agent + ' untagged-old\n' + old_management + '\n' + unrelated + ' personal-fixture\n')
uid = int(run('id', '-u', 'agent')); gid = int(run('id', '-g', 'agent'))
os.chown(authdir, uid, gid); os.chown(auth, uid, gid); auth.chmod(0o600)
original = auth.read_text()
directory = Path('/var/lib/drover-machine-tunnel'); directory.mkdir(mode=0o700)
config = directory / 'ssh_config'
config.write_text('Host drover-bridge\n HostName 127.0.0.1\n Port 22222\n BatchMode yes\n ConnectTimeout 30\n StrictHostKeyChecking no\n')
(directory / 'id_ed25519').write_text((work / 'old-agent').read_text())
unit = Path('/etc/systemd/system/drover-machine-tunnel.service')
unit.write_text('[Unit]\nDescription=Drover machine reverse SSH tunnel\n[Service]\nExecStart=/usr/bin/ssh -F /var/lib/drover-machine-tunnel/ssh_config -N -T drover-bridge\n')
fake = work / 'bin'; fake.mkdir()
(fake / 'systemctl').write_text('''#!/bin/bash
set -eu
case "${1:-}:${2:-}" in
 disable:--now) [ "${3:-}" = drover-machine-tunnel ] || exit 1; echo disabled >> /tmp/drover-recovery-check/lifecycle; exit 0;;
 is-active:drover-machine-tunnel) echo inactive; exit 3;;
 cat:ssh.service) exit 0;;
 reload:ssh|reload:sshd) exit 0;;
esac
exit 0
''')
(fake / 'systemd-analyze').write_text('#!/bin/sh\nexit 0\n')
for file in fake.iterdir():
    file.chmod(0o755)
env = {**os.environ, 'PATH': str(fake) + ':' + os.environ['PATH']}
token = secrets.token_urlsafe(32); receipt = secrets.token_urlsafe(32)
caps = work / 'capabilities'; caps.mkdir(mode=0o700)
capfile = caps / (token + '.json')
credentials = dict(version=1, machineId='fixture', os='linux', agentsPublicKey=new_agent, managementPublicKey=new_management,
                   agentsAuthorizedKey=new_agent + ' drover-agents', permissionSetupScript='', permissions='full',
                   receipt=receipt, reportUrl=f'http://127.0.0.1:8791/machines/install/{token}/report', bridge=None,
                   recoveryCleanup=dict(id='recovery-fixture', agentsPublicKeys=[old_agent], managementPublicKey=old_management))
if replacement:
    host_key = ' '.join(Path('/etc/ssh/ssh_host_ed25519_key.pub').read_text().split()[:2])
    credentials['bridge'] = dict(host='127.0.0.1', sshPort=22, user='dt-'+'b'*16, port=24568, hostKey=host_key,
                                 tunnelPublicKey=new_tunnel, tunnelPrivateKey=(work/'new-tunnel').read_text())
capfile.write_text(json.dumps(dict(expiresAt=time.time() * 1000 + 7200000, credentials=credentials,
                                 receipt=receipt, machineId='fixture', os='linux', script='', cleanupId='recovery-fixture')))
script = (ROOT / 'install-unix.sh').read_text().replace('__DROVER_OS__', 'linux').replace('__DROVER_KEY_URL__', f'http://127.0.0.1:8791/machines/install/{token}/key').replace('__DROVER_RECOVERY_UNIX__', (ROOT / 'recovery-unix.py').read_text())
server = subprocess.Popen(['python3', str(ROOT / 'capability-server.py')], env={**env, 'DROVER_CAPABILITIES': str(caps)}, stdout=subprocess.DEVNULL)
# A fake peer stalls the real root SSH before authentication. It is deliberately
# outside systemctl's lifecycle, reproducing an orphan old tunnel process.
peer_script = work / 'peer.py'
peer_script.write_text('import socket,time\ns=socket.socket();s.bind(("127.0.0.1",22222));s.listen();c,_=s.accept();time.sleep(60)\n')
peer = subprocess.Popen(['python3', str(peer_script)])
orphan = None
try:
    time.sleep(0.2)
    orphan = subprocess.Popen(['/usr/bin/ssh', '-F', str(config), '-N', '-T', 'drover-bridge'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.1); assert orphan.poll() is None
    # Foreign unit fails closed BEFORE keys/new installation/receipt.
    valid_unit = unit.read_text(); unit.write_text('[Unit]\nDescription=Personal tunnel\n')
    local = work / 'direct'; local.mkdir(); (local / 'credentials.json').write_text(json.dumps(credentials))
    failed = subprocess.run(['python3', str(ROOT / 'recovery-unix.py'), str(local)], env=env, text=True, capture_output=True)
    assert failed.returncode != 0 and not (local / 'recovery.done').exists()
    assert auth.read_text() == original and orphan.poll() is None
    unit.write_text(valid_unit)
    # A real installer must retire the orphan and old service even for LAN.
    result = subprocess.run(['bash'], input=script, env=env, text=True, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    orphan.wait(timeout=3)
    assert orphan.returncode != 0, 'Old orphan tunnel survived recovery'
    if replacement:
        assert (directory/'id_ed25519').read_text() == (work/'new-tunnel').read_text()
        assert 'User dt-'+'b'*16 in config.read_text()
        assert unit.exists()
    else:
        assert not directory.exists() and not unit.exists(), 'LAN recovery left old tunnel files'
    assert (work / 'lifecycle').read_text().strip() == 'disabled'
    final = auth.read_text()
    assert old_agent.split()[1] not in final and old_management.split()[1] not in final
    assert unrelated + ' personal-fixture' in final
    assert new_agent + ' drover-agents' in final and new_management + ' drover-management' in final
    cap = json.loads(capfile.read_text())
    assert cap['credentials'] is None and cap['report']['cleanupId'] == 'recovery-fixture'
    assert cap['report']['state'] == 'installed'
    print('Recovery: old restricted/untagged keys + real orphan tunnel removed; '+('replacement bridge' if replacement else 'LAN')+' installs new keys, preserves unrelated key, bound receipt OK')
finally:
    for process in [orphan, peer, server]:
        if process and process.poll() is None:
            process.terminate(); process.wait(timeout=5)
