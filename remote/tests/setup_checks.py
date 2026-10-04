#!/usr/bin/env python3
"""Offline regressions. Temporary configs/keys only; never installs or connects."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SSHD = '/usr/sbin/sshd'


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs).stdout


class ReviewChecks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='drover-review-')
        self.d = Path(self.tmp.name)
        run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(self.d / 'host')])
        self.key = (self.d / 'host.pub').read_text().strip()

    def tearDown(self):
        self.tmp.cleanup()

    def config(self, nested=True):
        include = self.d / 'foreign.conf'
        # An untested address, hostname and LocalPort would previously override
        # the drop-in. Different key options and global directives must survive.
        include.write_text('Match User bridge-mac Address 192.0.2.84 Host evil.example LocalPort 4422\n'
                           ' GatewayPorts yes\n AllowTcpForwarding yes\n ClientAliveInterval 0\n'
                           'Match all\n')
        cfg = self.d / 'sshd_config'
        cfg.write_text(f'HostKey {self.d / "host"}\nPort 4422\nUsePAM no\n'
                       + (f'Include {include}\n' if nested else '')
                       + 'Match User bridge-pc\n GatewayPorts yes\nMatch all\n')
        return cfg, include

    def prepare(self, cfg, name="work"):
        work = self.d / name; work.mkdir()
        (work / 'policy').write_text(run(['bash', '-c', '. "$1"; render_dropin', 'bash', str(ROOT / 'bridge/vps-setup.sh')]))
        policy = self.d / 'drover-hub-policy.conf'
        old = self.d / '060-drover-hub.conf'
        candidate = run(['python3', str(ROOT / 'bridge/hub-config.py'), 'prepare', str(cfg), str(old), str(policy), str(work)]).strip()
        return work, candidate, policy

    def assert_policy(self, cfg):
        run([SSHD, '-t', '-f', str(cfg)])
        contexts = 'evil.example,192.0.2.84,192.0.2.1,4422\nother.example,192.0.2.99,192.0.2.1,4422'
        run(['bash', '-c', '. "$1"; HUB_CONTEXTS="$2"; verify_hub "$3"', 'bash', str(ROOT / 'bridge/vps-setup.sh'), contexts, str(cfg)])

    def test_context_without_reverse_dns_uses_address(self):
        out = run(['bash', '-c', '. "$1"; getent() { return 2; }; '
                   'SSH_CONNECTION="192.0.2.10 60058 203.0.113.5 22"; '
                   'load_contexts; printf "%s" "$HUB_CONTEXTS"',
                   'bash', str(ROOT / 'bridge/vps-setup.sh')])
        self.assertEqual(out.strip(), '192.0.2.10,192.0.2.10,203.0.113.5,22')

    def test_policy_precedes_nested_match_and_restore(self):
        cfg, include = self.config()
        original = cfg.read_bytes(), include.read_bytes()
        work, candidate, policy = self.prepare(cfg)
        self.assert_policy(candidate)
        self.assertEqual(original, (cfg.read_bytes(), include.read_bytes()))
        run(['python3', str(ROOT / 'bridge/hub-config.py'), 'commit', str(work)])
        self.assert_policy(cfg)
        self.assertEqual(cfg.read_bytes(), original[0])  # The Include remains live.
        self.assertIn('# drover-hub-policy (managed)', include.read_text())
        run(['python3', str(ROOT / 'bridge/hub-config.py'), 'restore', str(work)])
        self.assertEqual(original, (cfg.read_bytes(), include.read_bytes()))
        self.assertFalse(policy.exists())

    def test_policy_precedes_main_match(self):
        cfg, _ = self.config(False)
        _, candidate, _ = self.prepare(cfg)
        self.assert_policy(candidate)

    def test_first_install_without_match_and_reinstall(self):
        cfg = self.d / 'sshd_config'
        cfg.write_text(f'HostKey {self.d / "host"}\nPort 4422\nUsePAM no\n')
        work, candidate, policy = self.prepare(cfg)
        self.assert_policy(candidate)
        run(['python3', str(ROOT / 'bridge/hub-config.py'), 'commit', str(work)])
        before = cfg.read_text()
        # A second transaction updates the same Include instead of duplicating it.
        second = self.d / 'second'; second.mkdir(); (second / 'policy').write_text((work / 'policy').read_text())
        candidate = run(['python3', str(ROOT / 'bridge/hub-config.py'), 'prepare', str(cfg), str(self.d / '060-drover-hub.conf'), str(policy), str(second)]).strip()
        self.assert_policy(candidate)
        run(['python3', str(ROOT / 'bridge/hub-config.py'), 'commit', str(second)])
        self.assertEqual(cfg.read_text(), before)

    def test_key_comment_is_not_key_identity(self):
        run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(self.d / 'other')])
        other = (self.d / 'other.pub').read_text().strip()
        keys = self.d / 'user/.ssh'; keys.mkdir(parents=True)
        original = f'{other} comment includes {self.key}\nrestrict {self.key}\n# {self.key}\n\n'
        (keys / 'authorized_keys').write_text(original)
        script = '''. "$1"
getent() { printf 'agent:x:501:20:Drover hub:%s/user:/bin/bash\\n' "$TEST_DIR"; }
id() { if [ "$1" = -gn ]; then /usr/bin/id -gn; else /usr/bin/id "$@"; fi; }
chown() { :; }
install() { local args=(); while [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2;; *) args+=("$1"); shift;; esac; done; /usr/bin/install "${args[@]}"; }
set_authorized_key agent 'restrict,port-forwarding' "$2" test
'''
        run(['bash', '-c', script, 'bash', str(ROOT / 'bridge/lib.sh'), self.key], env={**os.environ, 'TEST_DIR': str(self.d)})
        result = (keys / 'authorized_keys').read_text()
        self.assertIn(f'{other} comment includes {self.key}\n', result)
        self.assertIn(f'# {self.key}\n\n', result)
        self.assertNotIn(f'\nrestrict {self.key}', result)
        self.assertIn(f'restrict,port-forwarding {self.key} test', result)
        invalid = self.d / 'invalid.pub'; invalid.write_text('ssh-ed25519 invalid\n')
        out = subprocess.run(['bash', '-c', '. "$1"; read_pubkey "$2"', 'bash', str(ROOT / 'bridge/lib.sh'), str(invalid)], capture_output=True)
        self.assertNotEqual(out.returncode, 0)

    def test_sshd_reload_failure_restores_config_and_keys(self):
        cfg, include = self.config()
        old = cfg.read_bytes(), include.read_bytes()
        home = self.d / 'user'; (home / '.ssh').mkdir(parents=True)
        keyfile = home / '.ssh/authorized_keys'; keyfile.write_text(f'restrict {self.key}\n')
        before = keyfile.read_bytes()
        script = r'''. "$1"
require_root() { :; }; require_debian_like() { :; }; ssh_listener_ports() { echo 4422; }
getent() { [ "$1" = passwd ] || return 2; printf '%s:x:501:20:Drover hub:%s/user:/usr/sbin/nologin\n' "$2" "$TEST_DIR"; }
id() { if [ "$1" = -gn ]; then /usr/bin/id -gn; else /usr/bin/id "$@"; fi; }
chown() { :; }
install() { local args=(); while [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2;; *) args+=("$1"); shift;; esac; done; /usr/bin/install "${args[@]}"; }
systemctl() { local n=0; [ ! -f "$TEST_DIR/reloads" ] || n=$(cat "$TEST_DIR/reloads"); n=$((n+1)); echo "$n" > "$TEST_DIR/reloads"; [ "$n" -gt 2 ]; }
main --mac-key "$TEST_DIR/host.pub" --yes --context evil.example,192.0.2.84,192.0.2.1,4422
'''
        env = {**os.environ, 'SSH_CONNECTION': '', 'TEST_DIR': str(self.d), 'SSHD_CONFIG': str(cfg), 'DROPIN_DIR': str(self.d / 'd'), 'POLICY_FILE': str(self.d / 'policy-live')}
        out = subprocess.run(['bash', '-c', script, 'bash', str(ROOT / 'bridge/vps-setup.sh')], text=True, capture_output=True, env=env)
        self.assertNotEqual(out.returncode, 0, out.stdout)
        self.assertIn('previous config/keys/accounts restored', out.stderr)
        self.assertEqual(old, (cfg.read_bytes(), include.read_bytes()))
        self.assertEqual(before, keyfile.read_bytes())
        self.assertFalse((self.d / 'policy-live').exists())

    def test_legacy_policy_disables_every_auth_and_forwarding(self):
        cfg, _ = self.config()
        work, _, _ = self.prepare(cfg)
        (work / 'policy').write_text(run(['bash', '-c', '. "$1"; RETIRE_LEGACY=1; render_dropin', 'bash', str(ROOT / 'bridge/vps-setup.sh')]))
        candidate = work / 'config-0'
        run([SSHD, '-t', '-f', str(candidate)])
        text = run([SSHD, '-T', '-f', str(candidate), '-C', 'user=bridge,host=evil.example,addr=192.0.2.84,laddr=192.0.2.1,lport=4422'])
        for line in ('denyusers bridge', 'pubkeyauthentication no', 'passwordauthentication no', 'kbdinteractiveauthentication no', 'disableforwarding yes', 'maxsessions 0'):
            self.assertIn(line + '\n', text)

    def test_account_preflight_rejects_foreign_users_before_any_config_change(self):
        cfg, include = self.config()
        before = cfg.read_bytes(), include.read_bytes()
        script = r'''. "$1"
require_root() { :; }; require_debian_like() { :; }; ssh_listener_ports() { echo 4422; }
getent() { printf '%s:x:501:20:Someone else:/tmp:/bin/bash\n' "$2"; }
main --mac-key "$TEST_DIR/host.pub" --yes --context evil.example,192.0.2.84,192.0.2.1,4422
'''
        env = {**os.environ, 'SSH_CONNECTION': '', 'TEST_DIR': str(self.d), 'SSHD_CONFIG': str(cfg), 'DROPIN_DIR': str(self.d / 'd'), 'POLICY_FILE': str(self.d / 'policy-live')}
        out = subprocess.run(['bash', '-c', script, 'bash', str(ROOT / 'bridge/vps-setup.sh')], text=True, capture_output=True, env=env)
        self.assertNotEqual(out.returncode, 0)
        self.assertIn('not script-owned', out.stderr)
        self.assertEqual(before, (cfg.read_bytes(), include.read_bytes()))
        self.assertFalse((self.d / 'policy-live').exists())

    def test_legacy_retirement_requires_new_tunnel_owner(self):
        script = """. \"$1\"; ss() { echo 'LISTEN 0 128 127.0.0.1:2222 0.0.0.0:* users:((\"sshd\",pid=1,fd=2))'; }; ps() { echo bridge; }; verify_new_tunnel"""
        out = subprocess.run(['bash', '-c', script, 'bash', str(ROOT / 'bridge/vps-setup.sh')], text=True, capture_output=True)
        self.assertNotEqual(out.returncode, 0)
        self.assertIn('cannot prove bridge-mac owns', out.stderr)

    def test_mac_failed_restoration_is_reported_truthfully(self):
        plist = self.d / 'bridge.plist'; plist.write_text('previous plist')
        (self.d / 'known').write_text('already pinned')
        script = r'''. "$1"
SSH_DIR="$TEST_DIR/ssh"; KEY_BRIDGE="$TEST_DIR/host"; PLIST="$TEST_DIR/bridge.plist"; KNOWN="$TEST_DIR/known"
mkdir() { case "$*" in *Library/LaunchAgents*) :;; *) command mkdir "$@";; esac; }
launchctl() { return 1; }
cmd_bridge
'''
        env = {**os.environ, 'TEST_DIR': str(self.d), 'VPS_HOST': '192.0.2.1'}
        out = subprocess.run(['bash', '-c', script, 'bash', str(ROOT / 'install.sh')], text=True, capture_output=True, env=env)
        self.assertNotEqual(out.returncode, 0)
        self.assertIn('LaunchAgent remains unloaded', out.stderr)
        self.assertEqual(plist.read_text(), 'previous plist')

    def test_user_host_deny_is_rejected_by_verify_hub(self):
        for i, pattern in enumerate(('bridge-mac@*', 'bridge-mac@evil.example', 'bridge-mac@192.0.2.0/24')):
            with self.subTest(pattern=pattern):
                cfg, _ = self.config()
                cfg.write_text(f'DenyUsers {pattern}\n' + cfg.read_text())
                _, candidate, _ = self.prepare(cfg, f'work-{i}')
                run([SSHD, '-t', '-f', candidate])
                out = subprocess.run(['bash', '-c', '. "$1"; HUB_CONTEXTS="evil.example,192.0.2.84,192.0.2.1,4422"; verify_hub "$2"', 'bash', str(ROOT / 'bridge/vps-setup.sh'), candidate], text=True, capture_output=True)
                self.assertNotEqual(out.returncode, 0)
                self.assertIn('DenyUsers', out.stdout)
                self.assertIn('unsupported USER@HOST', out.stdout)

    def test_user_host_allow_is_rejected_even_with_plain_wildcard(self):
        cfg, _ = self.config()
        cfg.write_text('AllowUsers * bridge-mac@192.0.2.0/24\n' + cfg.read_text())
        _, candidate, _ = self.prepare(cfg)
        run([SSHD, '-t', '-f', candidate])
        out = subprocess.run(['bash', '-c', '. "$1"; HUB_CONTEXTS="evil.example,192.0.2.84,192.0.2.1,4422"; verify_hub "$2"', 'bash', str(ROOT / 'bridge/vps-setup.sh'), candidate], text=True, capture_output=True)
        self.assertNotEqual(out.returncode, 0)
        self.assertIn('AllowUsers', out.stdout)
        self.assertIn('unsupported USER@HOST', out.stdout)

    def test_symlink_configuration_rejected(self):
        cfg, include = self.config()
        (self.d / 'real.conf').write_text(include.read_text()); include.unlink(); include.symlink_to(self.d / 'real.conf')
        with self.assertRaises(subprocess.CalledProcessError):
            self.prepare(cfg)


if __name__ == '__main__':
    unittest.main(verbosity=2)
