#!/usr/bin/env python3
"""Validate/render the dynamic bridge manifest; never execute supplied text."""
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path


class Conflict(ValueError):
    def __init__(self, code): self.code = code


def key(value):
    if not isinstance(value, str) or not re.fullmatch(r'(ssh-ed25519|ssh-rsa|ecdsa-sha2-[\w-]+) [A-Za-z0-9+/]+={0,2}', value):
        raise ValueError('invalid public key')
    return value


def managed_user(value):
    return isinstance(value, str) and (value == 'drover-jump' or re.fullmatch(r'dt-[0-9a-f]{16}', value))


def fingerprint(line):
    """OpenSSH parses the key/options; comments or substrings are not identity."""
    result = subprocess.run(['ssh-keygen', '-lf', '-', '-E', 'sha256'], input=line,
                            capture_output=True)
    lines = result.stdout.splitlines()
    if result.returncode or len(lines) != 1:
        return None
    fields = lines[0].split()
    return fields[1].decode('ascii') if len(fields) > 1 and re.fullmatch(rb'SHA256:[A-Za-z0-9+/]{43}', fields[1]) else None


def ownership(saved):
    """Carry explicit public-key ownership, including keys from prior repairs."""
    recorded = saved.get('ownedKeyFingerprints', {})
    if not isinstance(recorded, dict): raise Conflict('bridge_credential_conflict')
    result = {}
    for user, values in recorded.items():
        if not managed_user(user) or not isinstance(values, list) or any(not isinstance(v, str) or not re.fullmatch(r'SHA256:[A-Za-z0-9+/]{43}', v) for v in values):
            raise Conflict('bridge_credential_conflict')
        result[user] = set(values)
    # Older state explicitly records current public credentials, but no ledger.
    # Derive their identity from the public key, never from authorized_keys tags.
    entries = [(t['user'], t['publicKey']) for t in saved.get('targets', [])]
    if saved.get('agentsPublicKey'): entries.append(('drover-jump', saved['agentsPublicKey']))
    for user, public in entries:
        if not managed_user(user): raise Conflict('bridge_credential_conflict')
        fp = fingerprint((key(public) + '\n').encode())
        if not fp: raise Conflict('bridge_credential_conflict')
        result.setdefault(user, set()).add(fp)
    return result


def cleanup_users(state):
    saved = json.loads(Path(state).read_text()) if Path(state).exists() else {}
    # Include recorded historical accounts after remove has dropped targets.
    print('\n'.join(sorted(set(ownership(saved)) | {'drover-jump'})))


def cleanup_key(state, user, path, mode):
    if not managed_user(user) or mode not in ('check', 'apply'):
        raise Conflict('bridge_credential_conflict')
    saved = json.loads(Path(state).read_text()) if Path(state).exists() else {}
    owned = ownership(saved).get(user, set())
    p = Path(path)
    if any(q.is_symlink() for q in (p, *p.parents)):
        raise Conflict('bridge_credential_conflict')
    if not p.exists(): return
    body = p.read_bytes()
    if not owned and any(line.strip() and not line.lstrip().startswith(b'#') for line in body.splitlines()):
        raise Conflict('bridge_credential_conflict')
    kept = []
    for line in body.splitlines(keepends=True):
        fp = None if not line.strip() or line.lstrip().startswith(b'#') else fingerprint(line)
        if fp not in owned: kept.append(line)
    new = b''.join(kept)
    if mode == 'check' or new == body: return
    stat = p.stat()
    fd, temp = tempfile.mkstemp(prefix='.drover-key-cleanup-', dir=p.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            os.fchmod(output.fileno(), stat.st_mode & 0o777)
            if os.geteuid() == 0: os.fchown(output.fileno(), stat.st_uid, stat.st_gid)
            output.write(new); output.flush(); os.fsync(output.fileno())
        # Fail closed if another writer changed the file while parsing keys.
        if p.is_symlink() or p.read_bytes() != body:
            raise Conflict('bridge_credential_conflict')
        os.replace(temp, p)
    finally:
        if os.path.exists(temp): os.unlink(temp)


def plan(manifest, state, work):
    data = json.loads(Path(manifest).read_text())
    saved = json.loads(Path(state).read_text()) if Path(state).exists() else {'version': 1, 'targets': []}
    action = data['action']
    if action == 'repair':
        targets = list(saved['targets'])
        for target in data['targets']:
            previous = next((t for t in targets if t['id'] == target['id']), None)
            if previous and previous != target:
                raise Conflict('bridge_credential_conflict')
            if not previous: targets.append(target)
    else:
        targets = data['targets'] if action == 'setup' else [t for t in saved['targets'] if t['id'] not in data['ids']]
    ports, users = set(), set()
    for t in targets:
        if not re.fullmatch(r'dt-[0-9a-f]{16}', t['user']) or type(t['port']) is not int or not 1024 <= t['port'] <= 65535 or t['port'] in (8780, 8791):
            raise ValueError('invalid tunnel account/port')
        if t['port'] in ports or t['user'] in users:
            raise Conflict('bridge_port_conflict')
        if action == 'repair' and t['port'] in (2222, 2223, 2224):
            raise Conflict('bridge_port_conflict')
        ports.add(t['port']); users.add(t['user']); key(t['publicKey'])
    # Removal must never rotate/revive a jump key from a delayed cleanup job.
    # Its snapshot can predate a separate jump-key revocation or rotation.
    agents = key(data['agentsPublicKey'] if action in ('setup', 'repair') else saved['agentsPublicKey'])
    work = Path(work)
    new = {**saved, 'version': 1, 'targets': targets, 'agentsPublicKey': agents}
    owned = ownership(saved)
    if action in ('setup', 'repair'):
        for user, public in [(t['user'], t['publicKey']) for t in targets] + [('drover-jump', agents)]:
            fp = fingerprint((public + '\n').encode())
            if not fp: raise Conflict('bridge_credential_conflict')
            owned.setdefault(user, set()).add(fp)
    new['ownedKeyFingerprints'] = {u:sorted(fps) for u, fps in owned.items()}
    if action in ('setup', 'repair'):
        new.update(origin=data['origin'], phone=data['phone'], phonePort=data['phonePort'])
    if action == 'repair': new['additive'] = True
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


def caddy_repair(manifest, path):
    """Patch a simple Drover site, retaining original auth/header/proxy blocks."""
    from urllib.parse import urlparse
    data = json.loads(Path(manifest).read_text())
    url = urlparse(data['origin'])
    if url.scheme != 'https' or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]*', url.netloc) or url.path not in ('', '/') or url.query or url.fragment:
        raise ValueError('invalid HTTPS origin')
    p = Path(path)
    if p.is_symlink(): raise ValueError('unsafe Caddyfile')
    if not p.exists():
        if data['phone']: raise ValueError('phone site is absent')
        caddy(manifest); return
    text = p.read_text()
    # Only the documented Drover config has predictable phone routing. Do not
    # infer semantics of arbitrary imports, named matchers or path routes.
    if not text.startswith(('# Managed by vps-web.sh\n', '# Drover Machines Caddy configuration\n')):
        raise ValueError('custom Caddyfile')
    lexer = re.compile(r'"(?:\\.|[^"\\])*"|`[^`]*`|\#[^\n]*|[{}\n]|[^\s{}"`#]+')
    tokens = [(m.group(), m.start(), m.end()) for m in lexer.finditer(text) if not m.group().startswith('#')]
    def parse(lo, hi):
        result, i = [], lo
        while i < hi:
            if tokens[i][0] == '\n': i += 1; continue
            first = i; head = []
            while i < hi and tokens[i][0] not in ('\n', '{', '}'):
                head.append(tokens[i][0]); i += 1
            if i < hi and tokens[i][0] == '}': raise ValueError('unmatched block')
            child = None
            if i < hi and tokens[i][0] == '{':
                opening = i; depth = 1; i += 1
                while i < hi and depth:
                    if tokens[i][0] == '{': depth += 1
                    if tokens[i][0] == '}': depth -= 1
                    i += 1
                if depth: raise ValueError('unclosed block')
                child = (opening + 1, i - 1)
            end = tokens[i - 1][2]
            result.append((head, tokens[first][1], end, child))
            if i < hi and tokens[i][0] == '\n': i += 1
        return result
    top = parse(0, len(tokens))
    if any(d[0] and d[0][0] in ('import', 'route') for d in top): raise ValueError('custom site routing')
    sites = [d for d in top if d[0] == [url.netloc] and d[3]]
    if len(sites) != 1: raise ValueError('ambiguous phone site')
    site = sites[0]; directives = parse(*site[3])
    if any(d[0] and (d[0][0].startswith('@') or d[0][0] in ('import','route','handle_path','redir','rewrite','try_files','file_server')) for d in directives):
        raise ValueError('custom phone routing')
    handles = [d for d in directives if d[0] and d[0][0] == 'handle']
    if handles:
        installer = [d for d in handles if d[0] == ['handle','/machines/install/*']]
        fallback = [d for d in handles if d[0] == ['handle']]
        if len(installer) != 1 or len(fallback) != 1 or len(handles) != 2:
            raise ValueError('custom handle routing')
        children = parse(*installer[0][3])
        if not any(d[0] == ['reverse_proxy','127.0.0.1:8791'] for d in children): raise ValueError('foreign installer route')
        if any(d[0] and d[0][0] in ('basic_auth','basicauth','reverse_proxy') for d in directives):
            raise ValueError('ambiguous installer authentication/routing')
        fallback_children = parse(*fallback[0][3])
        if data['phone'] and not any(d[0] == ['reverse_proxy',f'127.0.0.1:{data["phonePort"]}'] for d in fallback_children):
            raise ValueError('phone fallback missing')
        print(text, end=''); return
    proxy = [d for d in directives if d[0] and d[0][0] == 'reverse_proxy']
    expected = f'127.0.0.1:{data["phonePort"]}'
    if len(proxy) != 1 or proxy[0][0] != ['reverse_proxy', expected]: raise ValueError('ambiguous upstream')
    auth = [d for d in directives if d[0] and d[0][0] in ('basic_auth','basicauth')]
    if len(auth) > 1: raise ValueError('ambiguous authentication')
    # Auth still protects the phone fallback. The capability installer endpoint
    # uses its own one-time token and cannot send the phone's Basic credentials.
    chunks = [text[d[1]:d[2]] for d in auth + proxy]
    edits = [(d[1], d[2], '') for d in auth]
    replacement = ('# Drover one-time installers (additive repair)\n'
                   ' handle /machines/install/* {\n  request_body {\n   max_size 16KiB\n  }\n'
                   '  reverse_proxy 127.0.0.1:8791\n }\n handle {\n' + '\n'.join(chunks) + '\n }')
    edits.append((proxy[0][1], proxy[0][2], replacement))
    for start, end, replacement in sorted(edits, reverse=True): text = text[:start] + replacement + text[end:]
    print(text, end='')


def additive_key(path, options, public, output):
    """Extend a managed key's loopback grants without replacing any key line."""
    import shlex
    p = Path(path)
    if p.is_symlink(): raise ValueError('unsafe key path')
    public = key(public)
    wanted = shlex.split(options)[0].split(',')
    permission = 'permitopen' if any(o.startswith('permitopen=') for o in wanted) else 'permitlisten'
    desired = {o for o in wanted if o.startswith(permission + '=')}
    lines = p.read_text().splitlines(keepends=True) if p.exists() else []
    present = False
    for i, line in enumerate(lines):
        fields = shlex.split(line, comments=True)
        if len(fields) < 3 or ' '.join(fields[1:3]) != public: continue
        existing = fields[0].split(',')
        if 'restrict' not in existing or 'port-forwarding' not in existing:
            raise ValueError('foreign managed key options')
        actual = {o for o in existing if o.startswith(permission + '=')}
        for grant in actual:
            if not re.fullmatch(permission + r'=127\.0\.0\.1:[0-9]+', grant): raise ValueError('foreign managed grants')
        missing = desired - actual
        if missing:
            # Insert before the first whitespace, retaining the original key
            # body, comment and every other key line verbatim.
            original_options = re.match(r'\S+', line).group()
            additions = ','.join(g.split('=',1)[0] + '="' + g.split('=',1)[1] + '"' for g in sorted(missing))
            lines[i] = original_options + ',' + additions + line[len(original_options):]
        present = True
    if not present:
        if lines and not lines[-1].endswith('\n'): lines[-1] += '\n'
        lines.append(options + ' ' + public + ' drover-machines\n')
    Path(output).write_text(''.join(lines))


def ports_safe(manifest, state):
    import subprocess
    data = json.loads(Path(manifest).read_text())
    saved = json.loads(Path(state).read_text()) if Path(state).exists() else {'targets':[]}
    previous = {t['port'] for t in saved['targets']}
    sockets = subprocess.run(['ss','-ltnH'],text=True,capture_output=True,check=True)
    occupied = set()
    for line in sockets.stdout.splitlines():
        fields = line.split()
        if len(fields) >= 4 and fields[3].rsplit(':',1)[-1].isdigit():
            occupied.add(int(fields[3].rsplit(':',1)[-1]))
    if any(t['port'] in occupied and t['port'] not in previous for t in data['targets']):
        raise Conflict('bridge_port_conflict')


if __name__ == '__main__':
    try:
        if sys.argv[1] == 'plan':
            plan(*sys.argv[2:])
        elif sys.argv[1] == 'caddy':
            caddy(sys.argv[2])
        elif sys.argv[1] == 'caddy-safe':
            caddy_safe(sys.argv[2])
        elif sys.argv[1] == 'caddy-repair':
            caddy_repair(*sys.argv[2:])
        elif sys.argv[1] == 'additive-key':
            additive_key(*sys.argv[2:])
        elif sys.argv[1] == 'ports-safe':
            ports_safe(*sys.argv[2:])
        elif sys.argv[1] == 'cleanup-users':
            cleanup_users(sys.argv[2])
        elif sys.argv[1] == 'cleanup-key':
            cleanup_key(*sys.argv[2:])
        else:
            raise ValueError('unknown operation')
    except (ValueError, KeyError, TypeError, OSError) as error:
        if sys.argv[1] == 'caddy-repair':
            print('DROVER_BRIDGE_ERROR {"code":"caddy_repair_requires_manual_integration"}')
        elif isinstance(error, Conflict):
            print('DROVER_BRIDGE_ERROR ' + json.dumps({'code':error.code},separators=(',', ':')))
        sys.exit('drover bridge: invalid or unsafe configuration')
