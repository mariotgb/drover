#!/usr/bin/env python3
"""Legacy inventory and desktop launchd fixtures, inside a disposable container."""
import hashlib
import json
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path('/fixture/remote')
if os.environ.get('DROVER_MACHINE_CONTAINER_TEST') != '1' or not Path('/.dockerenv').exists() or not ROOT.is_dir():
    sys.exit('Run only in the isolated Machines check container.')


def run(*args, **kwargs):
    result = subprocess.run(args, text=True, capture_output=True, timeout=30, **kwargs)
    if result.returncode:
        raise AssertionError(f'{Path(args[0]).name} failed with code {result.returncode}')
    return result.stdout


class BridgeChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='drover-bridge-check-')
        cls.work = Path(cls.temp.name)
        cls.bin = cls.work / 'bin'; cls.bin.mkdir()
        cls.calls = cls.work / 'calls'; cls.calls.write_text('')
        cls.status = cls.work / 'ufw'; cls.status.write_text('Status: active\n80/tcp ALLOW IN Anywhere\n443/tcp ALLOW IN Anywhere\n')
        cls.loaded = cls.work / 'loaded'
        cls.make_cli('systemctl', 'printf "%s\\n" "$*" >> "$CHECK_CALLS"\nexit 0\n')
        cls.make_cli('ufw', 'printf "%s\\n" "$*" >> "$CHECK_CALLS"\ncase "$1" in status) cat "$CHECK_UFW";; allow) exit 0;; *) exit 88;; esac\n')
        cls.make_cli('ss', 'printf "LISTEN 0 128 127.0.0.1:22 0.0.0.0:*\\nLISTEN 0 128 127.0.0.1:2222 0.0.0.0:*\\nLISTEN 0 128 127.0.0.1:8780 0.0.0.0:*\\n"\n')
        cls.make_cli('launchctl', '''printf "%s\\n" "$*" >> "$CHECK_CALLS"
case "$1" in
 print) [ -e "$CHECK_LOADED" ] || exit 113; printf 'state = running\\npid = 123\\n';;
 bootstrap) touch "$CHECK_LOADED";;
 *) exit 88;;
esac
''')
        cls.env = {**os.environ, 'PATH': str(cls.bin) + ':' + os.environ['PATH'],
                   'CHECK_CALLS': str(cls.calls), 'CHECK_UFW': str(cls.status), 'CHECK_LOADED': str(cls.loaded),
                   'SSH_CONNECTION': '127.0.0.1 10000 127.0.0.1 22', 'CADDYFILE': str(cls.work/'Caddyfile'),
                   'DROVER_BRIDGE_STATE': str(cls.work/'state')}
        cls.keys = {}
        for name in ('mac', 'pc', 'home', 'jump-mac', 'jump-phone', 'managed'):
            path = cls.work/name
            run('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(path))
            cls.keys[name] = ' '.join(Path(str(path)+'.pub').read_text().split()[:2])
        run('bash', str(ROOT/'bridge/vps-setup.sh'), '--mac-key', str(cls.work/'mac.pub'),
            '--pc-key', str(cls.work/'pc.pub'), '--home-key', str(cls.work/'home.pub'),
            '--jump-mac-key', str(cls.work/'jump-mac.pub'), '--jump-iphone-key', str(cls.work/'jump-phone.pub'), '--yes', env=cls.env)
        # Existing basic auth and route must survive every verify/adopt call.
        cfg = run('bash', '-c', '. "$1"; render_caddyfile fixture.invalid 20MiB fixture-user "$2"',
                  'fixture', str(ROOT/'bridge/vps-web.sh'), run('caddy', 'hash-password', '--plaintext', 'fixture-password-only').strip())
        # The container ships Caddy 2.6 (old spelling), while the script supports
        # current Caddy. Both adapt to the same HTTP authentication handler.
        (cls.work/'Caddyfile').write_text(cfg.replace('basic_auth {', 'basicauth {'))
        cls.calls.write_text('')

    @classmethod
    def make_cli(cls, name, script):
        path = cls.bin/name; path.write_text('#!/bin/sh\nset -eu\n' + script); path.chmod(0o755)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def verify(self, **kwargs):
        manifest = self.work/'manifest'
        data = dict(action='verify', legacy=dict(users=['bridge-mac','bridge-pc','bridge-home','jump'], tunnelUser='bridge-mac',
                                                forwards=[dict(listenHost='127.0.0.1',listenPort=2222,targetHost='localhost',targetPort=22),
                                                          dict(listenHost='127.0.0.1',listenPort=8780,targetHost='127.0.0.1',targetPort=7780)],
                                                publicUrl='https://fixture.invalid'))
        data.update(kwargs); manifest.write_text(json.dumps(data))
        output = run('bash', str(ROOT/'machines/bridge.sh'), str(manifest), env=self.env)
        self.assertEqual(len(output.splitlines()), 1)
        return json.loads(output.removeprefix('DROVER_BRIDGE_REPORT '))

    def test_legacy_adoption_is_byte_preserving_and_read_only(self):
        paths = [Path('/etc/ssh/sshd_config'), Path('/etc/ssh/drover-hub-policy.conf'), self.work/'Caddyfile']
        paths += [Path('/home')/u/'.ssh/authorized_keys' for u in ('bridge-mac','bridge-pc','bridge-home','jump')]
        snapshots = {str(p): (hashlib.sha256(p.read_bytes()).hexdigest(), p.stat().st_mtime_ns) for p in paths}
        self.calls.write_text('')
        for action in ('verify', 'adopt', 'adopt'):
            report = self.verify(action=action)
            self.assertTrue(report['policy']); self.assertTrue(report['firewall'])
            self.assertEqual(report['missing'], [])
            self.assertEqual(report['jumpUser'], 'jump')
            self.assertEqual(report['caddy'], dict(configured=True, active=True, installerRoute=False, publicUrl='https://fixture.invalid', upstream='127.0.0.1:8780'))
            self.assertIn(8780, report['listeners'])
            self.assertTrue(all(u['authorizedKeyOptions'] for u in report['users']))
        self.assertEqual(snapshots, {str(p): (hashlib.sha256(p.read_bytes()).hexdigest(), p.stat().st_mtime_ns) for p in paths})
        self.assertFalse((self.work/'state').exists())
        self.assertTrue(all(line in ('is-active --quiet caddy', 'status') for line in self.calls.read_text().splitlines()))
        self.assertNotIn('ssh-ed25519', json.dumps(report))

    def test_cleanup_preserves_surviving_and_unowned_target_keys(self):
        state = self.work/'cleanup-state'
        policy = Path('/etc/ssh/drover-cleanup-check-policy.conf')
        config = Path('/etc/ssh/sshd_config'); original_config = config.read_bytes()
        caddy = self.work/'Caddyfile'; original_caddy = caddy.read_bytes()
        env = {**self.env, 'DROVER_BRIDGE_STATE':str(state), 'DROVER_BRIDGE_POLICY':str(policy)}
        manifest = self.work/'cleanup-manifest'
        targets = [dict(id='cleanup-a',user='dt-'+'e'*16,port=24580,publicKey=self.keys['managed']),
                   dict(id='cleanup-b',user='dt-'+'f'*16,port=24581,publicKey=self.keys['managed'])]
        def action(data):
            manifest.write_text(json.dumps(data))
            return run('bash',str(ROOT/'machines/bridge.sh'),str(manifest),env=env)
        try:
            action(dict(action='repair',targets=targets,agentsPublicKey=self.keys['managed'],origin='https://fixture.invalid',phone=True,phonePort=8780))
            # This public key belongs to another installation, even though its
            # comment uses the same common Drover tag. Preserve exact bytes.
            foreign = ('# unrelated key must survive\nrestrict,port-forwarding,permitlisten="127.0.0.1:24580" '
                       + self.keys['mac'] + ' drover-machines ' + self.keys['managed'] + '\n').encode()
            files = [Path('/home')/t['user']/'.ssh/authorized_keys' for t in targets]
            for path in files:
                with path.open('ab') as output: output.write(foreign)
            survivor = files[1]
            survivor_before = survivor.read_bytes(), survivor.stat().st_mtime_ns
            # Old v1 state has explicit current public keys but no new ledger.
            # Migrate only their fingerprints; never infer ownership by tags.
            old_state = json.loads((state/'state.json').read_text())
            old_state.pop('ownedKeyFingerprints')
            (state/'state.json').write_text(json.dumps(old_state))
            action(dict(action='remove',ids=[targets[0]['id']],agentsPublicKey=self.keys['home']))
            self.assertEqual((survivor.read_bytes(),survivor.stat().st_mtime_ns),survivor_before)
            self.assertEqual(files[0].read_bytes(),foreign)
            saved = json.loads((state/'state.json').read_text())
            self.assertTrue(saved['additive'])
            self.assertIn(targets[0]['user'],saved['ownedKeyFingerprints'])
            self.assertEqual(saved['targets'],[targets[1]])
            # Retire also removes a previously appended owned jump key, without
            # deleting a third, unowned key with the same shared comment.
            action(dict(action='repair',targets=[],agentsPublicKey=self.keys['pc'],origin='https://fixture.invalid',phone=True,phonePort=8780))
            jump = Path('/home/drover-jump/.ssh/authorized_keys')
            foreign_jump = ('restrict,port-forwarding,permitopen="127.0.0.1:24581" '+self.keys['home']+' drover-machines\n').encode()
            with jump.open('ab') as output: output.write(foreign_jump)
            action(dict(action='retire'))
            self.assertEqual(jump.read_bytes(),foreign_jump)
            self.assertEqual(survivor.read_bytes(),foreign)
            self.assertEqual(files[0].read_bytes(),foreign)
            # Fingerprint-looking text in a comment must not identify a key.
            self.assertEqual(survivor.read_bytes(),foreign)
            before = [(p.read_bytes(),p.stat().st_mtime_ns) for p in files+[jump]]
            action(dict(action='retire'))
            self.assertEqual([(p.read_bytes(),p.stat().st_mtime_ns) for p in files+[jump]],before)
            # No state proves ownership: refuse without touching any account.
            (state/'state.json').unlink()
            manifest.write_text(json.dumps(dict(action='retire')))
            refused = subprocess.run(['bash',str(ROOT/'machines/bridge.sh'),str(manifest)],env=env,text=True,capture_output=True,timeout=30)
            self.assertNotEqual(refused.returncode,0)
            self.assertIn('bridge_credential_conflict',refused.stdout)
            self.assertEqual([(p.read_bytes(),p.stat().st_mtime_ns) for p in files+[jump]],before)
        finally:
            config.write_bytes(original_config); caddy.write_bytes(original_caddy)
            policy.unlink(missing_ok=True); shutil.rmtree(state,ignore_errors=True)
            for name in [t['user'] for t in targets]+['drover-jump']:
                run('userdel','-r',name)

    def test_subset_without_phone_is_valid_and_firewall_is_separate(self):
        self.status.write_text('Status: active\n')
        try:
            report = self.verify(legacy=dict(users=['bridge-mac','jump'], tunnelUser='bridge-mac', phone=False,
                                forwards=[dict(listenHost='127.0.0.1',listenPort=2222,targetHost='localhost',targetPort=22)]))
            self.assertEqual(report['missing'], [])
            self.assertTrue(report['policy'])
            phone = self.verify()
            self.assertFalse(phone['firewall'])
            self.assertIn('bridge_firewall_missing', phone['missing'])
        finally:
            self.status.write_text('Status: active\n80/tcp ALLOW IN Anywhere\n443/tcp ALLOW IN Anywhere\n')

    def test_missing_account_and_mismatched_phone_route_are_reported(self):
        report = self.verify(legacy=dict(users=['bridge-mac','jump'], publicUrl='https://other.invalid'))
        self.assertIn('phone_route_missing', report['missing'])
        self.assertFalse(report['caddy']['configured'])
        # Managed state has no authority to create users or credential files.
        state = self.work/'state'; state.mkdir(exist_ok=True)
        (state/'state.json').write_text(json.dumps(dict(targets=[dict(user='dt-'+'a'*16,port=24567)])))
        report = self.verify(legacy=dict(users=['dt-'+'a'*16,'drover-jump']))
        self.assertIn('bridge_users_missing', report['missing'])
        self.assertIn('bridge_policy_missing', report['missing'])
        (state/'state.json').unlink(); state.rmdir()

    def test_repair_adds_targets_and_installer_route_preserving_legacy(self):
        legacy_keys = [Path('/home')/u/'.ssh/authorized_keys' for u in ('bridge-mac','bridge-pc','bridge-home','jump')]
        legacy_policy = Path('/etc/ssh/drover-hub-policy.conf')
        snapshots = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in legacy_keys + [legacy_policy]}
        original_caddy = (self.work/'Caddyfile').read_text()
        state = self.work/'state'; state.mkdir(exist_ok=True)
        manifest = self.work/'repair'
        target = dict(id='repair',user='dt-'+'c'*16,port=24569,publicKey=self.keys['managed'])
        data = dict(action='repair',targets=[],agentsPublicKey=self.keys['managed'],origin='https://fixture.invalid',phone=True,phonePort=8780)
        # Match production service path; lifecycle is faked, SSH/Caddy are real.
        env = {**self.env, 'DROVER_BRIDGE_STATE':'/var/lib/drover-machines'}
        Path('/var/lib/drover-machines').mkdir(mode=0o700,exist_ok=True)
        for targets in ([], [target]):
            data['targets'] = targets; manifest.write_text(json.dumps(data))
            output = run('bash',str(ROOT/'machines/bridge.sh'),str(manifest),env=env)
            self.assertIn('DROVER_BRIDGE_READY', output)
            if not targets:
                zero = self.work/'zero-verify'
                zero.write_text(json.dumps(dict(action='verify',legacy=dict(users=['bridge-mac','jump','drover-jump'],publicUrl='https://fixture.invalid'))))
                zero_report = json.loads(run('bash',str(ROOT/'machines/bridge.sh'),str(zero),env=env).removeprefix('DROVER_BRIDGE_REPORT '))
                self.assertEqual(zero_report['missing'], [])
                self.assertTrue(zero_report['caddy']['installerRoute'])
        repaired_caddy = (self.work/'Caddyfile').read_text()
        self.assertIn('basicauth {', repaired_caddy)
        self.assertIn('fixture-user', repaired_caddy)
        self.assertIn('Strict-Transport-Security "max-age=31536000"', repaired_caddy)
        self.assertIn('reverse_proxy 127.0.0.1:8780', repaired_caddy)
        self.assertIn('handle /machines/install/*', repaired_caddy)
        self.assertEqual({p:(p.read_bytes(),p.stat().st_mtime_ns) for p in snapshots}, snapshots)
        saved = Path('/var/lib/drover-machines/state.json')
        self.assertEqual(json.loads(saved.read_text())['targets'], [target])
        jump = Path('/home/drover-jump/.ssh/authorized_keys')
        # Repeating and an empty target list preserve targets, keys and site.
        key_bytes, caddy_stamp = jump.read_bytes(), (self.work/'Caddyfile').stat().st_mtime_ns
        data['targets'] = []; manifest.write_text(json.dumps(data))
        run('bash',str(ROOT/'machines/bridge.sh'),str(manifest),env=env)
        self.assertEqual(json.loads(saved.read_text())['targets'], [target])
        self.assertEqual(jump.read_bytes(), key_bytes)
        self.assertEqual((self.work/'Caddyfile').stat().st_mtime_ns,caddy_stamp)
        # Key/port replacement is explicit cleanup, never silent repair.
        for changed in ({**target,'port':24570},{**target,'publicKey':self.keys['mac']}):
            data['targets']=[changed]; manifest.write_text(json.dumps(data))
            denied=subprocess.run(['bash',str(ROOT/'machines/bridge.sh'),str(manifest)],env=env,text=True,capture_output=True,timeout=30)
            self.assertNotEqual(denied.returncode,0)
            self.assertIn('bridge_credential_conflict',denied.stdout)
            self.assertEqual(jump.read_bytes(),key_bytes)
        data['targets']=[]
        verify = self.work/'repair-verify'
        verify.write_text(json.dumps(dict(action='verify',legacy=dict(users=['bridge-mac','jump','drover-jump',target['user']],publicUrl='https://fixture.invalid'))))
        report = json.loads(run('bash',str(ROOT/'machines/bridge.sh'),str(verify),env=env).removeprefix('DROVER_BRIDGE_REPORT '))
        self.assertEqual(report['missing'], []); self.assertTrue(report['caddy']['installerRoute'])
        # Installer-only verification still addresses the selected exact site.
        selected=json.loads(verify.read_text()); selected['legacy']['phone']=False
        verify.write_text(json.dumps(selected))
        only=json.loads(run('bash',str(ROOT/'machines/bridge.sh'),str(verify),env=env).removeprefix('DROVER_BRIDGE_REPORT '))
        self.assertTrue(only['caddy']['installerRoute'])
        # Cleanup touches managed credentials only; never removes the phone.
        for op in (dict(action='revoke-jump',publicKey=self.keys['managed']),
                   dict(action='remove',ids=['repair'],agentsPublicKey=self.keys['managed']), dict(action='retire')):
            manifest.write_text(json.dumps(op)); run('bash',str(ROOT/'machines/bridge.sh'),str(manifest),env=env)
        self.assertEqual(jump.read_bytes(), b'')
        self.assertEqual((Path('/home')/target['user']/'.ssh/authorized_keys').read_bytes(), b'')
        self.assertEqual({p:(p.read_bytes(),p.stat().st_mtime_ns) for p in snapshots}, snapshots)
        self.assertEqual((self.work/'Caddyfile').read_text(),repaired_caddy)
        self.assertNotEqual(original_caddy,repaired_caddy)
        # Clear fixture managed state for other independent inventory cases.
        saved.unlink(); state.rmdir()

    def test_repair_rejects_custom_route_before_touching_keys(self):
        cfg = self.work/'Caddyfile'; original = cfg.read_bytes()
        key = Path('/home/bridge-mac/.ssh/authorized_keys'); before = key.read_bytes()
        manifest = self.work/'unsafe-repair'
        manifest.write_text(json.dumps(dict(action='repair',targets=[],agentsPublicKey=self.keys['managed'],origin='https://fixture.invalid',phone=True,phonePort=8780)))
        cfg.write_text('# custom site\nfixture.invalid {\nreverse_proxy 127.0.0.1:8780\n}\n')
        try:
            result = subprocess.run(['bash',str(ROOT/'machines/bridge.sh'),str(manifest)],env=self.env,text=True,capture_output=True,timeout=30)
            self.assertNotEqual(result.returncode,0)
            self.assertIn('DROVER_BRIDGE_ERROR {"code":"caddy_repair_requires_manual_integration"}',result.stdout)
            self.assertEqual(key.read_bytes(),before)
        finally:
            cfg.write_bytes(original)

    def test_repair_planner_rejects_reserved_port(self):
        manifest=self.work/'reserved-plan'; plan=self.work/'reserved-work'; plan.mkdir()
        manifest.write_text(json.dumps(dict(action='repair',targets=[dict(id='collision',user='dt-'+'d'*16,port=2223,publicKey=self.keys['managed'])],
                                           agentsPublicKey=self.keys['managed'],origin='https://fixture.invalid',phone=False,phonePort=8780)))
        result=subprocess.run(['python3',str(ROOT/'machines/bridge-data.py'),'plan',str(manifest),str(self.work/'no-state'),str(plan)],text=True,capture_output=True)
        self.assertNotEqual(result.returncode,0); self.assertIn('bridge_port_conflict',result.stdout)

    def test_managed_layout_inventory(self):
        manifest = self.work/'managed-manifest'
        manifest.write_text(json.dumps(dict(action='setup',agentsPublicKey=self.keys['managed'],origin='https://fixture.invalid',phone=False,phonePort=8780,
                                           targets=[dict(id='fixture',user='dt-'+'b'*16,port=24568,publicKey=self.keys['managed'])])))
        plan = self.work/'plan'; plan.mkdir()
        run('python3', str(ROOT/'machines/bridge-data.py'), 'plan', str(manifest), str(self.work/'absent'), str(plan))
        cfg = self.work/'managed-sshd'; cfg.write_text('HostKey /etc/ssh/ssh_host_ed25519_key\n' + (plan/'policy').read_text())
        for name in ('dt-'+'b'*16, 'drover-jump'):
            run('useradd', '--user-group', '--create-home', '--shell', '/usr/sbin/nologin', '--comment', 'Drover hub', name)
        for entry in (plan/'keys-plan').read_text().splitlines():
            name, options, key = entry.split('|'); ssh = Path('/home')/name/'.ssh'; ssh.mkdir(mode=0o700)
            (ssh/'authorized_keys').write_text(options+' '+key+' fixture\n')
        state = self.work/'state'; state.mkdir(); (state/'state.json').write_text((plan/'state').read_text())
        old = self.env.get('SSHD_CONFIG'); self.env['SSHD_CONFIG'] = str(cfg)
        try:
            report = self.verify(legacy={})
            # Autodetection includes both layouts when both actually exist.
            self.assertEqual(report['missing'], ['bridge_policy_missing'])
            report = self.verify(legacy=dict(users=['dt-'+'b'*16,'drover-jump']))
            self.assertEqual(report['missing'], [])
            self.assertTrue(report['policy']); self.assertEqual(report['jumpUser'], 'drover-jump')
        finally:
            if old is None: self.env.pop('SSHD_CONFIG')
            else: self.env['SSHD_CONFIG'] = old
            (state/'state.json').unlink(); state.rmdir()
            for name in ('dt-'+'b'*16,'drover-jump'): run('userdel','-r',name)

    def mac(self, data):
        manifest = self.work/'mac-manifest'; manifest.write_text(json.dumps(data))
        output = run('python3', str(ROOT/'machines/mac-tunnel.py'), str(manifest), env=self.env)
        return json.loads(output.removeprefix('DROVER_MAC_BRIDGE_REPORT '))

    def test_mac_setup_reuses_existing_job_and_confirmed_pins(self):
        with tempfile.TemporaryDirectory(dir=self.work) as temp:
            home = Path(temp)
            known = home/'known'; known.write_text('fixture.invalid '+self.keys['managed']+'\n')
            data = dict(action='setup',home=str(home),host='fixture.invalid',port=22,user='bridge-mac',keyPath=str(self.work/'mac'),
                        knownHostsPath=str(known),phone=False)
            self.loaded.unlink(missing_ok=True); self.calls.write_text('')
            report = self.mac(data)
            self.assertEqual(report['missing'], []); self.assertTrue(report['tunnelRunning'])
            plist = Path(report['plistPath']); saved = plist.read_bytes(); stamp = plist.stat().st_mtime_ns
            arguments = plistlib.loads(saved)['ProgramArguments']
            self.assertEqual(arguments.count('-R'), 1)
            for action in ('verify','setup','setup'):
                self.assertEqual(self.mac({**data, 'action':action})['missing'], [])
            self.assertEqual(plist.read_bytes(), saved); self.assertEqual(plist.stat().st_mtime_ns, stamp)
            self.assertEqual(sum(line.startswith('bootstrap ') for line in self.calls.read_text().splitlines()), 1)
            self.assertNotIn('bootout', self.calls.read_text())
            # Old installer uses localhost ssh target and no HostKeyAlias.
            legacy = plistlib.loads(saved); args = legacy['ProgramArguments']
            args[args.index('127.0.0.1:2222:127.0.0.1:22')] = '127.0.0.1:2222:localhost:22'
            plist.write_bytes(plistlib.dumps(legacy)); saved = plist.read_bytes()
            self.assertEqual(self.mac({**data, 'hostKeyAlias':'managed-new-alias'})['missing'], [])
            self.assertEqual(plist.read_bytes(), saved)
            conflict = self.mac({**data, 'host':'different.invalid'})
            self.assertIn('mac_bridge_plist_conflict', conflict['missing'])
            self.assertEqual(plist.read_bytes(), saved)

    def test_mac_verify_does_not_bootstrap_and_missing_pin_blocks_setup(self):
        with tempfile.TemporaryDirectory(dir=self.work) as temp:
            data = dict(action='setup',home=temp,host='fixture.invalid',port=22,user='bridge-mac',keyPath=str(self.work/'mac'),phone=False)
            self.calls.write_text('')
            report = self.mac(data)
            self.assertIn('mac_bridge_host_pin_missing', report['missing'])
            self.assertFalse(Path(report['plistPath']).exists())
            self.assertEqual(self.calls.read_text(), '')
            report = self.mac({**data, 'action':'verify'})
            self.assertFalse(report['tunnelRunning'])
            self.assertEqual(self.calls.read_text(), '')

    def test_mac_nonstandard_ssh_port_uses_exact_bracket_pin(self):
        with tempfile.TemporaryDirectory(dir=self.work) as temp:
            known = Path(temp)/'known'
            known.write_text('[192.0.2.20]:2022 '+self.keys['managed']+'\n')
            data = dict(action='setup',home=temp,host='192.0.2.20',port=2022,user='bridge-mac',keyPath=str(self.work/'mac'),
                        knownHostsPath=str(known),hostKeyAlias='[192.0.2.20]:2022',phone=False)
            self.loaded.unlink(missing_ok=True)
            report = self.mac(data)
            self.assertEqual(report['missing'], []); self.assertTrue(report['tunnelRunning'])
            arguments = plistlib.loads(Path(report['plistPath']).read_bytes())['ProgramArguments']
            self.assertIn('HostKeyAlias=[192.0.2.20]:2022', arguments)


if __name__ == '__main__':
    unittest.main()
