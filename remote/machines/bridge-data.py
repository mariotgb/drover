#!/usr/bin/env python3
"""Validate/render the dynamic bridge manifest; never execute supplied text."""
import json
import re
import sys
from pathlib import Path


def key(value):
    if not isinstance(value, str) or not re.fullmatch(r'(ssh-ed25519|ssh-rsa|ecdsa-sha2-[\w-]+) [A-Za-z0-9+/]+={0,2}', value):
        raise ValueError('invalid public key')
    return value


def plan(manifest, state, work):
    data = json.loads(Path(manifest).read_text())
    saved = json.loads(Path(state).read_text()) if Path(state).exists() else {'version': 1, 'targets': []}
    targets = data['targets'] if data['action'] == 'setup' else [t for t in saved['targets'] if t['id'] not in data['ids']]
    ports, users = set(), set()
    for t in targets:
        if not re.fullmatch(r'dt-[0-9a-f]{16}', t['user']) or type(t['port']) is not int or not 1024 <= t['port'] <= 65535 or t['port'] in (8780, 8791):
            raise ValueError('invalid tunnel account/port')
        if t['port'] in ports or t['user'] in users:
            raise ValueError('duplicate tunnel account/port')
        ports.add(t['port']); users.add(t['user']); key(t['publicKey'])
    # Removal must never rotate/revive a jump key from a delayed cleanup job.
    # Its snapshot can predate a separate jump-key revocation or rotation.
    agents = key(data['agentsPublicKey'] if data['action'] == 'setup' else saved['agentsPublicKey'])
    work = Path(work)
    new = {**saved, 'version': 1, 'targets': targets, 'agentsPublicKey': agents}
    if data['action'] == 'setup':
        new.update(origin=data['origin'], phone=data['phone'], phonePort=data['phonePort'])
    (work / 'state').write_text(json.dumps(new))
    entries = [(t['user'], 'remote', 'none', f'127.0.0.1:{t["port"]}', t['publicKey']) for t in targets]
    opened = ' '.join(f'127.0.0.1:{p}' for p in sorted(ports)) or 'none'
    entries.append(('drover-jump', 'local', opened, 'none', agents))
    # Previously owned targets remain denied until their sessions are terminated.
    removed = [t for t in saved['targets'] if t['user'] not in users]
    policy = ['# Drover Machines managed policy. Loopback forwarding only.']
    checks, keys = [], []
    for user, mode, opened, listen, pub in entries:
        policy += [f'Match User {user}', '    PubkeyAuthentication yes', '    PasswordAuthentication no',
                   '    KbdInteractiveAuthentication no', '    AuthenticationMethods publickey',
                   '    DisableForwarding no', f'    AllowTcpForwarding {mode}', f'    PermitOpen {opened}',
                   f'    PermitListen {listen}', '    GatewayPorts no', '    AllowStreamLocalForwarding no',
                   '    PermitTunnel no', '    AllowAgentForwarding no', '    X11Forwarding no',
                   '    PermitTTY no', '    MaxSessions 0', '    ClientAliveInterval 30', '    ClientAliveCountMax 3']
        opts = 'restrict,port-forwarding'
        for endpoint in (listen if mode == 'remote' else opened).split():
            if endpoint != 'none':
                opts += f',{"permitlisten" if mode == "remote" else "permitopen"}="{endpoint}"'
        keys.append(f'{user}|{opts}|{pub}')
        checks.append(f'{user}|{mode}|{opened}|{listen}')
    for t in removed:
        policy += [f'Match User {t["user"]}', '    PubkeyAuthentication no', '    PasswordAuthentication no',
                   '    KbdInteractiveAuthentication no', '    DisableForwarding yes', '    MaxSessions 0']
    policy += ['Match all', '']
    (work / 'policy').write_text('\n'.join(policy))
    (work / 'keys-plan').write_text('\n'.join(keys) + '\n')
    (work / 'checks').write_text('\n'.join(checks) + '\n')
    (work / 'removed').write_text('\n'.join(t['user'] for t in removed) + ('\n' if removed else ''))


def caddy(manifest):
    from urllib.parse import urlparse
    data = json.loads(Path(manifest).read_text())
    url = urlparse(data['origin'])
    if url.scheme != 'https' or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9.-]*', url.netloc):
        raise ValueError('invalid HTTPS origin')
    phone_port = data['phonePort']
    if type(phone_port) is not int or not 1024 <= phone_port <= 65535 or phone_port == 8791:
        raise ValueError('invalid phone tunnel port')
    # No access log, and secrets are redacted from runtime logs as well.
    print('''# Drover Machines Caddy configuration
{
 log default {
  format filter {
   wrap json
   fields {
    request>uri delete
    request>headers>Referer delete
    request>headers>Authorization delete
   }
  }
 }
}
''')
    print(url.netloc + ' {')
    print(' header {\n  Referrer-Policy no-referrer\n  X-Content-Type-Options nosniff\n  -Server\n }')
    print(' handle /machines/install/* {\n  request_body {\n   max_size 16KiB\n  }\n  reverse_proxy 127.0.0.1:8791\n }')
    if data['phone']:
        print(f' handle {{\n  reverse_proxy 127.0.0.1:{phone_port} {{\n   flush_interval -1\n  }}\n }}')
    else:
        print(' handle {\n  respond "Drover installers only" 404\n }')
    print('}')


def caddy_safe(path):
    p = Path(path)
    if p.is_symlink():
        raise ValueError('Caddyfile symlink')
    if not p.exists():
        return
    text = p.read_text()
    if text.startswith('# Drover Machines Caddy configuration\n') or text.startswith('# Managed by vps-web.sh\n'):
        return
    # Only the unmodified package welcome page may be adopted. A custom :80
    # block with other domains/routes must not be mistaken for that default.
    normalized = ' '.join(line.split('#', 1)[0].strip() for line in text.splitlines())
    if ' '.join(normalized.split()) != ':80 { root * /usr/share/caddy file_server }':
        raise ValueError('custom Caddyfile requires manual installer route integration')


if __name__ == '__main__':
    try:
        if sys.argv[1] == 'plan':
            plan(*sys.argv[2:])
        elif sys.argv[1] == 'caddy':
            caddy(sys.argv[2])
        elif sys.argv[1] == 'caddy-safe':
            caddy_safe(sys.argv[2])
        else:
            raise ValueError('unknown operation')
    except (ValueError, KeyError, TypeError, OSError) as e:
        sys.exit(f'drover bridge: {e}')
