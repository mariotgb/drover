#!/usr/bin/env python3
"""Provision the desktop tunnel using existing credentials and confirmed pins."""
import json
import os
import plistlib
import re
import subprocess
import sys
import time
import tempfile
import shutil
import urllib.request
from urllib.parse import urlsplit
from pathlib import Path

LABEL = 'dev.drover.bridge'
PHONE_LABEL = LABEL + '.phone'


def safe_path(path):
    return not any(p.is_symlink() for p in (path, *path.parents))


def launch(*args):
    try:
        return subprocess.run(['launchctl', *args], text=True, capture_output=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        return None


def running(domain, label=LABEL):
    result = launch('print', domain + '/' + label)
    return bool(result and result.returncode == 0 and re.search(r'^\s*state = running\s*$', result.stdout, re.M) and
                re.search(r'^\s*pid = [1-9][0-9]*\s*$', result.stdout, re.M))


def wait_running(domain, label=LABEL):
    for _ in range(12):
        if running(domain, label): return True
        time.sleep(0.25)
    return False


def port(value):
    if type(value) is not int or not 1 <= value <= 65535:
        raise ValueError('invalid port')
    return value


def option(args, flag):
    return [args[i + 1] for i in range(len(args) - 1) if args[i] == flag]


def loaded_arguments(result):
    if not result or result.returncode != 0: return None
    match = re.search(r'^\s*arguments = \{\n(.*?)^\s*\}', result.stdout, re.M | re.S)
    return [line.strip() for line in match.group(1).splitlines()] if match else None


def exact_job(domain, label, arguments, require_running=True):
    result = launch('print', domain + '/' + label)
    if loaded_arguments(result) != arguments: return False
    return not require_running or bool(re.search(r'^\s*state = running\s*$', result.stdout, re.M) and
                                       re.search(r'^\s*pid = [1-9][0-9]*\s*$', result.stdout, re.M))


def wait_exact(domain, label, arguments):
    for _ in range(12):
        if exact_job(domain, label, arguments): return True
        time.sleep(0.25)
    return False


def atomic_write(path, content, mode=0o644):
    fd, temp = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    temp = Path(temp)
    try:
        with os.fdopen(fd, 'wb') as file:
            os.fchmod(file.fileno(), mode)
            file.write(content); file.flush(); os.fsync(file.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def configure_jobs(domain, path, replacements):
    """Complete staging precedes live changes; recovery verifies exact job arguments.

    Ports cannot be rebound while an old SSH session owns them. Keep its plist and
    backup until replacements are verified. A failed OS cleanup is reported as
    incomplete, with no conflicting original loaded or live plist overwritten.
    """
    marker = path.with_suffix('.plist.recovery.json')
    if not safe_path(marker): raise ValueError('unsafe recovery marker')
    if marker.exists():
        return dict(ok=False, recovered=False, missing=['mac_bridge_recovery_incomplete'], recoveryPath=str(marker))
    transaction = Path(tempfile.mkdtemp(prefix='.drover-bridge-', dir=path.parent))
    originals, staged, changed, attempts = {}, {}, [], []
    journal = dict(phase='staging', originals={}, replacements={})
    def record(phase):
        journal['phase'] = phase
        atomic_write(transaction / 'transaction.json', json.dumps(journal).encode(), 0o600)
    # Snapshot/serialize/fsync/parse ALL files before unloading the first job.
    try:
        for label, target, plist in replacements:
            if not safe_path(target): raise ValueError('unsafe job path')
            original = target.read_bytes() if target.exists() else None
            old_plist = plistlib.loads(original) if original is not None else None
            state = launch('print', domain + '/' + label)
            if not state: raise ValueError('unable to inspect job')
            was_loaded = state.returncode == 0
            if was_loaded and (not old_plist or loaded_arguments(state) != old_plist['ProgramArguments']):
                raise ValueError('loaded job conflicts with plist')
            mode = target.stat().st_mode & 0o777 if original is not None else 0o644
            originals[label] = (target, original, old_plist, was_loaded, mode)
            if original is not None:
                atomic_write(transaction / (label + '.original'), original, mode)
            payload = plistlib.dumps(plist)
            candidate = transaction / (label + '.candidate')
            atomic_write(candidate, payload)
            if plistlib.loads(candidate.read_bytes()) != plist: raise ValueError('invalid staged plist')
            staged[label] = payload
            journal['originals'][label] = dict(path=str(target), loaded=was_loaded, backup=str(transaction / (label + '.original')) if original is not None else None)
            journal['replacements'][label] = dict(path=str(target), arguments=plist['ProgramArguments'])
        record('prepared')
    except (OSError, ValueError, plistlib.InvalidFileException):
        # Failed staging never touches canonical plists or launchd.
        try: record('staging_failed')
        except OSError: pass  # Preserve any originals even if the journal cannot be written.
        return dict(ok=False, recovered=True, missing=['mac_bridge_stage_failed'], backupPath=str(transaction))
    # Exclusive ownership of the transition; unresolved markers block blind retries.
    try:
        with marker.open('xb') as file:
            os.fchmod(file.fileno(), 0o600)
            file.write(json.dumps(dict(transaction=str(transaction))).encode()); file.flush(); os.fsync(file.fileno())
    except OSError:
        return dict(ok=False, recovered=False, missing=['mac_bridge_recovery_incomplete'], recoveryPath=str(marker), backupPath=str(transaction))
    try:
        record('transition')
        for label, (target, original, old_plist, was_loaded, mode) in originals.items():
            state = launch('print', domain + '/' + label)
            if (target.read_bytes() if target.exists() else None) != original or not state or (state.returncode == 0) != was_loaded:
                raise ValueError('original changed during staging')
            if was_loaded and loaded_arguments(state) != old_plist['ProgramArguments']:
                raise ValueError('loaded original changed during staging')
        for label, target, plist in replacements:
            _, original, old_plist, was_loaded, _ = originals[label]
            # Port-only maintenance on a split installation leaves unchanged jobs intact.
            if original is not None and old_plist == plist and was_loaded: continue
            changed.append(label)  # Own this branch before any operation can fail.
            if was_loaded:
                result = launch('bootout', domain + '/' + label)
                if not result or result.returncode != 0: raise ValueError('old job unload failed')
                state = launch('print', domain + '/' + label)
                if not state or state.returncode == 0: raise ValueError('old job still loaded')
            # Atomic replacement leaves no partial/empty canonical plist on write errors.
            atomic_write(target, staged[label])
            attempts.append(label)  # A bootstrap can report an error after loading.
            result = launch('bootstrap', domain, str(target))
            if not result or result.returncode != 0: raise ValueError('new job bootstrap failed')
        for label, _, plist in replacements:
            if not wait_exact(domain, label, plist['ProgramArguments']): raise ValueError('new job not verified')
        record('committed')
        marker.unlink()
        return dict(ok=True, recovered=False, missing=[], backupPath=str(transaction))
    except (OSError, ValueError):
        # Unload changed machine jobs first. If that fails, keep a healthy new phone
        # job and its plist intact rather than creating a competing legacy forward.
        errors = []
        for label in sorted(attempts, key=lambda label: label == PHONE_LABEL):
            state = launch('print', domain + '/' + label)
            if not state: errors.append('job inspection failed'); break
            if state.returncode != 0: continue
            new_args = journal['replacements'][label]['arguments']
            if loaded_arguments(state) != new_args: errors.append('unexpected loaded job'); break
            result = launch('bootout', domain + '/' + label)
            state = launch('print', domain + '/' + label)
            if not result or result.returncode != 0 or not state or state.returncode == 0:
                errors.append('new job cleanup failed'); break
        try:
            restore = []
            if not errors:
                # Remove new canonical files before restoring any combined plist.
                # If deletion fails, do not leave it beside a restored legacy job.
                for label in sorted(changed, key=lambda label: originals[label][1] is not None):
                    target, original, old_plist, was_loaded, mode = originals[label]
                    state = launch('print', domain + '/' + label)
                    if not state: errors.append('restore inspection failed'); break
                    if state.returncode == 0:
                        # Never overwrite the plist of a surviving live job.
                        if not was_loaded or not exact_job(domain, label, old_plist['ProgramArguments'], False):
                            errors.append('restore label occupied'); break
                        if target.read_bytes() != original: errors.append('live original plist changed'); break
                        continue
                    if original is None: target.unlink(missing_ok=True)
                    else: atomic_write(target, original, mode)
                    if was_loaded: restore.append((label, target, old_plist))
            if not errors:
                # All files are restored and split jobs absent before starting originals.
                for label, target, old_plist in restore:
                    result = launch('bootstrap', domain, str(target))
                    if not result or result.returncode != 0 or not wait_exact(domain, label, old_plist['ProgramArguments']):
                        errors.append('original job restore failed'); break
            if not errors:
                # Exact files and exact loaded arguments, not a PID with the same label.
                for label, (target, original, old_plist, was_loaded, _) in originals.items():
                    if (target.read_bytes() if target.exists() else None) != original:
                        errors.append('original file verification failed'); break
                    state = launch('print', domain + '/' + label)
                    if not state or (was_loaded and loaded_arguments(state) != old_plist['ProgramArguments']) or (not was_loaded and state.returncode == 0):
                        errors.append('original state verification failed'); break
        except (OSError, ValueError):
            errors.append('original file restore or verification failed')
        journal['recoveryErrors'] = errors
        try:
            record('recovery_incomplete' if errors else 'rolled_back')
            if not errors: marker.unlink()
        except OSError:
            errors.append('recovery journal or marker cleanup failed')
        return dict(ok=False, recovered=not errors, missing=['mac_bridge_recovery_incomplete' if errors else 'mac_bridge_bootstrap_failed'],
                    backupPath=str(transaction), **(dict(recoveryPath=str(marker), recoveryErrors=errors) if errors else {}))


def verify_phone_url(public_url):
    """Bounded HTTPS check, without redirects, cookies, credentials or shell commands."""
    parsed = urlsplit(public_url)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or
            parsed.path not in ('', '/') or parsed.query or parsed.fragment):
        raise ValueError('phone URL must be an HTTPS origin')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args): return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request(public_url.rstrip('/') + '/pair', headers={'Cache-Control': 'no-cache'})
    with opener.open(request, timeout=10) as response:
        body = response.read(512 * 1024 + 1)
        if (response.status != 200 or len(body) > 512 * 1024 or
                '<title>Drover</title>' not in body.decode('utf-8', errors='replace') or
                '/auth/assets/' not in body.decode('utf-8', errors='replace')):
            raise ValueError('new phone endpoint is not the Drover auth page')


def phone_arguments(data):
    host, user = data.get('host', ''), data.get('user', '')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.:-]*', host) or not re.fullmatch(r'[a-z_][a-z0-9_-]*', user):
        raise ValueError('invalid SSH target')
    ssh_port = port(data.get('port', 22))
    forwards = data.get('forwards')
    if data.get('phone') is not True or not isinstance(forwards, list) or len(forwards) != 1:
        raise ValueError('move requires one split phone forward')
    forward = forwards[0]
    if forward.get('listenHost') != '127.0.0.1' or forward.get('targetHost') != '127.0.0.1' or port(forward['listenPort']) == 2222:
        raise ValueError('invalid phone forward')
    route = f'127.0.0.1:{port(forward["listenPort"])}:127.0.0.1:{port(forward["targetPort"])}'
    key, known = Path(data['keyPath']), Path(data['knownHostsPath'])
    for path in (key, known):
        if not path.is_absolute() or not safe_path(path) or not path.is_file() or path.stat().st_uid != os.getuid():
            raise ValueError('unsafe credential path')
    if key.stat().st_mode & 0o077: raise ValueError('private identity permissions')
    alias = data.get('hostKeyAlias') or (host if ssh_port == 22 else f'[{host}]:{ssh_port}')
    if not re.fullmatch(r'(?:[A-Za-z0-9][A-Za-z0-9._:-]*|\[[A-Za-z0-9][A-Za-z0-9.:-]*\]:[0-9]{1,5})', alias):
        raise ValueError('invalid host alias')
    subprocess.run(['ssh-keygen', '-F', alias, '-f', str(known)], capture_output=True, check=True, timeout=10)
    args = ['/usr/bin/ssh', '-F', '/dev/null', '-N', '-T', '-p', str(ssh_port), '-i', str(key), '-R', route]
    for setting in ['IdentitiesOnly=yes', 'BatchMode=yes', 'ConnectTimeout=10', 'ConnectionAttempts=1',
                    'ServerAliveInterval=30', 'ServerAliveCountMax=3', 'ExitOnForwardFailure=yes',
                    'StrictHostKeyChecking=yes', 'UserKnownHostsFile=' + str(known),
                    'GlobalKnownHostsFile=/dev/null', 'HostKeyAlias=' + alias, 'LogLevel=ERROR']:
        args += ['-o', setting]
    return args + [f'{user}@{host}']


def move_phone(data, home):
    domain = 'gui/' + str(os.getuid())
    path = home / 'Library/LaunchAgents' / (PHONE_LABEL + '.plist')
    machine_path = path.with_name(LABEL + '.plist')
    marker = path.with_suffix('.plist.move.json')
    for target in (path, machine_path, marker):
        if not safe_path(target): raise ValueError('unsafe phone transaction path')
    if marker.exists(): raise ValueError('unfinished phone transaction')
    old_bytes, machine_bytes = path.read_bytes(), machine_path.read_bytes()
    old, machine = plistlib.loads(old_bytes), plistlib.loads(machine_bytes)
    old_args, machine_args = old.get('ProgramArguments', []), machine.get('ProgramArguments', [])
    if (old.get('Label') != PHONE_LABEL or machine.get('Label') != LABEL or
            len(option(old_args, '-R')) != 1 or len(option(machine_args, '-R')) != 1 or
            option(machine_args, '-R')[0].split(':')[1] != '2222' or
            option(old_args, '-R')[0].split(':')[1] == '2222' or
            not exact_job(domain, PHONE_LABEL, old_args)):
        raise ValueError('an exact active split phone job is required')
    new_args = phone_arguments(data)
    if old_args[-1].split('@')[-1] == data['host'] and option(old_args, '-p') == [str(data.get('port', 22))]:
        raise ValueError('new phone bridge must have a different endpoint')
    # Validate URL before launching any new job; this request occurs only after staging.
    parsed = urlsplit(data['publicUrl'])
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.path not in ('', '/') or parsed.query or parsed.fragment:
        raise ValueError('phone URL must be an HTTPS origin')
    transaction = Path(tempfile.mkdtemp(prefix='.drover-phone-', dir=path.parent))
    candidate_label = PHONE_LABEL + '.candidate-' + transaction.name.removeprefix('.drover-phone-')
    candidate_path = transaction / (candidate_label + '.plist')
    new = {**old, 'ProgramArguments': new_args}
    candidate = {**new, 'Label': candidate_label}
    record = dict(home=str(home), phonePath=str(path), candidatePath=str(candidate_path), candidateLabel=candidate_label,
                  oldArguments=old_args, newArguments=new_args, machineArguments=machine_args, phase='prepared')
    atomic_write(transaction / 'phone.original', old_bytes, path.stat().st_mode & 0o777)
    atomic_write(transaction / 'machine.original', machine_bytes, machine_path.stat().st_mode & 0o777)
    atomic_write(candidate_path, plistlib.dumps(candidate))
    atomic_write(transaction / 'transaction.json', json.dumps(record).encode(), 0o600)
    with marker.open('xb') as file:
        os.fchmod(file.fileno(), 0o600); file.write(json.dumps(dict(transaction=str(transaction))).encode()); file.flush(); os.fsync(file.fileno())
    result = dict(tunnelRunning=exact_job(domain, LABEL, machine_args), phoneTunnelRunning=True,
                  moved=False, verified=False, missing=[], backupPath=str(transaction))
    try:
        state = launch('bootstrap', domain, str(candidate_path))
        if not state or state.returncode or not wait_exact(domain, candidate_label, new_args): raise ValueError('candidate SSH job failed')
        verify_phone_url(data['publicUrl'])
        if not exact_job(domain, candidate_label, new_args) or not exact_job(domain, PHONE_LABEL, old_args): raise ValueError('phone job changed during verification')
        if path.read_bytes() != old_bytes or machine_path.read_bytes() != machine_bytes: raise ValueError('original changed during verification')
        state = launch('bootout', domain + '/' + candidate_label)
        if not state or state.returncode or launch('print', domain + '/' + candidate_label).returncode == 0: raise ValueError('candidate cleanup failed')
        switched = configure_jobs(domain, path, [(PHONE_LABEL, path, new)])
        record['switchBackup'] = switched.get('backupPath')
        if not switched['ok']: raise ValueError('canonical phone switch failed')
        verify_phone_url(data['publicUrl'])
        if not exact_job(domain, PHONE_LABEL, new_args): raise ValueError('canonical phone job failed')
        record['phase'] = 'awaiting-settings'
        atomic_write(transaction / 'transaction.json', json.dumps(record).encode(), 0o600)
        result.update(moved=True, verified=True, phoneTunnelRunning=True)
        return result
    except (OSError, ValueError, subprocess.SubprocessError):
        atomic_write(transaction / 'transaction.json', json.dumps(record).encode(), 0o600)
        try: recovered = phone_transaction(dict(action='rollback-phone', home=str(home), backupPath=str(transaction)), home)
        except (OSError, ValueError, subprocess.SubprocessError): recovered = dict(recovered=False, phoneTunnelRunning=False)
        result.update(recovered=recovered['recovered'], phoneTunnelRunning=recovered['phoneTunnelRunning'],
                      missing=['phone_move_failed'] if recovered['recovered'] else ['phone_recovery_incomplete'])
        return result


def phone_transaction(data, home):
    path = home / 'Library/LaunchAgents' / (PHONE_LABEL + '.plist')
    machine_path = path.with_name(LABEL + '.plist')
    marker = path.with_suffix('.plist.move.json')
    transaction = Path(data['backupPath'])
    if (transaction.parent != path.parent or not transaction.name.startswith('.drover-phone-') or
            not safe_path(transaction) or not safe_path(marker) or
            json.loads(marker.read_text())['transaction'] != str(transaction)):
        raise ValueError('invalid phone transaction')
    for name in ('transaction.json', 'phone.original', 'machine.original'):
        if not safe_path(transaction / name): raise ValueError('unsafe backup')
    record = json.loads((transaction / 'transaction.json').read_text())
    if record['home'] != str(home) or record['phonePath'] != str(path): raise ValueError('transaction home mismatch')
    domain = 'gui/' + str(os.getuid())
    if machine_path.read_bytes() != (transaction / 'machine.original').read_bytes(): raise ValueError('machine job changed')
    candidate_label = record['candidateLabel']
    if not re.fullmatch(r'dev\.drover\.bridge\.phone\.candidate-[A-Za-z0-9_-]+', candidate_label): raise ValueError('invalid candidate label')
    state = launch('print', domain + '/' + candidate_label)
    if not state: raise ValueError('candidate inspection unavailable')
    if state.returncode == 0:
        if loaded_arguments(state) != record['newArguments']: raise ValueError('candidate job changed')
        stopped = launch('bootout', domain + '/' + candidate_label)
        if not stopped or stopped.returncode or launch('print', domain + '/' + candidate_label).returncode == 0: raise ValueError('candidate cleanup incomplete')
    if data['action'] == 'finish-phone':
        if (record['phase'] != 'awaiting-settings' or not exact_job(domain, PHONE_LABEL, record['newArguments']) or
                plistlib.loads(path.read_bytes()).get('ProgramArguments') != record['newArguments']): raise ValueError('new phone job not verified')
        for child in transaction.iterdir():
            if not safe_path(child): raise ValueError('unsafe cleanup path')
        shutil.rmtree(transaction)
        marker.unlink()
        return dict(moved=True, verified=True, phoneTunnelRunning=True, tunnelRunning=exact_job(domain, LABEL, record['machineArguments']), missing=[])
    old_bytes = (transaction / 'phone.original').read_bytes()
    old = plistlib.loads(old_bytes)
    state = launch('print', domain + '/' + PHONE_LABEL)
    if not state: raise ValueError('phone inspection unavailable')
    if state.returncode == 0 and loaded_arguments(state) not in (record['oldArguments'], record['newArguments']): raise ValueError('phone job changed')
    if not exact_job(domain, PHONE_LABEL, record['oldArguments']):
        switched = configure_jobs(domain, path, [(PHONE_LABEL, path, old)])
        if not switched['ok']: return dict(recovered=False, phoneTunnelRunning=False, tunnelRunning=exact_job(domain, LABEL, record['machineArguments']), missing=['phone_recovery_incomplete'], backupPath=str(transaction))
    atomic_write(path, old_bytes, (transaction / 'phone.original').stat().st_mode & 0o777)
    recovered = exact_job(domain, PHONE_LABEL, record['oldArguments']) and path.read_bytes() == old_bytes
    if recovered:
        record['phase'] = 'rolled-back'; atomic_write(transaction / 'transaction.json', json.dumps(record).encode(), 0o600); marker.unlink()
    return dict(recovered=recovered, phoneTunnelRunning=recovered, tunnelRunning=exact_job(domain, LABEL, record['machineArguments']), missing=[] if recovered else ['phone_recovery_incomplete'], backupPath=str(transaction))


def main(data):
    action = data.get('action')
    if action not in ('verify', 'setup', 'split', 'move-phone', 'rollback-phone', 'finish-phone'):
        raise ValueError('invalid action')
    if sys.platform != 'darwin' and not (Path('/.dockerenv').exists() and data.get('home')):
        raise ValueError('macOS required')
    home = Path(data.get('home', str(Path.home())))
    if not home.is_absolute() or not safe_path(home):
        raise ValueError('invalid home')
    if action == 'move-phone': return move_phone(data, home)
    if action in ('rollback-phone', 'finish-phone'): return phone_transaction(data, home)
    path = home / 'Library/LaunchAgents' / (LABEL + '.plist')
    domain = 'gui/' + str(os.getuid())
    base = dict(tunnelRunning=False, plistPath=str(path), missing=[])
    if not safe_path(path):
        base['missing'] = ['mac_bridge_plist_unsafe']; return base
    marker = path.with_suffix('.plist.recovery.json')
    if not safe_path(marker) or marker.exists():
        base.update(missing=['mac_bridge_recovery_incomplete'], recoveryPath=str(marker))
        return base
    existing = None
    if path.exists():
        with path.open('rb') as file:
            existing = plistlib.load(file)
        if existing.get('Label') != LABEL:
            base['missing'] = ['mac_bridge_plist_conflict']; return base
    # Verify may be used to detect the old plist before any host is selected.
    if not data.get('host'):
        base['tunnelRunning'] = exact_job(domain, LABEL, existing.get('ProgramArguments', [])) if existing else False
        if not existing: base['missing'].append('mac_bridge_plist_missing')
        if not base['tunnelRunning']: base['missing'].append('mac_bridge_tunnel_stopped')
        if action != 'verify': raise ValueError('host required')
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
    phone_path = path.with_name(PHONE_LABEL + '.plist')
    phone = None
    if not safe_path(phone_path):
        base['missing'].append('mac_bridge_plist_unsafe'); return base
    if phone_path.exists():
        with phone_path.open('rb') as file: phone = plistlib.load(file)
        phone_args = phone.get('ProgramArguments', [])
        if (phone.get('Label') != PHONE_LABEL or not isinstance(phone_args, list) or
                not all(isinstance(a, str) for a in phone_args) or
                option(phone_args, '-i') != [str(key_path)] or option(phone_args, '-p') != [str(ssh_port)] or
                option(phone_args, '-F') != ['/dev/null'] or f'{user}@{host}' not in phone_args or
                'StrictHostKeyChecking=yes' not in option(phone_args, '-o') or
                'ExitOnForwardFailure=yes' not in option(phone_args, '-o') or
                'UserKnownHostsFile=' + str(known) not in option(phone_args, '-o') or
                [o for o in option(phone_args, '-o') if o.startswith('HostKeyAlias=')] !=
                [o for o in options if o.startswith('HostKeyAlias=')]):
            base['missing'].append('mac_bridge_plist_conflict'); return base
        if set(option(phone_args, '-R')) & set(option(args, '-R')) or not existing:
            base['missing'].append('mac_bridge_plist_conflict'); return base
    def normalize(value): return value.replace(':localhost:', ':127.0.0.1:')
    actual = {normalize(f) for f in option(args, '-R') + (option(phone_args, '-R') if phone else [])}
    requested = {normalize(f) for f in rendered}
    if existing:
        transport_match = (args and args[0] == '/usr/bin/ssh' and f'{user}@{host}' in args and '-N' in args and
                           option(args, '-F') == ['/dev/null'] and option(args, '-p') == [str(ssh_port)] and
                           identities == [str(key_path)] and pins == [str(known)] and
                           'StrictHostKeyChecking=yes' in options and 'ExitOnForwardFailure=yes' in options)
        # Explicit split may change only the phone target port, with other endpoints exact.
        def phone_target(value):
            parts = value.split(':')
            return ':'.join(parts[:3]) + ':PHONE' if parts[1] == '8780' else value
        routes_match = (requested.issubset(actual) if action != 'split' else
                        {phone_target(f) for f in requested} == {phone_target(f) for f in actual})
        if not transport_match or not routes_match: base['missing'].append('mac_bridge_plist_conflict')
        base['tunnelRunning'] = exact_job(domain, LABEL, args) and (not phone or exact_job(domain, PHONE_LABEL, phone_args)) if transport_match else False
        if phone: base['phoneTunnelRunning'] = exact_job(domain, PHONE_LABEL, phone_args)
        if action == 'setup' and not base['missing'] and not base['tunnelRunning']:
            for label, target in [(LABEL, path)] + ([(PHONE_LABEL, phone_path)] if phone else []):
                state = launch('print', domain + '/' + label)
                if state and state.returncode != 0: launch('bootstrap', domain, str(target))
            base['tunnelRunning'] = wait_exact(domain, LABEL, args) and (not phone or wait_exact(domain, PHONE_LABEL, phone_args))
    if action in ('setup', 'split') and not base['missing'] and (not existing or action == 'split'):
        logs = home / 'Library/Logs'
        if not safe_path(logs): raise ValueError('unsafe log path')
        path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        logs.mkdir(mode=0o755, parents=True, exist_ok=True)
        machines = [f for f in rendered if f.split(':')[1] == '2222']
        phone_forwards = [f for f in rendered if f not in machines]
        groups = [(LABEL, path, machines or phone_forwards)]
        if machines and phone_forwards: groups.append((PHONE_LABEL, phone_path, phone_forwards))
        replacements = []
        for label, target, routes in groups:
            new_args = ['/usr/bin/ssh', '-F', '/dev/null', '-N', '-T', '-p', str(ssh_port), '-i', str(key_path)]
            for f in routes: new_args += ['-R', f]
            for setting in ['IdentitiesOnly=yes', 'BatchMode=yes', 'ServerAliveInterval=30', 'ServerAliveCountMax=3',
                            'ConnectTimeout=10', 'ConnectionAttempts=1', 'ExitOnForwardFailure=yes',
                            'StrictHostKeyChecking=yes', 'UserKnownHostsFile=' + str(known),
                            'GlobalKnownHostsFile=/dev/null', 'LogLevel=ERROR']:
                new_args += ['-o', setting]
            if alias: new_args += ['-o', 'HostKeyAlias=' + alias]
            new_args += [f'{user}@{host}']
            plist = dict(Label=label, ProgramArguments=new_args, RunAtLoad=True, KeepAlive=True, ThrottleInterval=10,
                         ProcessType='Background', StandardErrorPath=str(logs / (label + '.log')),
                         StandardOutPath=str(logs / (label + '.log')))
            # Unchanged machine jobs retain their exact bytes and launchd state.
            if phone and label == LABEL: plist = existing
            if phone and label == PHONE_LABEL and requested == actual: plist = phone
            replacements.append((label, target, plist))
        result = configure_jobs(domain, path, replacements)
        base.update({key: value for key, value in result.items() if key not in ('ok', 'recovered', 'missing')})
        base['missing'].extend(result['missing'])
        base['tunnelRunning'] = bool(result['ok'] or (result['recovered'] and existing and exact_job(domain, LABEL, args) and (not phone or exact_job(domain, PHONE_LABEL, phone_args))))
        if result['ok'] and len(groups) == 2: base['phoneTunnelRunning'] = True
        elif not result['recovered']: base['phoneTunnelRunning'] = False
    if not path.exists(): base['missing'].append('mac_bridge_plist_missing')
    if not base['tunnelRunning']: base['missing'].append('mac_bridge_tunnel_stopped')
    return base


if __name__ == '__main__':
    try:
        print('DROVER_MAC_BRIDGE_REPORT ' + json.dumps(main(json.loads(Path(sys.argv[1]).read_text())), separators=(',', ':')))
    except (ValueError, OSError, KeyError, TypeError, plistlib.InvalidFileException, subprocess.SubprocessError):
        sys.exit('Mac bridge setup failed: invalid or unavailable metadata')
