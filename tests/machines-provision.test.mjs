import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'

const dir = mkdtempSync(join(tmpdir(), 'drover-provision-test-'))
await build({ entryPoints: ['src/main/machines/provision.ts'], outfile: join(dir, 'provision.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', plugins: [{ name: 'raw-assets', setup(b) {
  b.onResolve({ filter: /\?raw$/ }, args => ({ path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'raw' }))
  b.onLoad({ filter: /.*/, namespace: 'raw' }, args => ({ contents: `export default ${JSON.stringify(readFileSync(args.path, 'utf8'))}`, loader: 'js' }))
} }] })
const require = createRequire(import.meta.url)
const m = require(join(dir, 'provision.cjs'))
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'key')])
const key = readFileSync(join(dir, 'key.pub'), 'utf8').split(/\s+/).slice(0, 2).join(' ')
const tunnelKey = readFileSync(join(dir, 'key'), 'utf8')
rmSync(dir, { recursive: true })
const bridge = { id: 'bridge-fixture', name: 'bridge', alias: 'bridge', kind: 'direct', host: '192.0.2.20', port: 2222, user: 'root', publicIp: true, permissions: { mode: 'full', projects: [] }, status: { state: 'online' } }
const machine = { id: 'target-fixture', name: 'target', alias: 'target', kind: 'bridged', user: 'agent', publicIp: false, os: 'linux', bridgePort: 24567, permissions: { mode: 'full', projects: [] }, status: { state: 'waiting' } }
const context = () => ({ machine, bridge, agentsPublicKey: key, managementPublicKey: key, bridgeHostKey: key, tunnelPrivateKey: tunnelKey, tunnelPublicKey: key, expiresAt: Date.now() + 7200000 })
function decode(script) {
  const data = script.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/)
  const bundle = script.match(/base64\.b64decode\('([A-Za-z0-9+/=]+)'\)/)
  return { data: JSON.parse(Buffer.from(data[1], 'base64')), assets: JSON.parse(gunzipSync(Buffer.from(bundle[1], 'base64'))) }
}

test('generated legacy bridge policy cleans dead Mac tunnels in 30 seconds while retaining other users', () => {
  // Source only: main is guarded and no VPS/sshd/service command is run.
  const policy = execFileSync('bash', ['-c', 'source remote/bridge/vps-setup.sh; render_dropin'], { encoding: 'utf8' })
  const blocks = policy.split('\nMatch User ')
  const mac = blocks.find(block => block.startsWith('bridge-mac\n'))
  assert.match(mac, /ClientAliveInterval 15\n/); assert.match(mac, /ClientAliveCountMax 2\n/)
  for (const user of ['bridge-pc', 'bridge-home', 'jump']) {
    const block = blocks.find(block => block.startsWith(user + '\n'))
    assert.match(block, /ClientAliveInterval 30\n/); assert.match(block, /ClientAliveCountMax 3\n/)
  }
  const validate = execFileSync('bash', ['-c', `
source remote/bridge/vps-setup.sh
HUB_CONTEXTS='fixture,192.0.2.20,192.0.2.30,22'
sshd_T() {
  render_dropin | awk -v user="$2" '
    /^Match User / { selected = ($3 == user); next }
    /^Match all/ { selected = 0 }
    selected && NF { key = tolower($1); $1 = ""; sub(/^ +/, ""); print key " " $0 }
  '
}
verify_hub /synthetic-config || exit 1
VERIFY_FAIL=0
# A stale 30/3 Mac policy must still be rejected.
sshd_T() {
  render_dropin | awk -v user="$2" '
    /^Match User / { selected = ($3 == user); next }
    /^Match all/ { selected = 0 }
    selected && NF { key = tolower($1); $1 = ""; sub(/^ +/, ""); if(user == "bridge-mac" && key == "clientaliveinterval") $0 = "30"; print key " " $0 }
  '
}
if verify_hub /synthetic-config; then exit 2; fi
printf 'validator passed and rejected stale policy'
`], { encoding: 'utf8' })
  assert.match(validate, /validator passed and rejected stale policy/)
})

test('bridge setup is self-contained, awaits progress and assigns only dedicated dynamic accounts', async () => {
  const calls = [], steps = []
  const p = m.createMachineProvisioner({ run: async (...args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' } } })
  await p.setupBridge(bridge, [{ machine, tunnelPublicKey: key }], key, { caddy: false }, async step => { await Promise.resolve(); steps.push(step) })
  assert.deepEqual(steps, ['bridge-policy', 'bridge-ready'])
  assert.equal(calls[0][1], '/bin/bash -s')
  const { data, assets } = decode(calls[0][2])
  assert.equal(data.targets[0].port, 24567)
  assert.equal(data.targets[0].user, m.bridgeTunnelUser(machine))
  assert.match(data.targets[0].user, /^dt-[a-f0-9]{16}$/)
  assert.ok(assets['machines/bridge.sh'].includes('MaxSessions') || assets['machines/bridge-data.py'].includes('MaxSessions 0'))
  assert.ok(assets['bridge/hub-config.py'])
  assert.ok(!JSON.stringify(data).includes('PRIVATE KEY'))
  await assert.rejects(p.setupBridge(bridge, [{ machine, tunnelPublicKey: key }, { machine: { ...machine, id: 'another' }, tunnelPublicKey: key }], key, { caddy: false }), { code: 'duplicate_port' })
  await p.setupBridge({ ...bridge, user: 'admin' }, [], key, { caddy: false })
  assert.equal(calls[1][1], 'sudo -n /bin/bash -s')
  await p.dispose()
})

test('Unix installer fallback replaces only supplied identities and retains foreign same-comment keys exactly', t => {
  const scratch = mkdtempSync(join(tmpdir(), 'drover-installer-keys-')); t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const work = join(scratch, 'work'), auth = join(scratch, 'authorized_keys'), result = join(scratch, 'result')
  mkdirSync(work)
  const algorithm = Buffer.from('ssh-ed25519'), length = Buffer.alloc(4); length.writeUInt32BE(algorithm.length)
  const other = seed => 'ssh-ed25519 ' + Buffer.concat([length, algorithm, Buffer.from([0,0,0,32]), Buffer.alloc(32, seed)]).toString('base64')
  const foreign = Buffer.from(`  ${other(3)} drover-management\r\nrestrict,command="printf foreign key" ${other(4)} drover-agents\n# ${key} drover-agents\n${other(5)} comment mentions ${key} drover-management\n`)
  writeFileSync(auth, Buffer.concat([foreign, Buffer.from(`restrict,command="printf old owned" ${key} drover-agents\n`)]))
  writeFileSync(join(work, 'agents.pub'), key + '\n'); writeFileSync(join(work, 'management.pub'), key + '\n'); writeFileSync(join(work, 'authorized_key'), key + ' drover-agents\n')
  const script = readFileSync('remote/machines/install-unix.sh', 'utf8').match(/<<'DROVER_INSTALL_KEYS'\n([\s\S]*?)\nDROVER_INSTALL_KEYS/)[1]
  execFileSync('python3', ['-c', script, work, auth, result])
  assert.deepEqual(readFileSync(result), Buffer.concat([foreign, Buffer.from(`${key} drover-agents\n${key} drover-management\n`)]))
})

test('no generated clipboard command contains key material; only the single-use download holds the tunnel key', async () => {
  const calls = []
  const p = m.createMachineProvisioner({ run: async (...args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' } } })
  for (const os of ['linux', 'macos', 'windows']) {
    const command = await p.installCommand(context(), os)
    const { data } = decode(calls.at(-1)[2])
    assert.equal(data.action, 'capability')
    assert.match(data.token, /^[A-Za-z0-9_-]{43}$/)
    assert.notEqual(data.token, data.credentials.receipt)
    assert.equal(data.credentials.managementPublicKey, key)
    assert.equal(data.credentials.bridge.port, machine.bridgePort)
    assert.equal(data.credentials.bridge.sshPort, 2222)
    assert.equal(data.credentials.bridge.tunnelPrivateKey, tunnelKey)
    for (const secret of [tunnelKey, Buffer.from(tunnelKey).toString('base64'), tunnelKey.split('\n')[1], key]) assert.ok(!command.includes(secret))
    assert.doesNotMatch(command, /DROVER_TUNNEL_KEY|PRIVATE KEY/)
    assert.ok(!data.script.includes(tunnelKey))
    assert.doesNotMatch(data.script, /DROVER_TUNNEL_KEY/)
    assert.ok(!data.script.includes('__DROVER_KEY_URL__'))
    assert.ok(data.script.includes(`/machines/install/${data.token}/key`))
    assert.ok(data.expiresAt <= Date.now() + 7200000)
    assert.ok(data.expiresAt > Date.now() + 7190000)
  }
  await assert.rejects(p.installCommand({ ...context(), machine: { ...machine, permissions: { mode: 'read-only', projects: [] } } }, 'macos'), { code: 'permission_unavailable' })
  await assert.rejects(p.installCommand({ ...context(), tunnelPrivateKey: undefined }, 'linux'), { code: 'missing_credentials' })
  await p.dispose()
})

test('LAN-only server consumes key once, accepts authenticated report, and dispose closes it', async () => {
  let report
  const p = m.createMachineProvisioner({ run: async () => { throw Error('Must not use SSH for LAN fallback') } })
  const command = await p.installCommand({ ...context(), bridge: null, lanHost: '127.0.0.1', onReport: r => { report = r } }, 'linux')
  const url = command.match(/'(http:\/\/[^']+)\/script'/)[1]
  assert.equal((await fetch(url + '/script')).status, 200)
  const replies = await Promise.all(Array.from({ length: 8 }, () => fetch(url + '/key')))
  assert.equal(replies.filter(r => r.status === 200).length, 1)
  assert.equal(replies.filter(r => r.status === 410).length, 7)
  const credentials = await replies.find(r => r.status === 200).json()
  assert.equal((await fetch(url + '/script')).status, 410)
  const body = JSON.stringify({ machineId: machine.id, os: 'linux', state: 'installed', hostKey: key, lanHost: '192.0.2.123' })
  assert.equal((await fetch(url + '/report', { method: 'POST', body })).status, 403)
  assert.equal((await fetch(url + '/report', { method: 'POST', body, headers: { Authorization: 'Bearer ' + credentials.receipt, 'X-Forwarded-For': '10.2.3.4' } })).status, 200)
  assert.equal(report.hostKey, key)
  assert.equal(report.lanHost, '127.0.0.1')
  await p.dispose()
  await assert.rejects(fetch(url + '/script'))
})

test('recovery credentials are normalized and LAN reports require the capability-bound cleanup ID', async t => {
  const reports = []
  const p = m.createMachineProvisioner({ run: async () => { throw Error('LAN recovery must not use old SSH') } })
  t.after(() => p.dispose())
  const recoveryCleanup = { id: 'recovery-fixture', agentsPublicKeys: [key + ' old-agents', key], managementPublicKey: key + ' old-management' }
  const command = await p.installCommand({ ...context(), bridge: null, lanHost: '127.0.0.1', recoveryCleanup, onReport: report => reports.push(report) }, 'linux')
  const url = command.match(/'(http:\/\/[^']+)\/script'/)[1]
  const script = await (await fetch(url + '/script')).text()
  assert.ok(!script.includes('__DROVER_RECOVERY_UNIX__'))
  const credentials = await (await fetch(url + '/key')).json()
  assert.deepEqual(credentials.recoveryCleanup, { id: recoveryCleanup.id, agentsPublicKeys: [key], managementPublicKey: key })
  const report = { machineId: machine.id, os: 'linux', state: 'installed', hostKey: key }
  const post = cleanupId => fetch(url + '/report', { method: 'POST', body: JSON.stringify({ ...report, ...(cleanupId ? { cleanupId } : {}) }), headers: { Authorization: 'Bearer ' + credentials.receipt } })
  assert.equal((await post()).status, 400)
  assert.equal((await post('wrong-recovery')).status, 400)
  assert.equal(reports.length, 0)
  assert.equal((await post(recoveryCleanup.id)).status, 200)
  assert.equal(reports[0].cleanupId, recoveryCleanup.id)
  await assert.rejects(p.installCommand({ ...context(), recoveryCleanup: { ...recoveryCleanup, id: 'bad\nID' } }, 'linux'), { code: 'invalid_cleanup' })
  await assert.rejects(p.installCommand({ ...context(), recoveryCleanup: { ...recoveryCleanup, managementPublicKey: 'not a key' } }, 'linux'), { code: 'invalid_key' })
})

test('bridge report forwards only the bound recovery ID, omits supplied LAN address and preserves host key', async t => {
  let receive
  let timeout
  const received = new Promise((resolve, reject) => { receive = resolve; timeout = setTimeout(() => reject(Error('Bridge report poll timed out')), 15_000) })
  t.after(() => clearTimeout(timeout))
  let polls = 0
  const recoveryCleanup = { id: 'recovery-fixture', agentsPublicKeys: [key], managementPublicKey: key }
  const p = m.createMachineProvisioner({ run: async (_machine, _command, script) => ({ code: 0, stderr: '', stdout: decode(script).data.action === 'report' ? 'DROVER_REPORT ' + JSON.stringify({ machineId: machine.id, os: 'linux', state: 'installed', hostKey: key, lanHost: '10.2.3.4', cleanupId: ++polls === 1 ? 'wrong-recovery' : recoveryCleanup.id }) : '' }) })
  t.after(() => p.dispose())
  await p.installCommand({ ...context(), recoveryCleanup, onReport: receive }, 'linux')
  const report = await received
  assert.equal(report.hostKey, key)
  assert.equal(report.cleanupId, recoveryCleanup.id)
  assert.equal(Object.hasOwn(report, 'lanHost'), false)
})

test('switch keeps successful repoints when old cleanup fails and retirement never recreates users', async () => {
  const calls = [], next = { ...bridge, id: 'new-bridge' }
  const p = m.createMachineProvisioner({ run: async (...args) => {
    calls.push(args)
    if (args[0].id === bridge.id) return { code: 255, stdout: '', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  } })
  const result = await p.switchBridge(bridge, next, [{ machine, tunnelPublicKey: key }, { machine: { ...machine, id: 'windows', os: 'windows', bridgePort: 24568 }, tunnelPublicKey: key }], key, { caddy: false, bridgeHostKey: key })
  assert.deepEqual(result, { updated: [machine.id], needsReinstall: ['windows'], pendingOldCleanup: [bridge.id] })
  await p.retireBridge(next)
  assert.equal(decode(calls.at(-1)[2]).data.action, 'retire')
  await p.dispose()
})

test('Linux installer dependency bootstrap works as root without sudo and tolerates broken apt indexes', () => {
 const source=readFileSync('remote/machines/install-unix.sh','utf8')
 const bootstrap=source.slice(source.indexOf('if [ "$OS" = linux ]; then'),source.indexOf('work=$(mktemp -d)'))
 const run=(present)=>execFileSync('/bin/bash',['-c',`set -euo pipefail
 OS=linux
 command() { if [ "$1" = -v ]; then case "$2" in ${present.map(x=>x).join('|')}) return 0;; *) return 1;; esac; else builtin command "$@"; fi; }
 apt-get() { printf 'APT %s\\n' "$*"; [ "$1" != update ]; }
 ${bootstrap}
 echo BOOTSTRAP_READY`],{encoding:'utf8'})
 assert.equal(run(['systemctl','python3','ssh','sshd','visudo','curl']), 'BOOTSTRAP_READY\n')
 const output=run(['systemctl','ssh','sshd','visudo','curl','apt-get'])
 assert.match(output,/APT update -qq/);assert.match(output,/APT install -y python3\nBOOTSTRAP_READY/)
 assert.doesNotMatch(output,/install -y.*sudo/)
})

test('Unix capability command executes bash directly as root and sudo only as a non-root caller',async t=>{
 const p=m.createMachineProvisioner({run:async()=>({code:0,stdout:'',stderr:''})});t.after(()=>p.dispose())
 const command=await p.installCommand(context(),'linux')
 const tail=command.slice(command.indexOf(' | ')+3)
 for(const uid of ['0','1000']){
  const output=execFileSync('/bin/bash',['-c',`id() { echo ${uid}; }; /bin/true; sudo() { echo SUDO; cat >/dev/null; }; ${tail.replace('/bin/bash;','echo ROOT; cat >/dev/null;')}`],{input:'synthetic',encoding:'utf8'})
  assert.equal(output,uid==='0'?'ROOT\n':'SUDO\n')
 }
})
