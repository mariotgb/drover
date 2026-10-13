#!/usr/bin/env python3
"""User-owned Linux desktop bridge; never manages a system-wide service."""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

SERVICE = 'dev.drover.bridge.service'
PROPERTIES = ['--property=ActiveState', '--property=SubState', '--property=MainPID']


def xdg(env, key, fallback):
    value = Path(env.get(key, str(fallback)))
    return value if value.is_absolute() else fallback


def paths(env):
    home = Path(env['HOME'])
    if not home.is_absolute():
        raise ValueError('HOME must be absolute')
    config = xdg(env, 'XDG_CONFIG_HOME', home / '.config')
    return dict(home=home, unit=config / 'systemd/user' / SERVICE,
                metadata=config / 'drover/bridge.json',
                key=home / '.ssh/drover_bridge_ed25519',
                known=home / '.ssh/drover_bridge_known_hosts')


def safe(path):
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError('Refusing a symlink in a managed path')
    if path.exists() and path.stat().st_uid != os.getuid():
        raise ValueError('Managed path is not owned by the current user')


def private_dir(path):
    safe(path)
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)


def run(args, check=True):
    return subprocess.run(args, text=True, capture_output=True, timeout=20, check=check)


def systemctl(*args, check=True):
    return run(['systemctl', '--user', *args], check)


def transport(env, p):
    host, user, port = env.get('VPS_HOST', ''), env.get('VPS_USER', 'bridge-mac'), env.get('VPS_PORT', '22')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]*', host):
        raise ValueError('Set a valid VPS_HOST')
    if not re.fullmatch(r'[a-z_][a-z0-9_-]*', user) or not re.fullmatch(r'\d{1,5}', port) or not 1 <= int(port) <= 65535:
        raise ValueError('Invalid VPS_USER or VPS_PORT')
    return dict(version=1, service=SERVICE, host=host, user=user, port=int(port),
                identityFile=str(p['key']), knownHostsFile=str(p['known']),
                forwards=[dict(listenHost='127.0.0.1', listenPort=2222, targetHost='localhost', targetPort=22),
                          dict(listenHost='127.0.0.1', listenPort=8780, targetHost='127.0.0.1', targetPort=7780)])


def quote(value):
    if any(ord(c) < 32 for c in value):
        raise ValueError('Control characters are not allowed in unit arguments')
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%').replace('$', '$$') + '"'


def render(data):
    args = ['/usr/bin/ssh', '-F', '/dev/null', '-N', '-R', '127.0.0.1:2222:localhost:22',
            '-R', '127.0.0.1:8780:127.0.0.1:7780', '-p', str(data['port']), '-i', data['identityFile']]
    for option in ['IdentitiesOnly=yes', 'BatchMode=yes', 'ServerAliveInterval=30', 'ServerAliveCountMax=3',
                   'ExitOnForwardFailure=yes', 'StrictHostKeyChecking=yes',
                   'UserKnownHostsFile=' + data['knownHostsFile'], 'LogLevel=ERROR']:
        args += ['-o', option]
    args += [data['user'] + '@' + data['host']]
    return '\n'.join(['[Unit]', 'Description=Drover reverse SSH bridge',
                      '', '[Service]', 'Type=simple', 'ExecStart=' + ' '.join(map(quote, args)),
                      'Restart=always', 'RestartSec=10', 'UMask=0077',
                      '', '[Install]', 'WantedBy=default.target', ''])


def write_atomic(path, content, mode):
    safe(path)
    temp = path.with_name(path.name + '.new')
    safe(temp)
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'w') as file:
        file.write(content)
    temp.chmod(mode)
    temp.replace(path)


def ensure_key(key):
    private_dir(key.parent)
    safe(key)
    safe(Path(str(key) + '.pub'))
    if key.exists():
        if not key.is_file() or key.stat().st_mode & 0o777 != 0o600:
            raise ValueError('Existing SSH private key must be a regular file with mode 0600')
    else:
        run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'drover-bridge', '-f', str(key)])


def install(data, p):
    # A user bus is required; do not silently install a system service or enable linger.
    systemctl('show-environment')
    ensure_key(p['key'])
    safe(p['known'])
    if not p['known'].exists() or not p['known'].read_text().strip():
        scan = run(['ssh-keyscan', '-T', '10', '-p', str(data['port']), '-t', 'ed25519', data['host']]).stdout
        if not scan.strip():
            raise ValueError('Could not fetch the VPS host key')
        fingerprint = subprocess.run(['ssh-keygen', '-lf', '-'], input=scan, text=True, capture_output=True, check=True).stdout
        print(fingerprint.strip())
        print('Compare with the VPS: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub')
        if input('Does it match? [y/N] ').lower() != 'y':
            raise ValueError('Aborted; no service installed')
        write_atomic(p['known'], scan, 0o600)
    if not p['known'].is_file() or p['known'].stat().st_mode & 0o777 != 0o600:
        raise ValueError('Pinned known_hosts must be a regular file with mode 0600')
    # Require a pin for this target, even if a pin for another VPS already exists.
    target = data['host'] if data['port'] == 22 else '[' + data['host'] + ']:' + str(data['port'])
    run(['ssh-keygen', '-F', target, '-f', str(p['known'])])
    private_dir(p['unit'].parent)
    private_dir(p['metadata'].parent)
    for name in ['unit', 'metadata']:
        safe(p[name])
    previous = {name: p[name].read_text() if p[name].exists() else None for name in ['unit', 'metadata']}
    enabled = systemctl('is-enabled', SERVICE, check=False).stdout.strip() == 'enabled'
    active = systemctl('is-active', SERVICE, check=False).stdout.strip() == 'active'
    try:
        write_atomic(p['unit'], render(data), 0o644)
        write_atomic(p['metadata'], json.dumps(data, indent=2) + '\n', 0o600)
        run(['systemd-analyze', '--user', 'verify', str(p['unit'])])
        systemctl('daemon-reload')
        systemctl('enable', SERVICE)
        systemctl('restart', SERVICE)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        for name, content in previous.items():
            if content is None:
                p[name].unlink(missing_ok=True)
            else:
                write_atomic(p[name], content, 0o644 if name == 'unit' else 0o600)
        recovered = True
        for args in [('daemon-reload',), ('enable' if enabled else 'disable', SERVICE),
                     ('restart' if active else 'stop', SERVICE)]:
            try:
                recovered = systemctl(*args, check=False).returncode == 0 and recovered
            except (OSError, subprocess.SubprocessError):
                recovered = False
        raise ValueError('Install failed; previous files restored; service rollback ' + ('succeeded' if recovered else 'requires manual repair')) from error
    print('Installed ' + SERVICE + '; logs: journalctl --user -u ' + SERVICE)
    print('Starts with the user manager. Use loginctl enable-linger yourself only if it should survive logout.')


def status(p):
    safe(p['metadata'])
    data = json.loads(p['metadata'].read_text()) if p['metadata'].exists() else None
    try:
        result = systemctl('show', SERVICE, *PROPERTIES, check=False)
        props = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
        running = result.returncode == 0 and props.get('ActiveState') == 'active' and props.get('SubState') == 'running' and props.get('MainPID', '0').isdigit() and int(props.get('MainPID', '0')) > 0
    except (OSError, subprocess.SubprocessError):
        props, running = {}, False
    return dict(service=SERVICE, unitPath=str(p['unit']), metadataPath=str(p['metadata']),
                transport=data, tunnelRunning=running, properties=props)


def main(argv, env=os.environ):
    p = paths(env)
    command = argv[0] if argv else ''
    if command == 'render':
        print(render(transport(env, p)), end='')
    elif command == 'bridge':
        install(transport(env, p), p)
    elif command == 'status':
        print(json.dumps(status(p)))
    elif command == 'keys':
        for name in ['drover_bridge_ed25519', 'drover_jump_ed25519', 'agents_ed25519']:
            key = p['home'] / '.ssh' / name
            ensure_key(key)
            print(str(key) + '.pub')
    elif command == 'uninstall':
        for name in ['unit', 'metadata', 'known']:
            safe(p[name])
        systemctl('disable', '--now', SERVICE)
        for name in ['unit', 'metadata', 'known']:
            p[name].unlink(missing_ok=True)
        systemctl('daemon-reload')
        print('User service, metadata and pin removed; SSH private keys retained')
    else:
        raise ValueError('Linux commands: keys, bridge, render, status, uninstall. Configure distro sshd separately; Mac ssh hardening is not applied.')


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print('ERROR: ' + str(error), file=sys.stderr)
        sys.exit(1)
