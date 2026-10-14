#!/usr/bin/env python3
"""User-owned Linux desktop bridge; never manages a system-wide service."""
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import shutil
import shlex
import urllib.request
from urllib.parse import urlsplit
from pathlib import Path

SERVICE = 'dev.drover.bridge.service'
PHONE_SERVICE = 'dev.drover.bridge.phone.service'
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
    with os.fdopen(fd, 'wb') as file:
        file.write(content if isinstance(content, bytes) else content.encode())
        file.flush(); os.fsync(file.fileno())
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


def unit_args(unit):
    lines = [line.removeprefix('ExecStart=') for line in unit.splitlines() if line.startswith('ExecStart=')]
    if len(lines) != 1: raise ValueError('expected one ExecStart')
    return [arg.replace('%%', '%').replace('$$', '$') for arg in shlex.split(lines[0])]


def active_exact(service, arguments):
    result = systemctl('show', service, *PROPERTIES, check=False)
    props = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    if result.returncode or props.get('ActiveState') != 'active' or props.get('SubState') != 'running': return False
    pid = props.get('MainPID', '')
    if not pid.isdigit() or int(pid) <= 0: return False
    try: return Path('/proc/' + pid + '/cmdline').read_bytes().rstrip(b'\0').split(b'\0') == [arg.encode() for arg in arguments]
    except OSError: return False


def wait_exact(service, arguments):
    for _ in range(30):
        if active_exact(service, arguments): return True
        time.sleep(.1)
    return False


def phone_url(url):
    parsed = urlsplit(url)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or
            parsed.path not in ('', '/') or parsed.query or parsed.fragment): raise ValueError('expected HTTPS origin')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args): return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(urllib.request.Request(url.rstrip('/') + '/pair', headers={'Cache-Control': 'no-cache'}), timeout=10) as response:
        body = response.read(512 * 1024 + 1).decode('utf-8', errors='replace')
        if response.status != 200 or len(body) > 512 * 1024 or '<title>Drover</title>' not in body or '/auth/assets/' not in body:
            raise ValueError('new phone endpoint is not the Drover auth page')


def phone_unit(data, p):
    connection = transport(dict(VPS_HOST=data['host'], VPS_USER=data['user'], VPS_PORT=str(data.get('port', 22))), p)
    routes = data.get('forwards')
    if data.get('phone') is not True or not isinstance(routes, list) or len(routes) != 1: raise ValueError('one phone forward required')
    route = routes[0]
    if route.get('listenHost') != '127.0.0.1' or route.get('targetHost') != '127.0.0.1': raise ValueError('non-loopback forward')
    for name in ('listenPort', 'targetPort'):
        if type(route.get(name)) is not int or not 1 <= route[name] <= 65535: raise ValueError('invalid port')
    if route['listenPort'] == 2222: raise ValueError('machine port is not a phone route')
    key, known = Path(data['keyPath']), Path(data['knownHostsPath'])
    for path in (key, known):
        safe(path)
        if not path.is_absolute() or not path.is_file() or path.stat().st_uid != os.getuid(): raise ValueError('unsafe credential path')
    if key.stat().st_mode & 0o077: raise ValueError('identity permissions')
    alias = data.get('hostKeyAlias') or (data['host'] if connection['port'] == 22 else f'[{data["host"]}]:{connection["port"]}')
    if not re.fullmatch(r'(?:[A-Za-z0-9][A-Za-z0-9._:-]*|\[[A-Za-z0-9][A-Za-z0-9.:-]*\]:[0-9]{1,5})', alias): raise ValueError('invalid pin alias')
    run(['ssh-keygen', '-F', alias, '-f', str(known)])
    args = ['/usr/bin/ssh', '-F', '/dev/null', '-N', '-T', '-R', f'127.0.0.1:{route["listenPort"]}:127.0.0.1:{route["targetPort"]}',
            '-p', str(connection['port']), '-i', str(key)]
    for option in ['IdentitiesOnly=yes', 'BatchMode=yes', 'ConnectTimeout=10', 'ConnectionAttempts=1',
                   'ServerAliveInterval=30', 'ServerAliveCountMax=3', 'ExitOnForwardFailure=yes',
                   'StrictHostKeyChecking=yes', 'UserKnownHostsFile=' + str(known),
                   'GlobalKnownHostsFile=/dev/null', 'HostKeyAlias=' + alias, 'LogLevel=ERROR']:
        args += ['-o', option]
    args += [data['user'] + '@' + data['host']]
    unit = '\n'.join(['[Unit]', 'Description=Drover phone reverse SSH bridge', '', '[Service]',
                      'Type=simple', 'ExecStart=' + ' '.join(map(quote, args)), 'Restart=always', 'RestartSec=10',
                      'UMask=0077', '', '[Install]', 'WantedBy=default.target', ''])
    return unit, args


def phone_transaction(data, env):
    p = paths(dict(env, HOME=data.get('home', env['HOME'])))
    phone = p['unit'].with_name(PHONE_SERVICE)
    marker = phone.with_suffix('.service.move.json')
    for path in (p['unit'], phone, marker): safe(path)
    if data['action'] == 'move-phone':
        if marker.exists(): raise ValueError('unfinished phone transaction')
        old_bytes, machine_bytes = phone.read_bytes(), p['unit'].read_bytes()
        old, machine = old_bytes.decode(), machine_bytes.decode()
        old_args, machine_args = unit_args(old), unit_args(machine)
        old_routes = [old_args[i + 1] for i, arg in enumerate(old_args[:-1]) if arg == '-R']
        machine_routes = [machine_args[i + 1] for i, arg in enumerate(machine_args[:-1]) if arg == '-R']
        if len(old_routes) != 1 or old_routes[0].split(':')[1] == '2222' or len(machine_routes) != 1 or machine_routes[0].split(':')[1] != '2222':
            raise ValueError('existing split machine and phone units required')
        if not active_exact(PHONE_SERVICE, old_args): raise ValueError('exact active phone service required')
        new, new_args = phone_unit(data, p)
        if old_args[-1].split('@')[-1] == data['host']: raise ValueError('different bridge endpoint required')
        transaction = Path(tempfile.mkdtemp(prefix='.drover-phone-', dir=phone.parent))
        candidate_service = 'dev.drover.bridge.phone.candidate-' + transaction.name.removeprefix('.drover-phone-') + '.service'
        candidate = phone.with_name(candidate_service)
        record = dict(home=str(p['home']), phonePath=str(phone), candidate=str(candidate), candidateService=candidate_service,
                      oldArguments=old_args, newArguments=new_args, machineArguments=machine_args, phase='prepared')
        write_atomic(transaction / 'phone.original', old_bytes, phone.stat().st_mode & 0o777)
        write_atomic(transaction / 'machine.original', machine_bytes, p['unit'].stat().st_mode & 0o777)
        write_atomic(transaction / 'transaction.json', json.dumps(record), 0o600)
        with marker.open('x') as file:
            os.fchmod(file.fileno(), 0o600); json.dump(dict(transaction=str(transaction)), file); file.flush(); os.fsync(file.fileno())
        try:
            write_atomic(candidate, new, 0o644)
            run(['systemd-analyze', '--user', 'verify', str(candidate)])
            systemctl('daemon-reload'); systemctl('start', candidate_service)
            if not wait_exact(candidate_service, new_args): raise ValueError('candidate SSH forwarding failed')
            phone_url(data['publicUrl'])
            if not active_exact(PHONE_SERVICE, old_args) or phone.read_bytes() != old_bytes or p['unit'].read_bytes() != machine_bytes:
                raise ValueError('original changed during verification')
            systemctl('stop', candidate_service)
            if systemctl('is-active', candidate_service, check=False).stdout.strip() == 'active': raise ValueError('candidate cleanup failed')
            write_atomic(phone, new, 0o644); systemctl('daemon-reload'); systemctl('restart', PHONE_SERVICE)
            if not wait_exact(PHONE_SERVICE, new_args): raise ValueError('canonical phone failed')
            phone_url(data['publicUrl'])
            record['phase'] = 'awaiting-settings'; write_atomic(transaction / 'transaction.json', json.dumps(record), 0o600)
            return dict(moved=True, verified=True, phoneTunnelRunning=True, tunnelRunning=active_exact(SERVICE, machine_args), missing=[], backupPath=str(transaction))
        except (OSError, ValueError, subprocess.SubprocessError):
            try: restored = phone_transaction(dict(action='rollback-phone', home=str(p['home']), backupPath=str(transaction)), env)
            except (OSError, ValueError, subprocess.SubprocessError): restored = dict(recovered=False, phoneTunnelRunning=False, tunnelRunning=active_exact(SERVICE, machine_args), backupPath=str(transaction))
            return {**restored, 'moved': False, 'verified': False, 'missing': ['phone_move_failed'] if restored['recovered'] else ['phone_recovery_incomplete']}
    transaction = Path(data['backupPath'])
    safe(transaction)
    if transaction.parent != phone.parent or not transaction.name.startswith('.drover-phone-') or json.loads(marker.read_text())['transaction'] != str(transaction):
        raise ValueError('invalid phone transaction')
    for name in ('transaction.json', 'phone.original', 'machine.original'): safe(transaction / name)
    record = json.loads((transaction / 'transaction.json').read_text())
    if record['home'] != str(p['home']) or record['phonePath'] != str(phone): raise ValueError('transaction home mismatch')
    if p['unit'].read_bytes() != (transaction / 'machine.original').read_bytes(): raise ValueError('machine unit changed')
    candidate = Path(record['candidate'])
    safe(candidate)
    if candidate.parent != phone.parent or candidate.name != record['candidateService'] or not re.fullmatch(r'dev\.drover\.bridge\.phone\.candidate-[A-Za-z0-9_-]+\.service', candidate.name):
        raise ValueError('invalid candidate unit')
    systemctl('stop', candidate.name)
    if systemctl('is-active', candidate.name, check=False).stdout.strip() == 'active': raise ValueError('candidate remains active')
    candidate.unlink(missing_ok=True); systemctl('daemon-reload')
    if data['action'] == 'finish-phone':
        if record['phase'] != 'awaiting-settings' or not active_exact(PHONE_SERVICE, record['newArguments']) or unit_args(phone.read_text()) != record['newArguments']: raise ValueError('new phone unit not verified')
        for child in transaction.iterdir(): safe(child)
        shutil.rmtree(transaction); marker.unlink()
        return dict(moved=True, verified=True, phoneTunnelRunning=True, tunnelRunning=active_exact(SERVICE, record['machineArguments']), missing=[])
    old_bytes = (transaction / 'phone.original').read_bytes()
    old = old_bytes.decode()
    current = unit_args(phone.read_text())
    if current not in (record['oldArguments'], record['newArguments']): raise ValueError('phone unit changed')
    if not active_exact(PHONE_SERVICE, record['oldArguments']):
        write_atomic(phone, old_bytes, (transaction / 'phone.original').stat().st_mode & 0o777)
        systemctl('daemon-reload'); systemctl('restart', PHONE_SERVICE)
    if active_exact(PHONE_SERVICE, record['oldArguments']):
        write_atomic(phone, old_bytes, (transaction / 'phone.original').stat().st_mode & 0o777)
    recovered = wait_exact(PHONE_SERVICE, record['oldArguments']) and phone.read_bytes() == old_bytes
    if recovered: marker.unlink()
    return dict(recovered=recovered, phoneTunnelRunning=recovered, tunnelRunning=active_exact(SERVICE, record['machineArguments']), missing=[] if recovered else ['phone_recovery_incomplete'], backupPath=str(transaction))


def main(argv, env=os.environ):
    if len(argv) == 1 and Path(argv[0]).is_file():
        data = json.loads(Path(argv[0]).read_text())
        if data.get('action') not in ('move-phone', 'rollback-phone', 'finish-phone'): raise ValueError('invalid phone action')
        print('DROVER_LINUX_BRIDGE_REPORT ' + json.dumps(phone_transaction(data, env)))
        return
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
