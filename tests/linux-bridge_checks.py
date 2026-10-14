"""No real services, keys, network or home writes; injected process runner only."""
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('bridge', Path(__file__).parent.parent / 'remote/bridge/linux-install.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='drover-bridge-')
        self.addCleanup(self.temp.cleanup)
        self.env = dict(HOME=str(Path(self.temp.name).resolve()), VPS_HOST='bridge.example', VPS_USER='bridge-mac', VPS_PORT='222')
        self.paths = bridge.paths(self.env)
        self.data = bridge.transport(self.env, self.paths)

    def credentials(self):
        bridge.private_dir(self.paths['key'].parent)
        self.paths['key'].write_text('fake private key'); self.paths['key'].chmod(0o600)
        self.paths['known'].write_text('[bridge.example]:222 ssh-ed25519 fake-pin\n'); self.paths['known'].chmod(0o600)

    def test_paths_and_literal_unit(self):
        p = bridge.paths(dict(self.env, XDG_CONFIG_HOME='/config'))
        self.assertEqual(str(p['unit']), '/config/systemd/user/dev.drover.bridge.service')
        self.assertEqual(bridge.paths(dict(self.env, XDG_CONFIG_HOME='relative'))['unit'], self.paths['unit'])
        data = dict(self.data, identityFile='/home/test $USER% name/key')
        unit = bridge.render(data)
        self.assertIn('"/home/test $$USER%% name/key"', unit)
        for token in ['127.0.0.1:2222:localhost:22', '127.0.0.1:8780:127.0.0.1:7780', 'StrictHostKeyChecking=yes', 'BatchMode=yes', 'RestartSec=10', 'WantedBy=default.target']:
            self.assertIn(token, unit)
        with self.assertRaises(ValueError): bridge.quote('bad\nargument')
        for env in [dict(self.env, VPS_HOST='$(id)'), dict(self.env, VPS_PORT='0'), dict(self.env, VPS_USER='root;bad')]:
            with self.assertRaises(ValueError): bridge.transport(env, self.paths)

    def test_status_requires_all_properties_and_does_not_mutate(self):
        cases = [('active', 'running', '123', 0, True), ('active', 'dead', '123', 0, False),
                 ('inactive', 'running', '123', 0, False), ('active', 'running', '0', 0, False),
                 ('active', 'running', '123', 1, False)]
        for active, sub, pid, code, expected in cases:
            result = subprocess.CompletedProcess([], code, f'ActiveState={active}\nSubState={sub}\nMainPID={pid}\n', '')
            with patch.object(bridge, 'run', return_value=result):
                self.assertEqual(bridge.status(self.paths)['tunnelRunning'], expected)
        self.assertFalse(self.paths['unit'].exists())

    def test_install_is_user_scoped_and_writes_private_metadata(self):
        self.credentials()
        calls = []
        def run(args, check=True):
            calls.append(args)
            output = 'disabled\n' if 'is-enabled' in args else 'inactive\n' if 'is-active' in args else ''
            return subprocess.CompletedProcess(args, 0, output, '')
        with patch.object(bridge, 'run', side_effect=run): bridge.install(self.data, self.paths)
        self.assertEqual(json.loads(self.paths['metadata'].read_text()), self.data)
        self.assertEqual(self.paths['metadata'].stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.paths['unit'].stat().st_mode & 0o777, 0o644)
        self.assertIn(['systemctl', '--user', 'enable', bridge.SERVICE], calls)
        self.assertIn(['ssh-keygen', '-F', '[bridge.example]:222', '-f', str(self.paths['known'])], calls)
        self.assertFalse(any('sudo' in args or 'loginctl' in args for args in calls))

    def test_restart_failure_restores_files_enabled_and_running_state(self):
        self.credentials()
        for name, text in [('unit', 'old unit'), ('metadata', '{"old":true}')]:
            bridge.private_dir(self.paths[name].parent); self.paths[name].write_text(text)
        calls = []
        failed = False
        def run(args, check=True):
            nonlocal failed
            calls.append(args)
            if 'restart' in args and not failed:
                failed = True
                raise subprocess.CalledProcessError(1, args)
            output = 'enabled\n' if 'is-enabled' in args else 'active\n' if 'is-active' in args else ''
            return subprocess.CompletedProcess(args, 0, output, '')
        with patch.object(bridge, 'run', side_effect=run):
            with self.assertRaisesRegex(ValueError, 'rollback succeeded'): bridge.install(self.data, self.paths)
        self.assertEqual(self.paths['unit'].read_text(), 'old unit')
        self.assertEqual(self.paths['metadata'].read_text(), '{"old":true}')
        self.assertEqual(calls[-3:], [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', bridge.SERVICE], ['systemctl', '--user', 'restart', bridge.SERVICE]])

    def test_new_install_failure_removes_new_files_and_disables_unit(self):
        self.credentials()
        calls = []
        def run(args, check=True):
            calls.append(args)
            if args[0] == 'systemd-analyze': raise subprocess.CalledProcessError(1, args)
            return subprocess.CompletedProcess(args, 0, 'inactive\n', '')
        with patch.object(bridge, 'run', side_effect=run):
            with self.assertRaises(ValueError): bridge.install(self.data, self.paths)
        self.assertFalse(self.paths['unit'].exists()); self.assertFalse(self.paths['metadata'].exists())
        self.assertIn(['systemctl', '--user', 'disable', bridge.SERVICE], calls)
        self.assertIn(['systemctl', '--user', 'stop', bridge.SERVICE], calls)

    def test_symlink_is_rejected_before_any_process(self):
        self.paths['key'].parent.symlink_to(Path(self.temp.name) / 'outside')
        with patch.object(bridge, 'run') as runner:
            with self.assertRaises(ValueError): bridge.ensure_key(self.paths['key'])
            runner.assert_not_called()

    def phone_fixture(self):
        self.credentials()
        bridge.private_dir(self.paths['unit'].parent)
        machine = bridge.render(self.data).replace(' "-R" "127.0.0.1:8780:127.0.0.1:7780"', '')
        phone = bridge.render(self.data).replace(' "-R" "127.0.0.1:2222:localhost:22"', '')
        self.phone = self.paths['unit'].with_name(bridge.PHONE_SERVICE)
        self.paths['unit'].write_text(machine); self.phone.write_text(phone)
        self.machine_original, self.phone_original = machine, phone
        self.loaded = {bridge.SERVICE: bridge.unit_args(machine), bridge.PHONE_SERVICE: bridge.unit_args(phone)}
        self.calls = []
        def run(args, check=True):
            self.calls.append(args)
            if args[:2] == ['systemctl', '--user']:
                action = args[2]
                if action == 'stop': self.loaded.pop(args[3], None)
                if action in ('start', 'restart'):
                    self.loaded[args[3]] = bridge.unit_args(self.paths['unit'].with_name(args[3]).read_text())
                if action == 'is-active': return subprocess.CompletedProcess(args, 0, 'active\n' if args[3] in self.loaded else 'inactive\n', '')
            return subprocess.CompletedProcess(args, 0, '', '')
        for target, value in [('run', run), ('active_exact', lambda service, arguments: self.loaded.get(service) == arguments), ('wait_exact', lambda service, arguments: self.loaded.get(service) == arguments)]:
            patcher = patch.object(bridge, target, value); patcher.start(); self.addCleanup(patcher.stop)
        return dict(action='move-phone', home=str(self.paths['home']), host='new.example', port=22, user='bridge-mac',
                    keyPath=str(self.paths['key']), knownHostsPath=str(self.paths['known']), phone=True,
                    forwards=[dict(listenHost='127.0.0.1', listenPort=8780, targetHost='127.0.0.1', targetPort=8791)], publicUrl='https://new.example')

    def test_move_phone_preserves_machine_and_old_until_https_then_exact_settings_rollback(self):
        data = self.phone_fixture()
        def verify(url):
            self.assertEqual(url, data['publicUrl'])
            self.assertEqual(self.paths['unit'].read_text(), self.machine_original)
            if any('candidate' in name for name in self.loaded):
                self.assertEqual(self.phone.read_text(), self.phone_original)
                self.assertEqual(self.loaded[bridge.PHONE_SERVICE], bridge.unit_args(self.phone_original))
        with patch.object(bridge, 'phone_url', side_effect=verify): moved = bridge.phone_transaction(data, self.env)
        self.assertTrue(moved['moved']); self.assertTrue(moved['verified'])
        restored = bridge.phone_transaction(dict(action='rollback-phone', home=data['home'], backupPath=moved['backupPath']), self.env)
        self.assertTrue(restored['recovered']); self.assertEqual(self.phone.read_text(), self.phone_original)
        self.assertEqual(self.paths['unit'].read_text(), self.machine_original)
        self.assertFalse(any(bridge.SERVICE in args and ('stop' in args or 'restart' in args) for args in self.calls))

    def test_move_phone_https_failure_keeps_old_and_finish_cleans_only_transaction(self):
        data = self.phone_fixture()
        with patch.object(bridge, 'phone_url', side_effect=ValueError('wrong site')): failed = bridge.phone_transaction(data, self.env)
        self.assertTrue(failed['recovered']); self.assertFalse(failed['moved'])
        self.assertEqual(self.phone.read_text(), self.phone_original)
        with patch.object(bridge, 'phone_url'): moved = bridge.phone_transaction(data, self.env)
        result = bridge.phone_transaction(dict(action='finish-phone', home=data['home'], backupPath=moved['backupPath']), self.env)
        self.assertTrue(result['verified']); self.assertFalse(Path(moved['backupPath']).exists())
        self.assertEqual(self.paths['unit'].read_text(), self.machine_original)

    def test_phone_post_switch_failure_restores_crlf_bytes_and_mode(self):
        data = self.phone_fixture()
        original = self.phone_original.replace('\n', '\r\n').encode()
        self.phone.write_bytes(original); self.phone.chmod(0o640)
        with patch.object(bridge, 'phone_url', side_effect=[None, ValueError('new route lost')]): failed = bridge.phone_transaction(data, self.env)
        self.assertTrue(failed['recovered']); self.assertFalse(failed['moved'])
        self.assertEqual(self.phone.read_bytes(), original)
        self.assertEqual(self.phone.stat().st_mode & 0o777, 0o640)
        self.assertEqual(self.paths['unit'].read_text(), self.machine_original)


unittest.main()
