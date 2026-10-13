#!/usr/bin/env python3
"""Loopback-only capability endpoint behind Caddy. Never logs secret URLs."""
import fcntl
import hmac
import json
import os
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(os.environ.get('DROVER_CAPABILITIES', '/var/lib/drover-machines/capabilities'))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, status, text, content='text/plain'):
        self.send_response(status)
        for name, value in [('Content-Type', content + '; charset=utf-8'), ('Cache-Control', 'no-store'),
                            ('Referrer-Policy', 'no-referrer'), ('X-Content-Type-Options', 'nosniff')]:
            self.send_header(name, value)
        self.send_header('Content-Length', str(len(text.encode())))
        self.end_headers()
        self.wfile.write(text.encode())

    def capability(self, method):
        self.connection.settimeout(10)
        match = re.fullmatch(r'/machines/install/([A-Za-z0-9_-]{43})/(script|key|report)', self.path)
        if not match:
            self.reply(404, 'Not found'); return
        path = ROOT / (match[1] + '.json')
        lockpath = ROOT.parent / 'lock'
        try:
            with lockpath.open('r') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                if path.is_symlink():
                    raise FileNotFoundError()
                cap = json.loads(path.read_text())
                if cap['expiresAt'] <= time.time() * 1000:
                    path.unlink(missing_ok=True)
                    self.reply(410, 'Install link expired. Generate a new command in Drover.'); return
                op = match[2]
                if method == 'GET' and op in ('script', 'key'):
                    if cap.get('credentials') is None:
                        self.reply(410, 'Install link already used.'); return
                    if op == 'script':
                        self.reply(200, cap['script']); return
                    value = cap['credentials']; cap['credentials'] = None
                    # Consume durably under the lock before writing any key bytes.
                    self.save(path, cap)
                    self.reply(200, json.dumps(value), 'application/json')
                elif method == 'POST' and op == 'report':
                    if cap.get('credentials') is not None or not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + cap['receipt']):
                        self.reply(403, 'Forbidden'); return
                    size = int(self.headers.get('Content-Length', '0'))
                    if not 0 < size <= 16384:
                        self.reply(413, 'Invalid body size'); return
                    report = json.loads(self.rfile.read(size))
                    if report.get('machineId') != cap['machineId'] or report.get('os') != cap['os'] or report.get('state') != 'installed':
                        raise ValueError('report')
                    if report.get('cleanupId') != cap.get('cleanupId'):
                        raise ValueError('recovery receipt')
                    if not re.fullmatch(r'(ssh-ed25519|ssh-rsa|ecdsa-sha2-[\w-]+) [A-Za-z0-9+/]+={0,2}', report.get('hostKey', '')):
                        raise ValueError('host key')
                    cap['report'] = report; self.save(path, cap)
                    self.reply(200, '{}', 'application/json')
                else:
                    self.reply(405, 'Method not allowed')
        except FileNotFoundError:
            self.reply(410, 'Install link expired or was revoked.')
        except (ValueError, KeyError, OSError):
            self.reply(400, 'Installer unavailable or invalid report.')

    @staticmethod
    def save(path, cap):
        temp = path.with_suffix('.new')
        with temp.open('x') as f:
            os.fchmod(f.fileno(), 0o600)
            f.write(json.dumps(cap)); f.flush(); os.fsync(f.fileno())
        temp.replace(path)
        directory = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    def do_GET(self):
        self.capability('GET')

    def do_POST(self):
        self.capability('POST')


if __name__ == '__main__':
    os.umask(0o077)
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not (ROOT.parent / 'lock').exists():
        (ROOT.parent / 'lock').touch(mode=0o600)
    server = ThreadingHTTPServer(('127.0.0.1', int(os.environ.get('DROVER_CAPABILITY_PORT', '8791'))), Handler)
    server.daemon_threads = True
    server.serve_forever()
