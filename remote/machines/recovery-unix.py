#!/usr/bin/env python3
"""Local recovery only: retire Drover's old tunnel and exact old public keys."""
import json
import os
from pathlib import Path
import plistlib
import pwd
import re
import shlex
import signal
import subprocess
import sys
import tempfile
import time


def safe(path):
    for item in [path, *path.parents]:
        if item.is_symlink() and str(item) not in ('/var', '/tmp'):
            raise ValueError('symlink in recovery path')


def run(*args):
    return subprocess.run(args, text=True, capture_output=True, check=True).stdout.strip()


def key(value):
    if not isinstance(value, str) or not re.fullmatch(r'(ssh-ed25519|ssh-rsa|ecdsa-sha2-[\w-]+) [A-Za-z0-9+/]+={0,2}', value):
        raise ValueError('invalid recovery key')
    return value.split()[1]


def blobs(line):
    fields = shlex.split(line, comments=True)
    return [fields[i + 1] for i, field in enumerate(fields[:-1])
            if re.fullmatch(r'ssh-ed25519|ssh-rsa|ecdsa-sha2-[\w-]+', field)]


def processes(config):
    rows = run('ps', '-axo', 'pid=,uid=,lstart=,args=').splitlines()
    found = {}
    for row in rows:
        fields = row.split(None, 7)
        if len(fields) != 8 or fields[1] != '0':
            continue
        try:
            args = shlex.split(fields[7])
        except ValueError:
            continue
        if args == ['/usr/bin/ssh', '-F', str(config), '-N', '-T', 'drover-bridge']:
            found[int(fields[0])] = ' '.join(fields[2:7])
    return found


def recover(work):
    d = json.loads((work / 'credentials.json').read_text())
    recovery = d.get('recoveryCleanup')
    if recovery is None:
        return
    if os.geteuid() != 0 or not isinstance(recovery, dict) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', recovery.get('id', '')):
        raise ValueError('invalid recovery request')
    keys = recovery.get('agentsPublicKeys')
    if not isinstance(keys, list) or len(keys) > 1000:
        raise ValueError('invalid recovery keys')
    removed = {key(value) for value in [*keys, recovery['managementPublicKey']]}
    linux = d['os'] == 'linux'
    account = pwd.getpwnam('agent')
    marker = account.pw_gecos if linux else run('dscl', '.', '-read', '/Users/agent', 'RealName').removeprefix('RealName: ')
    if account.pw_uid == 0 or marker != 'Drover managed agent':
        raise ValueError('unmarked recovery account')
    home = Path(account.pw_dir); auth = home / '.ssh/authorized_keys'
    safe(auth)
    if auth.exists() and (not auth.is_file() or auth.stat().st_uid != account.pw_uid):
        raise ValueError('unsafe recovery authorized_keys')
    directory = Path('/var/lib/drover-machine-tunnel' if linux else '/Library/Drover/machine-tunnel')
    unit = Path('/etc/systemd/system/drover-machine-tunnel.service' if linux else '/Library/LaunchDaemons/dev.drover.machine-tunnel.plist')
    safe(directory); safe(unit)
    names = {'id_ed25519', 'id_ed25519.pub', 'ssh_config', 'known_hosts', 'ssh_config.new',
             'known_hosts.new', 'ssh_config.previous', 'known_hosts.previous'}
    if directory.exists():
        if not directory.is_dir() or directory.stat().st_uid != 0:
            raise ValueError('unsafe recovery tunnel directory')
        for file in directory.iterdir():
            safe(file)
            if file.name not in names or not file.is_file() or file.stat().st_uid != 0:
                raise ValueError('foreign recovery tunnel file')
    if unit.exists():
        if not unit.is_file() or unit.stat().st_uid != 0:
            raise ValueError('unsafe recovery tunnel unit')
        if linux:
            lines = unit.read_text().splitlines()
            if 'Description=Drover machine reverse SSH tunnel' not in lines or 'ExecStart=/usr/bin/ssh -F /var/lib/drover-machine-tunnel/ssh_config -N -T drover-bridge' not in lines:
                raise ValueError('foreign recovery tunnel unit')
        else:
            data = plistlib.loads(unit.read_bytes())
            if data.get('Label') != 'dev.drover.machine-tunnel' or data.get('ProgramArguments') != ['/usr/bin/ssh', '-F', str(directory / 'ssh_config'), '-N', '-T', 'drover-bridge']:
                raise ValueError('foreign recovery launch daemon')
    # Complete preflight and parse existing key lines BEFORE stopping anything.
    original = auth.read_text() if auth.exists() else ''
    kept = [line for line in original.splitlines() if not removed.intersection(blobs(line))]
    if linux:
        if unit.exists():
            run('systemctl', 'disable', '--now', 'drover-machine-tunnel')
            state = subprocess.run(['systemctl', 'is-active', 'drover-machine-tunnel'], text=True, capture_output=True)
            if state.stdout.strip() not in ('inactive', 'failed', 'unknown'):
                raise ValueError('old tunnel is still active')
    else:
        loaded = subprocess.run(['launchctl', 'print', 'system/dev.drover.machine-tunnel'], capture_output=True)
        if loaded.returncode == 0:
            run('launchctl', 'bootout', 'system/dev.drover.machine-tunnel')
    # Service managers can leave ssh children behind. Match only the exact old
    # protected root tunnel, preserving unrelated SSH and the installer ancestry.
    config = directory / 'ssh_config'
    for pid, birth in processes(config).items():
        if processes(config).get(pid) == birth:
            os.kill(pid, signal.SIGTERM)
    for _ in range(30):
        if not processes(config):
            break
        time.sleep(0.1)
    if processes(config):
        raise ValueError('old tunnel process did not stop')
    if unit.exists():
        unit.unlink()
    if directory.exists():
        for file in directory.iterdir():
            file.unlink()
        directory.rmdir()
    if linux:
        run('systemctl', 'daemon-reload')
    if auth.exists():
        fd, temporary = tempfile.mkstemp(prefix='.drover-recovery.', dir=auth.parent)
        try:
            with os.fdopen(fd, 'w') as file:
                os.fchmod(file.fileno(), 0o600); os.fchown(file.fileno(), account.pw_uid, account.pw_gid)
                file.write('\n'.join(kept) + ('\n' if kept else '')); file.flush(); os.fsync(file.fileno())
            os.replace(temporary, auth)
            if any(removed.intersection(blobs(line)) for line in auth.read_text().splitlines()):
                raise ValueError('old key removal incomplete')
        finally:
            Path(temporary).unlink(missing_ok=True)
    (work / 'recovery.done').write_text(recovery['id'])


if __name__ == '__main__':
    recover(Path(sys.argv[1]))
