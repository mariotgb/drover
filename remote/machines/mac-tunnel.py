#!/usr/bin/env python3
"""Provision the desktop tunnel using existing credentials and confirmed pins."""
import json
import os
import plistlib
import re
import subprocess
import sys
import time
from pathlib import Path

LABEL = 'dev.drover.bridge'


def safe_path(path):
    return not any(p.is_symlink() for p in (path, *path.parents))


def launch(*args):
    try:
        return subprocess.run(['launchctl', *args], text=True, capture_output=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        return None


def running(domain):
    result = launch('print', domain + '/' + LABEL)
    return bool(result and result.returncode == 0 and re.search(r'^\s*state = running\s*$', result.stdout, re.M) and
                re.search(r'^\s*pid = [1-9][0-9]*\s*$', result.stdout, re.M))


def wait_running(domain):
    for _ in range(12):
        if running(domain): return True
        time.sleep(0.25)
    return False


def port(value):
    if type(value) is not int or not 1 <= value <= 65535:
        raise ValueError('invalid port')
    return value


def option(args, flag):
    return [args[i + 1] for i in range(len(args) - 1) if args[i] == flag]


def main(data):
    action = data.get('action')
    if action not in ('verify', 'setup'):
        raise ValueError('invalid action')
    if sys.platform != 'darwin' and not (Path('/.dockerenv').exists() and data.get('home')):
        raise ValueError('macOS required')
    home = Path(data.get('home', str(Path.home())))
    if not home.is_absolute() or not safe_path(home):
        raise ValueError('invalid home')
    path = home / 'Library/LaunchAgents' / (LABEL + '.plist')
    domain = 'gui/' + str(os.getuid())
    base = dict(tunnelRunning=False, plistPath=str(path), missing=[])
    if not safe_path(path):
        base['missing'] = ['mac_bridge_plist_unsafe']; return base
    existing = None
    if path.exists():
        with path.open('rb') as file:
            existing = plistlib.load(file)
        if existing.get('Label') != LABEL:
            base['missing'] = ['mac_bridge_plist_conflict']; return base
    # Verify may be used to detect the old plist before any host is selected.
    if not data.get('host'):
        base['tunnelRunning'] = running(domain) if existing else False
        if not existing: base['missing'].append('mac_bridge_plist_missing')
        if not base['tunnelRunning']: base['missing'].append('mac_bridge_tunnel_stopped')
        if action == 'setup': raise ValueError('host required')
        return base
    host, user = data['host'], data.get('user', 'bridge-mac')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.:-]*', host) or not re.fullmatch(r'[a-z_][a-z0-9_-]*', user):
        raise ValueError('invalid SSH target')
    ssh_port = port(data.get('port', 22))
    forwards = data.get('forwards')
    if forwards is None:
        forwards = [dict(listenHost='127.0.0.1', listenPort=port(data.get('remoteSshPort', 2222)), targetHost='127.0.0.1', targetPort=port(data.get('localSshPort', 22)))]
        if data.get('phone') is not False:
            forwards.append(dict(listenHost='127.0.0.1', listenPort=8780, targetHost='127.0.0.1', targetPort=7780))
    rendered = []
    for f in forwards:
        if f.get('listenHost') != '127.0.0.1' or f.get('targetHost') not in ('127.0.0.1', 'localhost'):
            raise ValueError('non-loopback forward')
        rendered.append(f'127.0.0.1:{port(f["listenPort"])}:{f["targetHost"]}:{port(f["targetPort"])}')
    if not rendered or len(set(f['listenPort'] for f in forwards)) != len(forwards):
        raise ValueError('invalid forwards')
    args = existing.get('ProgramArguments', []) if existing else []
    if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
        raise ValueError('invalid plist arguments')
    identities = option(args, '-i')
    options = option(args, '-o')
    pins = [o.split('=', 1)[1] for o in options if o.startswith('UserKnownHostsFile=')]
    key_path = Path(data.get('keyPath') or (identities[0] if identities else str(home / '.ssh/mac_bridge_ed25519')))
    known = Path(data.get('knownHostsPath') or (pins[0] if pins else str(home / '.ssh/mac_bridge_known_hosts')))
    alias = data.get('hostKeyAlias')
    if alias and not re.fullmatch(r'(?:[A-Za-z0-9][A-Za-z0-9._:-]*|\[[A-Za-z0-9][A-Za-z0-9.:-]*\]:[0-9]{1,5})', alias):
        raise ValueError('invalid host alias')
    if existing:
        aliases = [o.split('=', 1)[1] for o in options if o.startswith('HostKeyAlias=')]
        alias = aliases[0] if aliases else None
    for candidate in (key_path, known):
        if not candidate.is_absolute() or not safe_path(candidate):
            raise ValueError('unsafe credential path')
    if not key_path.is_file() or key_path.stat().st_uid != os.getuid() or key_path.stat().st_mode & 0o077:
        base['missing'].append('mac_bridge_key_missing')
    if not known.is_file():
        base['missing'].append('mac_bridge_host_pin_missing')
    else:
        # ssh-keygen checks exact/hashed host entries; no reading private keys,
        # scanning hosts, accepting keys or printing pin contents.
        lookup = alias or (host if ssh_port == 22 else f'[{host}]:{ssh_port}')
        pin = subprocess.run(['ssh-keygen', '-F', lookup, '-f', str(known)], text=True, capture_output=True, timeout=15)
        if pin.returncode != 0 or not pin.stdout.strip(): base['missing'].append('mac_bridge_host_pin_missing')
    if existing:
        def normalize(value): return value.replace(':localhost:', ':127.0.0.1:')
        actual = {normalize(f) for f in option(args, '-R')}
        match = (args and args[0] == '/usr/bin/ssh' and f'{user}@{host}' in args and '-N' in args and
                 option(args, '-F') == ['/dev/null'] and option(args, '-p') == [str(ssh_port)] and
                 identities == [str(key_path)] and pins == [str(known)] and
                 {normalize(f) for f in rendered}.issubset(actual) and
                 'StrictHostKeyChecking=yes' in options and 'ExitOnForwardFailure=yes' in options)
        # Old scripts did not use HostKeyAlias. Keep their already confirmed
        # host pins and process instead of forcing a new managed alias.
        if not match: base['missing'].append('mac_bridge_plist_conflict')
        base['tunnelRunning'] = running(domain) if match else False
        if action == 'setup' and not base['missing'] and not base['tunnelRunning']:
            status = launch('print', domain + '/' + LABEL)
            if status and status.returncode != 0:
                loaded = launch('bootstrap', domain, str(path))
                base['tunnelRunning'] = wait_running(domain) if loaded and loaded.returncode == 0 else False
    elif action == 'setup' and not base['missing']:
        path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        logs = home / 'Library/Logs'
        if not safe_path(logs): raise ValueError('unsafe log path')
        logs.mkdir(mode=0o755, parents=True, exist_ok=True)
        new_args = ['/usr/bin/ssh', '-F', '/dev/null', '-N', '-T', '-p', str(ssh_port), '-i', str(key_path)]
        for f in rendered: new_args += ['-R', f]
        for setting in ['IdentitiesOnly=yes', 'BatchMode=yes', 'ServerAliveInterval=30', 'ServerAliveCountMax=3',
                        'ExitOnForwardFailure=yes', 'StrictHostKeyChecking=yes', 'UserKnownHostsFile=' + str(known),
                        'GlobalKnownHostsFile=/dev/null', 'LogLevel=ERROR']:
            new_args += ['-o', setting]
        if alias: new_args += ['-o', 'HostKeyAlias=' + alias]
        new_args += [f'{user}@{host}']
        plist = dict(Label=LABEL, ProgramArguments=new_args, RunAtLoad=True, KeepAlive=True, ThrottleInterval=10,
                     ProcessType='Background', StandardErrorPath=str(logs / (LABEL + '.log')),
                     StandardOutPath=str(logs / (LABEL + '.log')))
        # Exclusive create: never replace another provisioning attempt's plist.
        with path.open('xb') as file:
            os.fchmod(file.fileno(), 0o644); plistlib.dump(plist, file)
        loaded = launch('bootstrap', domain, str(path))
        if not loaded or loaded.returncode:
            path.unlink(); base['missing'].append('mac_bridge_bootstrap_failed')
        else:
            base['tunnelRunning'] = wait_running(domain)
    if not path.exists(): base['missing'].append('mac_bridge_plist_missing')
    if not base['tunnelRunning']: base['missing'].append('mac_bridge_tunnel_stopped')
    return base


if __name__ == '__main__':
    try:
        print('DROVER_MAC_BRIDGE_REPORT ' + json.dumps(main(json.loads(Path(sys.argv[1]).read_text())), separators=(',', ':')))
    except (ValueError, OSError, KeyError, TypeError, plistlib.InvalidFileException, subprocess.TimeoutExpired):
        sys.exit('Mac bridge setup failed: invalid or unavailable metadata')
