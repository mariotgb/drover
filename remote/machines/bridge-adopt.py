#!/usr/bin/env python3
"""Read-only bridge inventory. Never installs, rewrites keys or reloads services."""
import json
import os
import pwd
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

LEGACY = {
    'bridge-mac': ('remote', [], [2222, 8780]),
    'bridge-pc': ('remote', [], [2223]),
    'bridge-home': ('remote', [], [2224]),
    'jump': ('local', [2222, 2223, 2224], []),
}


def command(args, body=None):
    try:
        return subprocess.run(args, input=body, text=True, capture_output=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        return None


def safe_file(path):
    path = Path(path)
    return not any(p.is_symlink() for p in (path, *path.parents)) and path.is_file()


def forwards(data):
    result = []
    for f in data.get('forwards', []):
        if f.get('listenHost') != '127.0.0.1' or f.get('targetHost') not in ('127.0.0.1', 'localhost', '::1'):
            raise ValueError('non-loopback forward')
        for name in ('listenPort', 'targetPort'):
            if type(f.get(name)) is not int or not 1 <= f[name] <= 65535:
                raise ValueError('invalid forward port')
        result.append(f['listenPort'])
    return result


def endpoints(values):
    return {f'127.0.0.1:{p}' for p in values}


def effective(user):
    connection = os.environ.get('SSH_CONNECTION', '').split()
    addr, laddr, port = (connection[0], connection[2], connection[3]) if len(connection) == 4 else ('127.0.0.1', '127.0.0.1', '22')
    if not all(re.fullmatch(r'[0-9A-Fa-f:.]+', a) for a in (addr, laddr)) or not port.isdigit():
        raise ValueError('invalid SSH context')
    result = command([os.environ.get('SSHD_BIN', '/usr/sbin/sshd'), '-T', '-f', os.environ.get('SSHD_CONFIG', '/etc/ssh/sshd_config'),
                      '-C', f'user={user},host={addr},addr={addr},laddr={laddr},lport={port}'])
    if not result or result.returncode:
        return {}
    config = {}
    for line in result.stdout.splitlines():
        fields = line.split()
        if fields:
            config.setdefault(fields[0], []).extend(fields[1:])
    return config


def policy_ready(config, user, spec, account):
    mode, opened, listened = spec
    required = dict(allowtcpforwarding=mode, gatewayports='no', maxsessions='0', passwordauthentication='no',
                    kbdinteractiveauthentication='no', pubkeyauthentication='yes', authenticationmethods='publickey',
                    disableforwarding='no', allowstreamlocalforwarding='no', allowagentforwarding='no',
                    permittunnel='no', permittty='no', x11forwarding='no')
    if any(config.get(k) != [v] for k, v in required.items()):
        return False
    for key, ports in (('permitopen', opened), ('permitlisten', listened)):
        actual = set(config.get(key, [])) - {'none'}
        permitted = endpoints(ports)
        if user in LEGACY:
            permitted |= endpoints(LEGACY[user][1 if key == 'permitopen' else 2])
        if not endpoints(ports).issubset(actual) or not actual.issubset(permitted):
            return False
    # Restrict accepted globs to user/group-only patterns. HOST/CIDR policy
    # needs additional caller contexts and is never silently accepted.
    def allowed(name, allow, deny):
        import fnmatch
        return not any('@' in p for p in allow + deny) and (not allow or any(fnmatch.fnmatchcase(name, p) for p in allow)) and not any(fnmatch.fnmatchcase(name, p) for p in deny)
    if not allowed(user, config.get('allowusers', []), config.get('denyusers', [])):
        return False
    groups = [user]
    if account:
        import grp
        groups = [grp.getgrgid(g).gr_name for g in os.getgrouplist(user, account.pw_gid)]
    allow, deny = config.get('allowgroups', []), config.get('denygroups', [])
    return any(allowed(g, allow, deny) for g in groups) and not any(not allowed(g, [], deny) for g in groups)


def key_options(account, spec):
    if not account or account.pw_uid == 0 or account.pw_gecos.split(',')[0] != 'Drover hub' or account.pw_shell not in ('/usr/sbin/nologin', '/sbin/nologin', '/bin/false'):
        return False
    path = Path(account.pw_dir) / '.ssh/authorized_keys'
    if not safe_file(path):
        return False
    mode, opened, listened = spec
    permitted = endpoints(opened if mode == 'local' else listened)
    # A phone-disabled verification may request just 2222; existing legacy
    # grants for the other documented loopback ports remain valid.
    if account.pw_name in LEGACY:
        legacy_mode, legacy_open, legacy_listen = LEGACY[account.pw_name]
        permitted |= endpoints(legacy_open if legacy_mode == 'local' else legacy_listen)
    option = 'permitopen' if mode == 'local' else 'permitlisten'
    valid, all_grants = 0, set()
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        try:
            fields = shlex.split(line)
        except ValueError:
            return False
        result = command(['ssh-keygen', '-lf', '-', '-E', 'sha256'], line + '\n')
        if len(fields) < 3 or not result or result.returncode:
            return False
        options = fields[0].split(',')
        grants = {o.split('=', 1)[1] for o in options if o.startswith(option + '=')}
        if 'restrict' not in options or 'port-forwarding' not in options or (permitted and not grants) or not grants.issubset(permitted):
            return False
        valid += 1; all_grants |= grants
    required = endpoints(opened if mode == 'local' else listened)
    return valid > 0 and required.issubset(all_grants)


def caddy_report(public_url, expected_port):
    result = {'configured': False, 'active': False, 'installerRoute': False}
    status = command(['systemctl', 'is-active', '--quiet', 'caddy'])
    result['active'] = bool(status and status.returncode == 0)
    path = os.environ.get('CADDYFILE', '/etc/caddy/Caddyfile')
    if not safe_file(path) or not shutil.which('caddy'):
        return result
    # Caddy parses its own config (including imports/auth), but its output and
    # diagnostics are never forwarded. Only hostname/upstream metadata escapes.
    adapted = command(['caddy', 'adapt', '--config', path, '--adapter', 'caddyfile'])
    if not adapted or adapted.returncode:
        return result
    try:
        servers = json.loads(adapted.stdout).get('apps', {}).get('http', {}).get('servers', {})
    except ValueError:
        return result
    requested = urlparse(public_url).hostname if public_url else None
    found, installer_hosts = [], []
    def visit(routes, hosts=(), paths=()):
        for route in routes:
            scoped = tuple(h for m in route.get('match', []) for h in m.get('host', [])) or hosts
            # A path-specific installer route cannot prove the phone route.
            scoped_paths = tuple(p for m in route.get('match', []) for p in m.get('path', [])) or paths
            for handler in route.get('handle', []):
                if handler.get('handler') == 'reverse_proxy':
                    for upstream in handler.get('upstreams', []):
                        if upstream.get('dial') == '127.0.0.1:8791' and scoped_paths == ('/machines/install/*',):
                            installer_hosts.extend(h for h in scoped if re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]*', h))
                        if upstream.get('dial') == f'127.0.0.1:{expected_port}' and not scoped_paths:
                            found.extend(h for h in scoped if re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]*', h))
                visit(handler.get('routes', []), scoped, scoped_paths)
    for server in servers.values():
        visit(server.get('routes', []))
    selected = requested if requested in found else (found[0] if found and not requested else None)
    if selected:
        result.update(configured=True, publicUrl='https://' + selected, upstream=f'127.0.0.1:{expected_port}')
    result['installerRoute'] = requested in installer_hosts if requested else bool(installer_hosts)
    return result


def report(data):
    if data.get('action') not in ('verify', 'adopt'):
        raise ValueError('invalid action')
    legacy = data.get('legacy', {})
    specs = dict(LEGACY)
    state_path = Path(os.environ.get('DROVER_BRIDGE_STATE', '/var/lib/drover-machines')) / 'state.json'
    managed = []
    if safe_file(state_path):
        state = json.loads(state_path.read_text())
        ports = []
        for target in state.get('targets', []):
            name, port = target['user'], target['port']
            if not re.fullmatch(r'dt-[0-9a-f]{16}', name) or type(port) is not int or not 1024 <= port <= 65535:
                raise ValueError('invalid managed metadata')
            specs[name] = ('remote', [], [port]); managed.append(name); ports.append(port)
        specs['drover-jump'] = ('local', ports, []); managed.append('drover-jump')
    users = legacy.get('users')
    if users is None:
        users = []
        for name in list(LEGACY) + managed:
            try: pwd.getpwnam(name); users.append(name)
            except KeyError: pass
        if not users: users = ['bridge-mac', 'jump']
    if not isinstance(users, list) or not users or any(name not in specs for name in users) or len(set(users)) != len(users):
        raise ValueError('invalid bridge users')
    requested_ports = forwards(legacy)
    tunnel_user = legacy.get('tunnelUser', 'bridge-mac')
    if requested_ports:
        if tunnel_user not in specs or specs[tunnel_user][0] != 'remote':
            raise ValueError('invalid tunnel user')
        specs[tunnel_user] = ('remote', [], requested_ports)
    missing, accounts = [], []
    policy = True
    for name in users:
        try: account = pwd.getpwnam(name)
        except KeyError: account = None
        config = effective(name)
        restricted = key_options(account, specs[name])
        policy = policy and policy_ready(config, name, specs[name], account) and restricted
        # Unknown/broad policy is a repair item, never a malformed API response.
        listens = [v for v in config.get('permitlisten', []) if v == 'none' or re.fullmatch(r'127\.0\.0\.1:[0-9]{1,5}', v)]
        accounts.append(dict(name=name, exists=bool(account), permitListen=listens, authorizedKeyOptions=restricted))
    if any(not a['exists'] for a in accounts): missing.append('bridge_users_missing')
    if not policy: missing.append('bridge_policy_missing')
    public_url = legacy.get('publicUrl')
    if public_url:
        url = urlparse(public_url)
        if url.scheme != 'https' or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]*', url.netloc) or url.path not in ('', '/') or url.query or url.fragment:
            raise ValueError('invalid public URL')
    phone = legacy.get('phone', data.get('phone', True)) is not False and bool(public_url)
    phone_ports = [p for p in requested_ports if p != 2222]
    caddy = caddy_report(public_url, phone_ports[0] if phone_ports else 8780)
    firewall = False
    status = command(['ufw', 'status']) if shutil.which('ufw') else None
    if status and status.returncode == 0:
        if 'Status: active' in status.stdout:
            needed = {80, 443}
            allowed = {int(m.group(1)) for m in re.finditer(r'^\s*(80|443)/tcp(?:\s+\(v6\))?\s+ALLOW(?: IN)?\s+Anywhere\s*$', status.stdout, re.M)}
            firewall = needed.issubset(allowed)
    if phone and not firewall: missing.append('bridge_firewall_missing')
    if phone and not (caddy['configured'] and caddy['active']): missing.append('phone_route_missing')
    sockets = command(['ss', '-ltnH'])
    listeners = []
    if sockets and sockets.returncode == 0:
        for line in sockets.stdout.splitlines():
            fields = line.split()
            if len(fields) >= 4 and re.fullmatch(r'127\.0\.0\.1:[0-9]+', fields[3]):
                listeners.append(int(fields[3].rsplit(':', 1)[1]))
    return dict(users=accounts, jumpUser='drover-jump' if 'drover-jump' in users else 'jump', policy=policy,
                firewall=firewall, caddy=caddy, listeners=sorted(set(listeners)), missing=missing)


if __name__ == '__main__':
    try:
        print('DROVER_BRIDGE_REPORT ' + json.dumps(report(json.loads(Path(sys.argv[1]).read_text())), separators=(',', ':')))
    except (ValueError, OSError, KeyError, TypeError):
        sys.exit('bridge verification failed: invalid or unavailable metadata')
