#!/usr/bin/env python3
"""Temporary-only capability and dynamic OpenSSH policy regressions."""
import concurrent.futures
import json
import os
import secrets
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


class Capabilities(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='drover-machine-check-')
        self.root = Path(self.temp.name) / 'capabilities'; self.root.mkdir()
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0)); self.port = s.getsockname()[1]
        self.process = subprocess.Popen(['python3', str(ROOT / 'capability-server.py')],
            env={**os.environ, 'DROVER_CAPABILITIES': str(self.root), 'DROVER_CAPABILITY_PORT': str(self.port)},
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        self.token = secrets.token_urlsafe(32)
        self.receipt = secrets.token_urlsafe(32)
        self.key = run('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(self.root / 'key'))
        self.private_key = (self.root / 'key').read_text()
        self.key = ' '.join((self.root / 'key.pub').read_text().split()[:2])
        self.cap = dict(expiresAt=time.time()*1000+7200000, script='echo installer',
                        credentials={'agentsPublicKey': self.key, 'bridge': {'tunnelPrivateKey': self.private_key}}, receipt=self.receipt, machineId='fixture', os='linux')
        self.path = self.root / (self.token + '.json'); self.path.write_text(json.dumps(self.cap))
        for _ in range(100):
            try:
                with socket.create_connection(('127.0.0.1', self.port), timeout=0.1): break
            except OSError: time.sleep(0.02)

    def tearDown(self):
        self.process.terminate(); self.process.communicate(timeout=5); self.temp.cleanup()

    def request(self, op, body=None, auth=''):
        req = urllib.request.Request(f'http://127.0.0.1:{self.port}/machines/install/{self.token}/{op}',
            json.dumps(body).encode() if body else None, headers={'Authorization': auth})
        try:
            with urllib.request.urlopen(req, timeout=5) as r: return r.status, r.read().decode(), r.headers
        except urllib.error.HTTPError as e: return e.code, e.read().decode(), e.headers

    def test_atomic_download_and_receipt(self):
        status, script, headers = self.request('script')
        self.assertEqual((status, script), (200, 'echo installer'))
        self.assertEqual(headers['Cache-Control'], 'no-store')
        with concurrent.futures.ThreadPoolExecutor(8) as pool:
            replies = list(pool.map(lambda _: self.request('key'), range(8)))
        self.assertEqual(sum(s == 200 for s, _, _ in replies), 1)
        self.assertEqual(sum(s == 410 for s, _, _ in replies), 7)
        download = json.loads(next(body for status, body, _ in replies if status == 200))
        self.assertEqual(download['bridge']['tunnelPrivateKey'], self.private_key)
        self.assertNotIn('PRIVATE KEY', script)
        self.assertIsNone(json.loads(self.path.read_text())['credentials'])
        self.assertNotIn('PRIVATE KEY', self.path.read_text())
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.request('script')[0], 410)
        report = dict(machineId='fixture', os='linux', state='installed', hostKey=self.key)
        self.assertEqual(self.request('report', report, 'Bearer wrong')[0], 403)
        self.assertEqual(self.request('report', {**report, 'machineId': 'another'}, 'Bearer '+self.receipt)[0], 400)
        self.assertEqual(self.request('report', report, 'Bearer '+self.receipt)[0], 200)
        self.assertEqual(json.loads(self.path.read_text())['report'], report)

    def test_expiry_and_revocation(self):
        self.cap['expiresAt'] = time.time()*1000-1; self.path.write_text(json.dumps(self.cap))
        self.assertEqual(self.request('key')[0], 410)
        self.assertFalse(self.path.exists())
        self.assertEqual(self.request('script')[0], 410)

    def test_recovery_receipt_is_bound_after_single_use_download(self):
        self.cap['cleanupId'] = 'recovery-fixture'
        self.cap['credentials']['recoveryCleanup'] = dict(id='recovery-fixture', agentsPublicKeys=[self.key], managementPublicKey=self.key)
        self.path.write_text(json.dumps(self.cap))
        self.assertEqual(self.request('key')[0], 200)
        report = dict(machineId='fixture', os='linux', state='installed', hostKey=self.key)
        self.assertEqual(self.request('report', report, 'Bearer '+self.receipt)[0], 400)
        self.assertEqual(self.request('report', {**report, 'cleanupId':'wrong'}, 'Bearer '+self.receipt)[0], 400)
        self.assertNotIn('report', json.loads(self.path.read_text()))
        self.assertEqual(self.request('report', {**report, 'cleanupId':'recovery-fixture'}, 'Bearer '+self.receipt)[0], 200)
        self.assertEqual(json.loads(self.path.read_text())['report']['cleanupId'], 'recovery-fixture')


class Policy(unittest.TestCase):
    def test_dynamic_ports_and_jump_restrictions(self):
        with tempfile.TemporaryDirectory(prefix='drover-policy-check-') as temp:
            root = Path(temp)
            run('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(root/'host'))
            key = ' '.join((root/'host.pub').read_text().split()[:2])
            data = dict(action='setup', agentsPublicKey=key, origin='https://fixture.example', phone=False, phonePort=8780,
                        targets=[dict(id='a', user='dt-'+'a'*16, port=24123, publicKey=key),
                                 dict(id='b', user='dt-'+'b'*16, port=25124, publicKey=key)])
            manifest = root/'manifest'; manifest.write_text(json.dumps(data))
            run('python3', str(ROOT/'bridge-data.py'), 'plan', str(manifest), str(root/'state'), str(root))
            config = root/'sshd_config'
            config.write_text(f'HostKey {root/"host"}\nUsePAM no\n'+(root/'policy').read_text())
            for user, forward, permitted, denied in [('dt-'+'a'*16, 'remote', 'permitlisten 127.0.0.1:24123', 'permitopen none'),
                                                    ('drover-jump', 'local', 'permitopen 127.0.0.1:24123 127.0.0.1:25124', 'permitlisten none')]:
                out = run('/usr/sbin/sshd', '-T', '-f', str(config), '-C', 'user='+user+',host=localhost,addr=127.0.0.1,laddr=127.0.0.1,lport=22')
                for expected in ['allowtcpforwarding '+forward, permitted, denied, 'maxsessions 0', 'gatewayports no', 'passwordauthentication no', 'kbdinteractiveauthentication no']:
                    self.assertIn(expected, out.splitlines())
            data['targets'][1]['port'] = 24123; manifest.write_text(json.dumps(data))
            result = subprocess.run(['python3', str(ROOT/'bridge-data.py'), 'plan', str(manifest), str(root/'state'), str(root)], capture_output=True)
            self.assertNotEqual(result.returncode, 0)


if __name__ == '__main__':
    unittest.main()
