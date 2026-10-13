import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const dir = mkdtempSync(join(tmpdir(), 'drover-session-bundle-'))
await build({ entryPoints: ['src/main/machines/sessions.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: join(dir, 'sessions.cjs'), logLevel: 'silent' })
const { UNIX_SESSION_CLEANUP, sessionCleanupScript } = createRequire(import.meta.url)(join(dir, 'sessions.cjs'))
rmSync(dir, { recursive: true, force: true })

test('session cleanup fails closed for an unmarked supplied account without sending signals', () => {
  const input = `import pwd,os,types
pwd.getpwnam=lambda name:types.SimpleNamespace(pw_uid=123,pw_gecos='Personal account')
os.kill=lambda *args:(_ for _ in ()).throw(AssertionError('Must not kill supplied account'))
${UNIX_SESSION_CLEANUP}`
  const result = execFileSync('python3', ['-'], { input, encoding: 'utf8' })
  assert.deepEqual(JSON.parse(result.trim().slice(16)), { terminated: 0, incomplete: true })
  assert.match(sessionCleanupScript('windows'), /Description -ne 'Drover managed agent'/)
})

test('Linux dedicated cleanup ends an actual session tree and preserves management ancestry/tunnel', { skip: process.env.DROVER_MACHINE_SESSION_TEST !== '1' }, () => {
  const driver = `import json,os,pathlib,pwd,subprocess,time
subprocess.run(['useradd','-m','-c','Drover managed agent','agent'],check=True)
pathlib.Path('/etc/sudoers.d/session-test').write_text('agent ALL=(ALL) NOPASSWD: ALL\\n')
pathlib.Path('/etc/sudoers.d/session-test').chmod(0o440)
pathlib.Path('/tmp/cleanup.py').write_text(${JSON.stringify(UNIX_SESSION_CLEANUP)})
tunnel=subprocess.Popen(['sleep','60'])
session=subprocess.Popen(['sudo','-u','agent','bash','-c','sudo -n sleep 60 & echo $! > /tmp/root-child; exec -a "sshd: agent@notty" sleep 60'])
for _ in range(100):
 if pathlib.Path('/tmp/root-child').exists(): break
 time.sleep(.01)
time.sleep(.1)
root_child=int(pathlib.Path('/tmp/root-child').read_text())
out=subprocess.check_output(['sudo','-u','agent','sudo','-n','python3','/tmp/cleanup.py'],text=True)
report=json.loads(out.strip().split('DROVER_SESSIONS ')[-1])
assert report==dict(terminated=1,incomplete=False),report
assert tunnel.poll() is None,'root tunnel was killed'
session.wait(timeout=3)
assert session.returncode != 0,'session survived'
def running(pid):
 try: return pathlib.Path('/proc/'+str(pid)+'/stat').read_text().split(') ')[1][0]!='Z'
 except FileNotFoundError: return False
assert not running(root_child),'elevated session descendant survived'
tunnel.terminate();tunnel.wait()
print('dedicated session tree ended; management/tunnel preserved')
`
  const output = execFileSync('docker', ['run', '--rm', '-i', '--network', 'none', '--entrypoint', 'python3', 'drover-machines-checks:local', '-'], { input: driver, encoding: 'utf8', timeout: 30_000 })
  assert.match(output, /dedicated session tree ended/)
})
