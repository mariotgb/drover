"""Tunnel lifecycle tests use fake launchctl and synthetic credentials, never live services."""
import importlib.util
import json
import os
import plistlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('tunnel', Path(__file__).parent.parent / 'remote/machines/mac-tunnel.py')
tunnel = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tunnel)


class TunnelTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='drover-tunnel-')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        self.key = self.home / 'key'; self.key.write_text('synthetic'); self.key.chmod(0o600)
        self.known = self.home / 'known'; self.known.write_text('synthetic pin')
        self.data = dict(action='setup', home=str(self.home), host='bridge.example', keyPath=str(self.key), knownHostsPath=str(self.known))
        self.loaded = {}; self.calls = []; self.machine_failed = False; self.bootstrap_failed = False
        self.bootout_failed = set(); self.restore_failed = False; self.corrupt_bootstrap = set()
        def launch(*args):
            self.calls.append(args)
            label = args[-1].split('/')[-1].removesuffix('.plist')
            if args[0] == 'bootstrap':
                if label == tunnel.PHONE_LABEL and self.bootstrap_failed:
                    return subprocess.CompletedProcess(args, 1, '', '')
                if label in self.loaded: return subprocess.CompletedProcess(args, 1, '', '')
                plist = plistlib.loads(Path(args[-1]).read_bytes())
                if self.restore_failed and len(tunnel.option(plist['ProgramArguments'], '-R')) == 2:
                    return subprocess.CompletedProcess(args, 1, '', '')
                self.loaded[label] = plist
                if label in self.corrupt_bootstrap and len(tunnel.option(plist['ProgramArguments'], '-R')) == 1:
                    self.loaded[label] = {**plist, 'ProgramArguments': plist['ProgramArguments'] + ['WRONG']}
                return subprocess.CompletedProcess(args, 0, '', '')
            if args[0] == 'bootout':
                if label in self.bootout_failed: return subprocess.CompletedProcess(args, 1, '', '')
                self.loaded.pop(label, None)
                return subprocess.CompletedProcess(args, 0, '', '')
            active = label in self.loaded and not (label == tunnel.LABEL and self.machine_failed)
            output = 'state = running\npid = 123\n' if active else 'state = waiting\n'
            if label in self.loaded: output += 'arguments = {\n' + '\n'.join(self.loaded[label]['ProgramArguments']) + '\n}\n'
            return subprocess.CompletedProcess(args, 0 if label in self.loaded else 113, output, '')
        for target, value in [('launch', launch), ('safe_path', lambda _: True), ('wait_running', lambda domain, label=tunnel.LABEL: tunnel.running(domain, label)), ('wait_exact', lambda domain, label, args: tunnel.exact_job(domain, label, args))]:
            p = patch.object(tunnel, target, value); p.start(); self.addCleanup(p.stop)
        p = patch.object(tunnel.sys, 'platform', 'darwin'); p.start(); self.addCleanup(p.stop)
        p = patch.object(tunnel.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, 'pin', '')); p.start(); self.addCleanup(p.stop)

    def legacy(self):
        tunnel.main({**self.data, 'phone': False})
        self.path = self.home / 'Library/LaunchAgents' / (tunnel.LABEL + '.plist')
        self.phone_path = self.path.with_name(tunnel.PHONE_LABEL + '.plist')
        legacy = plistlib.loads(self.path.read_bytes())
        at = legacy['ProgramArguments'].index('-R')
        legacy['ProgramArguments'][at:at] = ['-R', '127.0.0.1:8780:127.0.0.1:7780']
        self.original = plistlib.dumps(legacy)
        self.path.write_bytes(self.original); self.loaded[tunnel.LABEL] = legacy
        self.calls.clear()
        return {**self.data, 'action': 'split'}

    def assert_legacy_restored(self, result):
        self.assertIn('mac_bridge_bootstrap_failed', result['missing'])
        self.assertTrue(result['tunnelRunning'])
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assertEqual(self.loaded, {tunnel.LABEL: plistlib.loads(self.original)})
        self.assertFalse(self.phone_path.exists())
        self.assertFalse(self.path.with_suffix('.plist.recovery.json').exists())

    def assert_incomplete(self, result):
        self.assertIn('mac_bridge_recovery_incomplete', result['missing'])
        self.assertFalse(result['tunnelRunning']); self.assertFalse(result['phoneTunnelRunning'])
        marker = self.path.with_suffix('.plist.recovery.json')
        self.assertEqual(json.loads(marker.read_text())['transaction'], result['backupPath'])
        self.assertEqual((Path(result['backupPath']) / (tunnel.LABEL + '.original')).read_bytes(), self.original)
        self.assertEqual(json.loads((Path(result['backupPath']) / 'transaction.json').read_text())['phase'], 'recovery_incomplete')
        self.calls.clear()
        verified = tunnel.main({**self.data, 'action': 'verify'})
        retried = tunnel.main({**self.data, 'action': 'split'})
        self.assertFalse(verified['tunnelRunning']); self.assertFalse(retried['tunnelRunning'])
        self.assertEqual(self.calls, [], 'unresolved recovery cannot mutate or claim service')

    def test_independent_jobs_keep_phone_running_when_machine_forward_fails(self):
        result = tunnel.main(self.data)
        self.assertEqual(result['missing'], []); self.assertTrue(result['tunnelRunning'])
        path = Path(result['plistPath']); phone_path = path.with_name(tunnel.PHONE_LABEL + '.plist')
        machine = plistlib.loads(path.read_bytes()); phone = plistlib.loads(phone_path.read_bytes())
        self.assertEqual(tunnel.option(machine['ProgramArguments'], '-R'), ['127.0.0.1:2222:127.0.0.1:22'])
        self.assertEqual(tunnel.option(phone['ProgramArguments'], '-R'), ['127.0.0.1:8780:127.0.0.1:7780'])
        for job in [machine, phone]:
            self.assertEqual(job['ThrottleInterval'], 10)
            self.assertIn('ConnectTimeout=10', job['ProgramArguments'])
            self.assertIn('ExitOnForwardFailure=yes', job['ProgramArguments'])
        self.machine_failed = True
        result = tunnel.main({**self.data, 'action': 'verify'})
        self.assertTrue(result['phoneTunnelRunning']); self.assertFalse(result['tunnelRunning'])
        self.assertNotIn('bootout', [c[0] for c in self.calls])

    def phone_move(self):
        tunnel.main(self.data)
        self.path = self.home / 'Library/LaunchAgents' / (tunnel.LABEL + '.plist')
        self.phone_path = self.path.with_name(tunnel.PHONE_LABEL + '.plist')
        self.machine_original = self.path.read_bytes()
        self.phone_original = self.phone_path.read_bytes()
        self.calls.clear()
        return {**self.data, 'action': 'move-phone', 'host': 'new.example', 'port': 22, 'user': 'bridge-mac',
                'phone': True, 'publicUrl': 'https://new.example',
                'forwards': [dict(listenHost='127.0.0.1', listenPort=8780, targetHost='127.0.0.1', targetPort=8791)]}

    def test_phone_move_verifies_new_route_before_old_job_unload_and_can_rollback_settings(self):
        data = self.phone_move()
        def verify(url):
            self.assertEqual(url, data['publicUrl'])
            self.assertEqual(self.path.read_bytes(), self.machine_original)
            if any(label.startswith(tunnel.PHONE_LABEL + '.candidate-') for label in self.loaded):
                self.assertEqual(self.phone_path.read_bytes(), self.phone_original)
                self.assertEqual(self.loaded[tunnel.PHONE_LABEL], plistlib.loads(self.phone_original))
        with patch.object(tunnel, 'verify_phone_url', side_effect=verify): result = tunnel.main(data)
        self.assertTrue(result['moved']); self.assertTrue(result['verified']); self.assertEqual(result['missing'], [])
        self.assertEqual(self.path.read_bytes(), self.machine_original)
        self.assertFalse(any(call[0] == 'bootout' and call[-1].endswith('/' + tunnel.LABEL) for call in self.calls))
        rollback = tunnel.main(dict(action='rollback-phone', home=str(self.home), backupPath=result['backupPath']))
        self.assertTrue(rollback['recovered']); self.assertTrue(rollback['phoneTunnelRunning'])
        self.assertEqual(self.phone_path.read_bytes(), self.phone_original)
        self.assertEqual(self.loaded[tunnel.PHONE_LABEL], plistlib.loads(self.phone_original))

    def test_phone_endpoint_failure_leaves_exact_old_job_and_keys(self):
        data = self.phone_move()
        with patch.object(tunnel, 'verify_phone_url', side_effect=ValueError('wrong endpoint')): result = tunnel.main(data)
        self.assertFalse(result['moved']); self.assertTrue(result['recovered'])
        self.assertEqual(result['missing'], ['phone_move_failed'])
        self.assertEqual(self.phone_path.read_bytes(), self.phone_original)
        self.assertEqual(self.path.read_bytes(), self.machine_original)
        self.assertFalse(any(call[0] == 'bootout' and call[-1].endswith('/' + tunnel.PHONE_LABEL) for call in self.calls))
        self.assertEqual(self.key.read_text(), 'synthetic')
        self.assertEqual(self.known.read_text(), 'synthetic pin')

    def test_phone_finish_requires_verified_canonical_job_and_removes_transaction(self):
        data = self.phone_move()
        with patch.object(tunnel, 'verify_phone_url'): result = tunnel.main(data)
        backup = Path(result['backupPath'])
        finished = tunnel.main(dict(action='finish-phone', home=str(self.home), backupPath=str(backup)))
        self.assertTrue(finished['verified']); self.assertFalse(backup.exists())
        self.assertEqual(self.path.read_bytes(), self.machine_original)

    def test_phone_post_switch_https_failure_restores_exact_old_job(self):
        data = self.phone_move()
        with patch.object(tunnel, 'verify_phone_url', side_effect=[None, ValueError('route disappeared')]): result = tunnel.main(data)
        self.assertFalse(result['moved']); self.assertTrue(result['recovered'])
        self.assertEqual(self.phone_path.read_bytes(), self.phone_original)
        self.assertEqual(self.loaded[tunnel.PHONE_LABEL], plistlib.loads(self.phone_original))
        self.assertEqual(self.path.read_bytes(), self.machine_original)

    def test_phone_pin_and_url_rejected_before_mutation(self):
        data = self.phone_move()
        with patch.object(tunnel.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, [])):
            with self.assertRaises(subprocess.CalledProcessError): tunnel.main(data)
        with self.assertRaises(ValueError): tunnel.main({**data, 'publicUrl': 'http://new.example'})
        self.assertFalse(any(call[0] in ('bootout', 'bootstrap') for call in self.calls))
        self.assertEqual(self.phone_path.read_bytes(), self.phone_original)

    def test_phone_settings_rollback_rejects_concurrently_changed_job(self):
        data = self.phone_move()
        with patch.object(tunnel, 'verify_phone_url'): moved = tunnel.main(data)
        self.loaded[tunnel.PHONE_LABEL]['ProgramArguments'] += ['changed']
        self.calls.clear()
        with self.assertRaises(ValueError): tunnel.main(dict(action='rollback-phone', home=str(self.home), backupPath=moved['backupPath']))
        self.assertFalse(any(call[0] in ('bootout', 'bootstrap') for call in self.calls))

    def test_legacy_setup_preserves_job_and_explicit_split_backs_it_up(self):
        tunnel.main({**self.data, 'phone': False})
        path = self.home / 'Library/LaunchAgents' / (tunnel.LABEL + '.plist')
        legacy = plistlib.loads(path.read_bytes())
        at = legacy['ProgramArguments'].index('-R')
        legacy['ProgramArguments'][at:at] = ['-R', '127.0.0.1:8780:127.0.0.1:7780']
        path.write_bytes(plistlib.dumps(legacy)); original = path.read_bytes()
        self.loaded[tunnel.LABEL] = legacy
        self.calls.clear(); tunnel.main(self.data)
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual([c for c in self.calls if c[0] in ['bootstrap', 'bootout']], [])
        result = tunnel.main({**self.data, 'action': 'split'})
        self.assertTrue(result['tunnelRunning'])
        self.assertEqual((Path(result['backupPath']) / (tunnel.LABEL + '.original')).read_bytes(), original)
        self.assertEqual(len([c for c in self.calls if c[0] == 'bootout']), 1)
        self.assertEqual(len([c for c in self.calls if c[0] == 'bootstrap']), 2)

    def test_split_bootstrap_failure_restores_legacy_job(self):
        data = self.legacy()
        self.bootstrap_failed = True
        self.assert_legacy_restored(tunnel.main(data))

    def test_partial_phone_staging_never_unloads_or_writes_canonical_files(self):
        data = self.legacy(); write = tunnel.atomic_write
        def fail(path, content, mode=0o644):
            if path.name == tunnel.PHONE_LABEL + '.candidate':
                path.write_bytes(b'partial plist'); raise OSError('partial stage write')
            write(path, content, mode)
        with patch.object(tunnel, 'atomic_write', fail): result = tunnel.main(data)
        self.assertIn('mac_bridge_stage_failed', result['missing'])
        self.assertEqual(self.path.read_bytes(), self.original); self.assertFalse(self.phone_path.exists())
        self.assertEqual([c for c in self.calls if c[0] in ('bootout', 'bootstrap')], [])

    def test_invalid_complete_phone_stage_never_unloads(self):
        data = self.legacy(); write = tunnel.atomic_write
        def corrupt(path, content, mode=0o644):
            write(path, b'invalid' if path.name == tunnel.PHONE_LABEL + '.candidate' else content, mode)
        with patch.object(tunnel, 'atomic_write', corrupt): result = tunnel.main(data)
        self.assertIn('mac_bridge_stage_failed', result['missing'])
        self.assertEqual([c for c in self.calls if c[0] in ('bootout', 'bootstrap')], [])

    def test_atomic_install_failure_after_unload_restores_original(self):
        data = self.legacy(); replace = tunnel.os.replace
        def fail(source, target):
            if target == self.path and plistlib.loads(Path(source).read_bytes()) != plistlib.loads(self.original):
                raise OSError('atomic install failed')
            return replace(source, target)
        with patch.object(tunnel.os, 'replace', fail): result = tunnel.main(data)
        self.assert_legacy_restored(result)
        self.assertEqual(list(self.path.parent.glob('.' + self.path.name + '.*')), [])

    def test_old_bootout_failure_preserves_exact_loaded_original(self):
        data = self.legacy(); self.bootout_failed.add(tunnel.LABEL)
        self.assert_legacy_restored(tunnel.main(data))
        self.assertEqual([c for c in self.calls if c[0] == 'bootstrap'], [])

    def test_failed_machine_cleanup_never_claims_machine_only_as_phone_recovery(self):
        data = self.legacy(); self.bootstrap_failed = True
        launch = tunnel.launch
        def fail(*args):
            if args[0] == 'bootout' and args[-1].endswith('/' + tunnel.LABEL) and len(tunnel.option(self.loaded[tunnel.LABEL]['ProgramArguments'], '-R')) == 1:
                self.bootout_failed.add(tunnel.LABEL)
            return launch(*args)
        with patch.object(tunnel, 'launch', fail): result = tunnel.main(data)
        self.assertEqual(list(self.loaded), [tunnel.LABEL])
        self.assertEqual(tunnel.option(self.loaded[tunnel.LABEL]['ProgramArguments'], '-R'), ['127.0.0.1:2222:127.0.0.1:22'])
        self.assertEqual(plistlib.loads(self.path.read_bytes()), self.loaded[tunnel.LABEL], 'never overwrite a surviving live job')
        self.assert_incomplete(result)

    def test_failed_phone_file_cleanup_does_not_reload_combined_job(self):
        data = self.legacy(); self.bootstrap_failed = True; unlink = Path.unlink
        def fail(path, *args, **kwargs):
            if path == self.phone_path: raise OSError('phone deletion denied')
            return unlink(path, *args, **kwargs)
        with patch.object(Path, 'unlink', fail): result = tunnel.main(data)
        self.assertEqual(self.loaded, {})
        self.assertNotEqual(self.path.read_bytes(), self.original)
        self.assert_incomplete(result)

    def test_failed_original_bootstrap_is_reported_incomplete(self):
        data = self.legacy(); self.bootstrap_failed = True; self.restore_failed = True
        result = tunnel.main(data)
        self.assertEqual(self.loaded, {}); self.assertEqual(self.path.read_bytes(), self.original)
        self.assert_incomplete(result)

    def test_failed_original_file_restore_is_reported_incomplete(self):
        data = self.legacy(); self.bootstrap_failed = True; write = tunnel.atomic_write
        def fail(path, content, mode=0o644):
            if path == self.path and content == self.original: raise OSError('original restore denied')
            write(path, content, mode)
        with patch.object(tunnel, 'atomic_write', fail): result = tunnel.main(data)
        self.assertEqual(self.loaded, {}); self.assertNotEqual(self.path.read_bytes(), self.original)
        self.assert_incomplete(result)

    def test_bootstrap_error_after_loading_is_owned_and_cleaned_on_rollback(self):
        data = self.legacy(); launch = tunnel.launch
        def fail(*args):
            result = launch(*args)
            return subprocess.CompletedProcess(args, 1, '', '') if args[0] == 'bootstrap' and args[-1] == str(self.phone_path) else result
        with patch.object(tunnel, 'launch', fail): result = tunnel.main(data)
        self.assert_legacy_restored(result)

    def test_wrong_loaded_arguments_on_commit_are_not_accepted_or_overwritten(self):
        data = self.legacy(); self.corrupt_bootstrap.add(tunnel.PHONE_LABEL)
        result = tunnel.main(data)
        self.assertTrue(self.phone_path.exists())
        self.assertEqual(plistlib.loads(self.phone_path.read_bytes())['ProgramArguments'] + ['WRONG'], self.loaded[tunnel.PHONE_LABEL]['ProgramArguments'])
        self.assert_incomplete(result)

    def test_wrong_loaded_arguments_on_rollback_are_not_recovered(self):
        data = self.legacy(); self.bootstrap_failed = True; launch = tunnel.launch
        def corrupt(*args):
            result = launch(*args)
            if args[0] == 'bootstrap' and tunnel.LABEL in self.loaded and len(tunnel.option(self.loaded[tunnel.LABEL]['ProgramArguments'], '-R')) == 2:
                self.loaded[tunnel.LABEL]['ProgramArguments'].append('WRONG')
            return result
        with patch.object(tunnel, 'launch', corrupt): result = tunnel.main(data)
        self.assert_incomplete(result)

    def test_successful_rollback_allows_retry_with_unique_retained_backups(self):
        data = self.legacy(); self.bootstrap_failed = True
        first = tunnel.main(data); self.assert_legacy_restored(first)
        self.bootstrap_failed = False
        second = tunnel.main(data)
        self.assertTrue(second['tunnelRunning']); self.assertEqual(second['missing'], [])
        self.assertNotEqual(first['backupPath'], second['backupPath'])
        for result in [first, second]:
            self.assertEqual((Path(result['backupPath']) / (tunnel.LABEL + '.original')).read_bytes(), self.original)

    def new_port(self, action='split'):
        return {**self.data, 'action': action, 'forwards': [
            dict(listenHost='127.0.0.1', listenPort=2222, targetHost='127.0.0.1', targetPort=22),
            dict(listenHost='127.0.0.1', listenPort=8780, targetHost='127.0.0.1', targetPort=7790)]}

    def test_explicit_split_accepts_phone_port_change_on_combined_legacy_job(self):
        self.legacy()
        result = tunnel.main(self.new_port())
        self.assertTrue(result['tunnelRunning']); self.assertEqual(result['missing'], [])
        self.assertEqual(tunnel.option(self.loaded[tunnel.PHONE_LABEL]['ProgramArguments'], '-R'), ['127.0.0.1:8780:127.0.0.1:7790'])

    def test_split_port_change_preserves_machine_and_ordinary_conflict_checks(self):
        result = tunnel.main(self.data); path = Path(result['plistPath']); original = path.read_bytes()
        machine = self.loaded[tunnel.LABEL]; self.calls.clear()
        for action in ['verify', 'setup']:
            self.assertIn('mac_bridge_plist_conflict', tunnel.main(self.new_port(action))['missing'])
        self.assertEqual([c for c in self.calls if c[0] in ('bootout', 'bootstrap')], [])
        result = tunnel.main(self.new_port())
        self.assertTrue(result['tunnelRunning']); self.assertEqual(path.read_bytes(), original)
        self.assertIs(self.loaded[tunnel.LABEL], machine)
        mutations = [c for c in self.calls if c[0] in ('bootout', 'bootstrap')]
        self.assertEqual(len(mutations), 2)
        self.assertTrue(all(tunnel.PHONE_LABEL in c[-1] for c in mutations))

    def test_port_change_failure_restores_phone_without_touching_machine(self):
        result = tunnel.main(self.data); path = Path(result['plistPath']); phone_path = path.with_name(tunnel.PHONE_LABEL + '.plist')
        original = phone_path.read_bytes(); machine = self.loaded[tunnel.LABEL]; self.calls.clear(); launch = tunnel.launch
        def fail(*args):
            if args[0] == 'bootstrap' and args[-1] == str(phone_path) and b'7790' in phone_path.read_bytes():
                return subprocess.CompletedProcess(args, 1, '', '')
            return launch(*args)
        with patch.object(tunnel, 'launch', fail): result = tunnel.main(self.new_port())
        self.assertIn('mac_bridge_bootstrap_failed', result['missing']); self.assertTrue(result['tunnelRunning'])
        self.assertEqual(phone_path.read_bytes(), original); self.assertIs(self.loaded[tunnel.LABEL], machine)
        self.assertEqual((Path(result['backupPath']) / (tunnel.PHONE_LABEL + '.original')).read_bytes(), original)
        self.assertTrue(all(tunnel.PHONE_LABEL in c[-1] for c in self.calls if c[0] in ('bootout', 'bootstrap')))


if __name__ == '__main__': unittest.main()
