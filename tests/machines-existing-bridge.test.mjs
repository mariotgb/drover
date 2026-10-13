import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, createHmac } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'

const bundle = mkdtempSync(join(tmpdir(), 'drover-existing-bundle-'))
await build({ stdin: { contents: `export * from './src/main/machines/service'; export * from './src/main/machines/ssh'; export * from './src/main/machines/existing-bridge'; export * from './src/main/machines/provision';`, resolveDir: resolve('.'), loader: 'ts' }, outfile: join(bundle, 'test.cjs'), bundle: true, platform: 'node', format: 'cjs', alias: { '@shared': resolve('src/shared') }, loader: { '.sh': 'text', '.py': 'text', '.ps1': 'text' }, logLevel: 'silent' })
const m = createRequire(import.meta.url)(join(bundle, 'test.cjs'))
rmSync(bundle, { recursive: true, force: true })
const blob = seed => { const algorithm = Buffer.from('ssh-ed25519'), length = Buffer.alloc(4); length.writeUInt32BE(algorithm.length); return Buffer.concat([length, algorithm, Buffer.from([0,0,0,32]), Buffer.alloc(32, seed)]).toString('base64') }
const key = seed => `ssh-ed25519 ${blob(seed)}`
const host = '192.0.2.20', port = 2222, publicUrl = 'https://192-0-2-20.sslip.io'
const hostKey = `[${host}]:${port} ${key(7)}`
const ok = stdout => ({ code: 0, stdout, stderr: '' })
const report = () => ({ users: ['bridge-mac', 'jump'].map(name => ({ name, exists: true, permitListen: name === 'jump' ? ['none'] : ['127.0.0.1:2222', '127.0.0.1:8780'], authorizedKeyOptions: true })), jumpUser: 'jump', policy: true, firewall: true, caddy: { configured: true, active: true }, listeners: [2222, 8780], missing: [] })
function fixture(t, { existing = true, overrideRun, provisioner } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'drover-existing-test-')), home = join(dir, 'home'), userData = join(dir, 'profile'), calls = [], progress = []
  mkdirSync(home); mkdirSync(userData); mkdirSync(join(home, '.ssh'))
  const adminPath = join(home, '.ssh/admin_ed25519'), tunnelPath = join(home, '.ssh/mac_bridge_ed25519'), pins = join(home, '.ssh/mac_bridge_known_hosts')
  const args = ['/usr/bin/ssh', '-F', '/dev/null', '-N', '-R', '127.0.0.1:2222:localhost:22', '-R', '127.0.0.1:8780:127.0.0.1:7780', '-p', String(port), '-i', tunnelPath, '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + pins, 'bridge-mac@' + host]
  const plist = join(home, 'Library/LaunchAgents/dev.drover.bridge.plist')
  if (existing) {
    mkdirSync(join(home, 'Library/LaunchAgents'), { recursive: true }); writeFileSync(plist, '<plist fixture/>')
    writeFileSync(join(userData, 'settings.json'), JSON.stringify({ remotePublicUrl: publicUrl }))
    writeFileSync(join(userData, 'bridge-admin.json'), JSON.stringify({ host, port, user: 'root', keyPath: adminPath }))
    writeFileSync(adminPath, 'DO NOT READ ADMIN SECRET', { mode: 0o600 }); writeFileSync(tunnelPath, 'DO NOT READ TUNNEL SECRET', { mode: 0o600 }); writeFileSync(pins, hostKey + '\n')
  }
  let scan = hostKey, running = true, verification = report(), sshFail = false, generated = 20
  const run = async (file, argv, options = {}) => {
    calls.push({ file, args: [...argv], input: options.input, env: options.env })
    const override = await overrideRun?.(file, argv, options); if (override) return override
    if (file === 'plutil') return ok(JSON.stringify({ Label: 'dev.drover.bridge', ProgramArguments: args }))
    if (file === 'launchctl') return running ? ok('state = running\npid = 123\n') : { code: 113, stdout: '', stderr: '' }
    if (file === 'ssh-keyscan') return ok(scan)
    if (file === 'ssh-keygen') { const path = argv[argv.indexOf('-f') + 1]; writeFileSync(path, '-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE\n-----END OPENSSH PRIVATE KEY-----\n', { mode: 0o600 }); writeFileSync(path + '.pub', key(generated++)); return ok('') }
    if (file === 'python3') return ok('DROVER_MAC_BRIDGE_REPORT ' + JSON.stringify({ tunnelRunning: true, plistPath: plist, missing: [] }))
    if (file === 'ssh') {
      if (sshFail) return { code: 255, stdout: '', stderr: 'Permission denied (publickey) DO NOT PRINT SECRET' }
      if (options.input?.includes('manifest.json')) {
        const data = JSON.parse(Buffer.from(options.input.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/)[1], 'base64'))
        if (data.action === 'repair') {
          const users = ['bridge-mac', 'jump', 'drover-jump', ...data.targets.map(t => t.user)]
          verification = { ...verification, caddy: { ...verification.caddy, active: true, installerRoute: true }, users: users.map(name => ({ name, exists: true, permitListen: name.startsWith('dt-') ? ['127.0.0.1:' + data.targets.find(t => t.user === name).port] : name === 'bridge-mac' ? ['127.0.0.1:2222', '127.0.0.1:8780'] : ['none'], authorizedKeyOptions: true })) }
          return ok('DROVER_BRIDGE_READY\nDROVER_BRIDGE_REPORT ' + JSON.stringify(verification))
        }
        if (data.action === 'capability') return ok('')
        return ok('DROVER_BRIDGE_REPORT ' + JSON.stringify(verification))
      }
      return ok(argv.at(-1).startsWith('sh -c') ? 'os=Linux\nlabel=Debian 12\n' : '')
    }
    throw Error('Unexpected real command: ' + file)
  }
  const service = new m.MachinesService({ home, userData, run, tcp: async () => 1, periodMs: 3_600_000, bridgeProgress: p => progress.push(p), ...(provisioner ? { provisioner } : {}) })
  t.after(() => { service.dispose(); rmSync(dir, { recursive: true, force: true }) })
  return { home, userData, adminPath, pins, plist, args, calls, service, progress, set running(v) { running = v }, set scan(v) { scan = v }, set verification(v) { verification = v }, set sshFail(v) { sshFail = v } }
}

test('local detection reads plist/settings/pins only, resolves hashed pins, and never creates managed keys or contacts SSH', async t => {
  const f = fixture(t)
  const salt = Buffer.alloc(20, 3), name = `[${host}]:${port}`, digest = createHmac('sha1', salt).update(name).digest('base64')
  writeFileSync(f.pins, `|1|${salt.toString('base64')}|${digest} ${key(7)}\n`)
  const found = await f.service.detectExistingBridge()
  assert.equal(found.host, host); assert.equal(found.port, port); assert.equal(found.publicUrl, publicUrl)
  assert.equal(found.tunnelRunning, true); assert.equal(found.adminKeyPath, f.adminPath); assert.equal(found.hostKey.fingerprint, m.fingerprint(hostKey))
  assert.deepEqual(found.users, ['bridge-mac', 'jump'])
  assert.ok(f.calls.every(c => ['plutil', 'launchctl'].includes(c.file)))
  assert.equal(existsSync(join(f.home, '.drover')), false)
  assert.doesNotMatch(JSON.stringify(found), /DO NOT READ|PRIVATE|ProgramArguments/)
  f.running = false; assert.equal((await f.service.detectExistingBridge()).macTunnel, 'stopped')
})

test('phone settings alone discover sslip host without an SSH scan; unsafe forwards and mismatched URL fail closed', async t => {
  const f = fixture(t, { existing: false })
  writeFileSync(join(f.userData, 'settings.json'), JSON.stringify({ remotePublicUrl: publicUrl }))
  const found = await f.service.detectExistingBridge()
  assert.equal(found.host, host); assert.equal(found.macTunnel, 'missing'); assert.equal(found.adminKey, false); assert.equal(f.calls.length, 0)
  assert.throws(() => m.parseBridgeArguments(['/usr/bin/ssh', '-R', '0.0.0.0:8780:localhost:7780', 'bridge-mac@' + host], f.home), /loopback/)
  const g = fixture(t); writeFileSync(join(g.userData, 'settings.json'), JSON.stringify({ remotePublicUrl: 'https://192-0-2-21.sslip.io' }))
  await assert.rejects(g.service.detectExistingBridge(), { code: 'bridge_state_conflict' })
})

test('adoption refuses unconfirmed or changed host key before authentication and reports sanitized errors', async t => {
  const f = fixture(t)
  let r = await f.service.adoptExistingBridge()
  assert.equal(r.steps[0].error.code, 'host_key_unconfirmed'); assert.equal(f.calls.some(c => c.file === 'ssh'), false)
  f.scan = `[${host}]:${port} ${key(8)}`
  r = await f.service.adoptExistingBridge({ acceptedFingerprint: m.fingerprint(hostKey) })
  assert.equal(r.steps[0].error.code, 'host_key_changed'); assert.equal(f.calls.some(c => c.file === 'ssh'), false)
  f.scan = hostKey; f.sshFail = true
  r = await f.service.adoptExistingBridge({ acceptedFingerprint: m.fingerprint(hostKey) })
  assert.equal(r.steps[0].state, 'failed'); assert.doesNotMatch(JSON.stringify(r), /DO NOT PRINT SECRET/)
  assert.equal((await f.service.state()).bridgeMachineId, null)
})

test('adoption verifies only, maps phone/Mac bridge, survives restart and forgets locally without credential retirement', async t => {
  const f = fixture(t), originalPlist = readFileSync(f.plist, 'utf8')
  const r = await f.service.adoptExistingBridge({ acceptedFingerprint: m.fingerprint(hostKey) })
  assert.ok(r.machineId); assert.ok(r.steps.every(s => s.state === 'done'))
  const state = await f.service.state(); assert.equal(state.bridgeMachineId, r.machineId)
  const bridge = state.machines.find(x => x.id === r.machineId)
  assert.equal(bridge.bridgeSetup.state, 'ready'); assert.equal(bridge.bridgeConnection.publicUrl, publicUrl)
  assert.equal(readFileSync(f.plist, 'utf8'), originalPlist)
  const ssh = f.calls.filter(c => c.file === 'ssh'); assert.equal(ssh.length, 1)
  assert.equal(ssh[0].args[1], join(f.home, '.drover/machines/ssh_control_config'))
  const manifest = JSON.parse(Buffer.from(ssh[0].input.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/)[1], 'base64'))
  assert.equal(manifest.action, 'verify')
  assert.doesNotMatch(readFileSync(f.service.configPath, 'utf8'), /Host drover-bridge\n|User root|User jump|admin_ed25519|management_ed25519/)
  assert.doesNotMatch(readFileSync(join(f.home, '.drover/machines/MACHINES.md'), 'utf8'), /alias `drover-bridge`/)
  assert.match(readFileSync(join(f.home, '.drover/machines/ssh_control_config'), 'utf8'), /admin_ed25519/)
  assert.doesNotMatch(JSON.stringify(state), /adminKeyPath|DO NOT READ/)
  const restarted = new m.MachinesService({ home: f.home, userData: f.userData, run: async () => { throw Error('No startup SSH') }, tcp: async () => 1 }); t.after(() => restarted.dispose())
  assert.equal((await restarted.state()).bridgeMachineId, r.machineId)
  await assert.rejects(f.service.setupBridge(r.machineId, { caddy: true, confirmed: true }), { code: 'bridge_repair_required' })
  await assert.rejects(f.service.installKey(r.machineId, { acceptedFingerprint: m.fingerprint(hostKey) }), { code: 'bridge_repair_required' })
  await f.service.remove(r.machineId, { confirmed: true })
  assert.equal(f.calls.filter(c => c.file === 'ssh').length, 1); assert.equal(readFileSync(f.plist, 'utf8'), originalPlist)
})

test('adoption returns only missing repair steps and keeps the existing tunnel registration', async t => {
  const f = fixture(t); f.running = false
  f.verification = { ...report(), caddy: { configured: false, active: false }, missing: ['phone_route_missing'] }
  const r = await f.service.adoptExistingBridge({ acceptedFingerprint: m.fingerprint(hostKey) })
  assert.deepEqual(r.repairSteps.map(s => s.step), ['mac_tunnel', 'phone_site'])
  assert.equal((await f.service.state()).bridgeMachineId, r.machineId)
  assert.equal(f.calls.some(c => c.file === 'python3' || c.file === 'launchctl' && c.args[0] !== 'print'), false)
})

test('one-shot scratch bootstrap uses pinned password SSH once, emits progress and configures a local tunnel; password is not persisted', async t => {
  const f = fixture(t, { existing: false })
  const password = 'one-time-fixture-password'
  const r = await f.service.setupBridgeFromScratch({ host, port, user: 'root', password, acceptedFingerprint: m.fingerprint(hostKey), caddy: true })
  assert.ok(r.machineId); assert.ok(r.steps.every(s => s.state === 'done'), JSON.stringify(r))
  assert.equal((await f.service.state()).bridgeMachineId, r.machineId)
  assert.ok(f.progress.some(p => p.step === 'mac_tunnel' && p.state === 'running'))
  const bootstrap = f.calls.filter(c => c.args.includes('BatchMode=no')); assert.equal(bootstrap.length, 1)
  assert.ok(bootstrap[0].env.SSH_ASKPASS); assert.equal(existsSync(bootstrap[0].env.SSH_ASKPASS), false)
  assert.doesNotMatch(bootstrap[0].input, /drover-agents/)
  assert.doesNotMatch(readFileSync(f.service.configPath, 'utf8'), /admin_ed25519|management_ed25519|mac-phone-jump|Host drover-bridge\n/)
  const local = f.calls.find(c => c.file === 'python3'); assert.ok(local); assert.equal(existsSync(local.args[0]), false)
  assert.doesNotMatch(readFileSync(join(f.userData, 'machines.json'), 'utf8'), /one-time-fixture-password|PRIVATE KEY/)
  assert.doesNotMatch(JSON.stringify(f.calls), /one-time-fixture-password/)
  const setup = f.calls.find(c => c.input?.includes('--jump-mac-key'))
  const files = JSON.parse(gunzipSync(Buffer.from(setup.input.match(/base64\.b64decode\('([A-Za-z0-9+/=]+)'\)/)[1], 'base64')))
  assert.notEqual(files['jump.pub'], files['phone.pub']); assert.ok(files['bridge/vps-setup.sh'])
  assert.ok(!f.calls.some(c => c.input?.includes('ufw --force enable') || c.input?.includes('vps-firewall.sh')))
})

test('scratch refuses existing local bridge before scans/provisioning; phone-disabled setup skips its site', async t => {
  const f = fixture(t)
  const options = { host, port, user: 'root', password: 'temporary', acceptedFingerprint: m.fingerprint(hostKey), caddy: false }
  assert.equal((await f.service.setupBridgeFromScratch(options)).steps[0].error.code, 'bridge_state_conflict')
  assert.equal(f.calls.some(c => c.file === 'ssh' || c.file === 'ssh-keyscan'), false)
  const g = fixture(t, { existing: false }); g.verification = { ...report(), listeners: [2222], firewall: false, caddy: { configured: false, active: false } }
  const r = await g.service.setupBridgeFromScratch(options)
  assert.equal(r.steps.find(s => s.step === 'phone_site').state, 'skipped'); assert.equal(r.steps.find(s => s.step === 'firewall').state, 'skipped')
  assert.equal(r.steps.find(s => s.step === 'check').state, 'done')
})

test('remote bridge reports project only metadata and reject malformed or missing account results', () => {
  const output = 'DROVER_BRIDGE_REPORT ' + JSON.stringify({ ...report(), privateKey: 'sensitive', users: report().users.map(u => ({ ...u, key: 'sensitive' })) })
  assert.doesNotMatch(JSON.stringify(m.parseExistingBridgeReport(output)), /sensitive/)
  assert.throws(() => m.parseExistingBridgeReport('DROVER_BRIDGE_REPORT ' + JSON.stringify({ ...report(), users: [] })), /invalid verification/)
})

test('a partial scratch failure saves credential ownership, never selects an unverified bridge, and refuses blind reprovisioning', async t => {
  const f = fixture(t, { existing: false, overrideRun: (file, _args, options) => file === 'ssh' && options.input?.includes('--jump-mac-key') ? { code: 1, stdout: '', stderr: 'sensitive remote detail' } : undefined })
  const options = { host, port, user: 'root', password: 'temporary', acceptedFingerprint: m.fingerprint(hostKey), caddy: false }
  const r = await f.service.setupBridgeFromScratch(options)
  assert.equal(r.steps.find(s => s.step === 'users').state, 'failed')
  assert.doesNotMatch(JSON.stringify(r), /sensitive remote detail/)
  const state = await f.service.state(); assert.equal(state.bridgeMachineId, null)
  assert.equal(state.machines[0].bridgeSetup.state, 'failed'); assert.equal(state.machines[0].bridgeConnection.source, 'scratch')
  const calls = f.calls.filter(c => c.file === 'ssh').length
  assert.equal((await f.service.setupBridgeFromScratch(options)).steps[0].error.code, 'bridge_state_conflict')
  assert.equal(f.calls.filter(c => c.file === 'ssh').length, calls)
  await assert.rejects(f.service.setupBridge(r.machineId, { caddy: false, confirmed: true }), { code: 'bridge_repair_required' })
})

test('explicit repair adds home-machine grants on reserved-safe ports and installer generation uses additive repair without touching the phone plist', async t => {
  const f = fixture(t), plist = readFileSync(f.plist, 'utf8')
  const adopted = await f.service.adoptExistingBridge({ acceptedFingerprint: m.fingerprint(hostKey) })
  const unconfirmed = await f.service.repairExistingBridge({ machineId: adopted.machineId, acceptedFingerprint: m.fingerprint(hostKey) })
  assert.equal(unconfirmed.steps[0].error.code, 'bridge_repair_confirmation_required')
  const home = await f.service.add({ kind: 'bridged', name: 'home', os: 'linux' })
  assert.equal(home.bridgePort, 2225)
  const repaired = await f.service.repairExistingBridge({ machineId: adopted.machineId, acceptedFingerprint: m.fingerprint(hostKey), confirmed: true })
  assert.ok(repaired.steps.every(s => s.state === 'done'), JSON.stringify(repaired))
  const state = await f.service.state(), bridge = state.machines.find(x => x.id === adopted.machineId)
  assert.equal(bridge.bridgeConnection.source, 'existing'); assert.equal(bridge.bridgeConnection.managed, true)
  assert.match(readFileSync(f.service.configPath, 'utf8'), /User drover-jump/)
  const install = await f.service.installCommand(home.id, 'linux')
  assert.match(install.command, /machines\/install/)
  const manifests = f.calls.filter(c => c.input?.includes('manifest.json')).map(c => JSON.parse(Buffer.from(c.input.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/)[1], 'base64')))
  assert.deepEqual(manifests.filter(d => d.action === 'repair').map(d => d.targets.map(t => t.port)), [[2225], [2225]])
  assert.equal(manifests.some(d => d.action === 'setup'), false)
  assert.equal(readFileSync(f.plist, 'utf8'), plist)
  assert.ok(manifests.find(d => d.action === 'repair').origin === publicUrl)
})

test('repair accepts a one-use administrator password and stays unupgraded if Caddy rejects safe integration', async t => {
  const f = fixture(t, { overrideRun: (file, _args, options) => file === 'ssh' && options.input?.includes('manifest.json') && JSON.parse(Buffer.from(options.input.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/)[1], 'base64')).action === 'repair' ? { code: 1, stdout: 'DROVER_BRIDGE_ERROR {"code":"caddy_repair_requires_manual_integration","secret":"DO NOT PRINT"}', stderr: 'confidential config' } : undefined })
  const adopted = await f.service.adoptExistingBridge({ acceptedFingerprint: m.fingerprint(hostKey) })
  const password = 'repair-fixture-one-time'
  const r = await f.service.repairExistingBridge({ machineId: adopted.machineId, acceptedFingerprint: m.fingerprint(hostKey), password, confirmed: true })
  assert.equal(r.steps.find(s => s.step === 'users').error.code, 'caddy_repair_requires_manual_integration')
  assert.equal((await f.service.state()).machines[0].bridgeConnection.managed, undefined)
  assert.doesNotMatch(JSON.stringify(r), /DO NOT PRINT|confidential config/)
  assert.doesNotMatch(JSON.stringify(f.calls), /repair-fixture-one-time/)
  assert.equal(f.calls.filter(c => c.args.includes('BatchMode=no')).length, 1)
})

test('repaired bridge supports managed key rotation, switching and retirement while keeping the Mac phone tunnel untouched', async t => {
  const f = fixture(t), plist = readFileSync(f.plist, 'utf8')
  const adopted = await f.service.adoptExistingBridge({ acceptedFingerprint: m.fingerprint(hostKey) })
  await f.service.repairExistingBridge({ machineId: adopted.machineId, acceptedFingerprint: m.fingerprint(hostKey), confirmed: true })
  const home = await f.service.add({ kind: 'bridged', name: 'pc', os: 'windows' })
  await f.service.installCommand(home.id, 'windows')
  const before = (await f.service.state()).agentsKey.publicKey
  await f.service.revokeAgentsKey({ confirmed: true })
  let state = await f.service.state()
  assert.notEqual(state.agentsKey.publicKey, before)
  assert.equal(state.machines.find(x => x.id === adopted.machineId).needsReinstall, false)
  const next = await f.service.add({ kind: 'direct', name: 'next', host: '192.0.2.30', port, user: 'root' })
  await f.service.installKey(next.id, { password: 'fixture-once', acceptedFingerprint: m.fingerprint(hostKey) })
  await f.service.setupBridge(next.id, { caddy: false, confirmed: true }); await f.service.setBridge(next.id, { confirmed: true })
  state = await f.service.state(); assert.equal(state.bridgeMachineId, next.id)
  assert.equal(state.machines.find(x => x.id === adopted.machineId).bridgeConnection.publicUrl, publicUrl)
  await f.service.remove(adopted.machineId, { confirmed: true })
  assert.equal(readFileSync(f.plist, 'utf8'), plist)
  const data = f.calls.filter(c => c.input?.includes('manifest.json')).map(c => JSON.parse(Buffer.from(c.input.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/)[1], 'base64')))
  assert.ok(data.some(d => d.action === 'revoke-jump')); assert.ok(data.some(d => d.action === 'retire'))
  const retired = f.calls.filter(c => c.input?.includes('manifest.json') && JSON.parse(Buffer.from(c.input.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/)[1], 'base64')).action === 'retire')
  assert.equal(retired.length, 1)
  assert.equal(f.calls.some(c => c.file === 'launchctl' && c.args[0] !== 'print'), false)
})

test('Found bridge without an admin key connects with a one-time password after fingerprint confirmation and installs no tunnel policy', async t => {
  const f = fixture(t)
  rmSync(join(f.userData, 'bridge-admin.json')); rmSync(f.adminPath)
  assert.equal((await f.service.detectExistingBridge()).adminKey, false)
  const password = 'found-bridge-bootstrap-fixture'
  let r = await f.service.adoptExistingBridge({ user: 'root', password, acceptedFingerprint: m.fingerprint(`[${host}]:${port} ${key(8)}`) })
  assert.equal(r.steps[0].error.code, 'host_key_changed'); assert.equal(f.calls.some(c => c.file === 'ssh'), false)
  r = await f.service.adoptExistingBridge({ user: 'root', password, acceptedFingerprint: m.fingerprint(hostKey) })
  assert.ok(r.steps.every(s => s.state === 'done'), JSON.stringify(r))
  const state = await f.service.state(); assert.equal(state.bridgeMachineId, r.machineId)
  assert.equal(state.machines[0].bridgeConnection.managed, undefined)
  const found = await f.service.detectExistingBridge(); assert.equal(found.adminKey, true)
  const bootstrap = f.calls.filter(c => c.args.includes('BatchMode=no')); assert.equal(bootstrap.length, 1)
  assert.doesNotMatch(bootstrap[0].input, /drover-agents/)
  assert.equal(existsSync(bootstrap[0].env.SSH_ASKPASS), false)
  assert.doesNotMatch(JSON.stringify(f.calls), /found-bridge-bootstrap-fixture/)
  assert.doesNotMatch(readFileSync(join(f.userData, 'machines.json'), 'utf8'), /found-bridge-bootstrap-fixture/)
  const manifests = f.calls.filter(c => c.input?.includes('manifest.json')).map(c => JSON.parse(Buffer.from(c.input.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/)[1], 'base64')))
  assert.deepEqual(manifests.map(d => d.action), ['verify'])
  await f.service.remove(r.machineId, { confirmed: true })
  assert.ok(f.calls.some(c => c.input?.includes('awk -v agent')))
  assert.equal(readFileSync(f.plist, 'utf8'), '<plist fixture/>')
})

test('bridge bootstrap and repair expose no admin alias; agents revoke removes ordinary access while preserving foreign same-comment keys', async t => {
  const remote = mkdtempSync(join(tmpdir(), 'drover-admin-only-test-'))
  t.after(() => rmSync(remote, { recursive: true, force: true }))
  const bridgeHome = join(remote, 'bridge'), ordinaryHome = join(remote, 'ordinary')
  const foreign = `  ${key(3)} drover-management\r\nrestrict,command="printf foreign key" ${key(4)} drover-agents\n`
  for (const home of [bridgeHome, ordinaryHome]) { mkdirSync(join(home, '.ssh'), { recursive: true }); writeFileSync(join(home, '.ssh/authorized_keys'), foreign) }
  const f = fixture(t, { overrideRun: (file, args, options) => {
    if (file !== 'ssh' || !options.input?.includes('auth="$HOME/.ssh/authorized_keys"')) return
    const config = readFileSync(args[args.indexOf('-F') + 1], 'utf8'), alias = args.at(-2)
    const block = config.split(/(?=^Host )/m).find(block => block.startsWith(`Host ${alias}\n`))
    assert.ok(block, `Missing SSH alias ${alias}`)
    const home = block.includes(`HostName ${host}\n`) ? bridgeHome : ordinaryHome
    execFileSync('/bin/sh', ['-s'], { input: options.input, env: { PATH: '/usr/bin:/bin', HOME: home } })
    return ok('')
  } })
  rmSync(join(f.userData, 'bridge-admin.json')); rmSync(f.adminPath)
  const adopted = await f.service.adoptExistingBridge({ user: 'root', password: 'fixture-bootstrap', acceptedFingerprint: m.fingerprint(hostKey) })
  assert.ok(adopted.steps.every(s => s.state === 'done'), JSON.stringify(adopted))
  const rootAuth = join(bridgeHome, '.ssh/authorized_keys')
  assert.equal(readFileSync(rootAuth, 'utf8'), foreign + `${key(21)} drover-management\n`)
  const assertNoAdmin = async () => {
    const state = await f.service.state(), bridge = state.machines.find(machine => machine.id === adopted.machineId)
    assert.doesNotMatch(readFileSync(f.service.configPath, 'utf8'), /admin_ed25519|management_ed25519|drover-management-/)
    assert.ok(!readFileSync(f.service.configPath, 'utf8').includes(`Host ${bridge.alias}\n`))
    assert.ok(!readFileSync(join(f.home, '.drover/machines/MACHINES.md'), 'utf8').includes(`alias \`${bridge.alias}\``))
    await f.service.agentInstructions(join(f.home, 'project'))
    const stored = JSON.parse(readFileSync(join(f.home, '.drover/machines/projects.json'), 'utf8'))
    assert.equal(stored.length, 1)
    // Registered guides/configs also exclude the bridge, including advisory project scope.
    const path = join(f.home, '.drover/machines/projects', createHash('sha256').update(stored[0]).digest('hex') + '.md')
    assert.ok(!readFileSync(path, 'utf8').includes(`alias \`${bridge.alias}\``))
    assert.doesNotMatch(readFileSync(path + '.ssh_config', 'utf8'), /admin_ed25519|management_ed25519|drover-management-/)
    assert.ok(!readFileSync(path + '.ssh_config', 'utf8').includes(`Host ${bridge.alias}\n`))
  }
  await assertNoAdmin()
  const ordinaryBeforeRepair = await f.service.add({ kind: 'direct', name: 'ordinary-before-repair', host: '192.0.2.21', port, user: 'agent' })
  await f.service.installKey(ordinaryBeforeRepair.id, { password: 'fixture-ordinary', acceptedFingerprint: m.fingerprint(hostKey) })
  const ordinaryAuth = join(ordinaryHome, '.ssh/authorized_keys')
  await f.service.revokeAgentsKey({ confirmed: true })
  assert.equal(readFileSync(ordinaryAuth, 'utf8'), foreign + `${key(21)} drover-management\n`)
  assert.equal((await f.service.state()).machines.find(machine => machine.id === adopted.machineId).bridgeConnection.managed, undefined)
  assert.equal(f.calls.some(call => call.input?.includes('manifest.json') && JSON.parse(Buffer.from(call.input.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/)[1], 'base64')).action === 'repair'), false)
  await assertNoAdmin()
  const repaired = await f.service.repairExistingBridge({ machineId: adopted.machineId, acceptedFingerprint: m.fingerprint(hostKey), confirmed: true })
  assert.ok(repaired.steps.every(s => s.state === 'done'), JSON.stringify(repaired))
  assert.equal(readFileSync(rootAuth, 'utf8'), foreign + `${key(21)} drover-management\n`)
  const ordinary = await f.service.add({ kind: 'direct', name: 'ordinary', host: '192.0.2.21', port, user: 'agent' })
  await f.service.installKey(ordinary.id, { password: 'fixture-ordinary', acceptedFingerprint: m.fingerprint(hostKey) })
  const old = (await f.service.state()).agentsKey.publicKey
  assert.equal(readFileSync(ordinaryAuth, 'utf8'), foreign + `${old.split(' ').slice(0, 2).join(' ')} drover-agents\n${key(21)} drover-management\n`)
  await assertNoAdmin()
  await f.service.revokeAgentsKey({ confirmed: true })
  assert.equal(readFileSync(ordinaryAuth, 'utf8'), foreign + `${key(21)} drover-management\n`)
  assert.ok(!readFileSync(f.service.configPath, 'utf8').includes(`Host ${ordinary.alias}\n`))
  assert.equal(readFileSync(rootAuth, 'utf8'), foreign + `${key(21)} drover-management\n`)
  await assertNoAdmin()
})

test('Found password rejection is sanitized, unselected and retryable; login validation never authenticates', async t => {
  const f = fixture(t, { overrideRun: (file, args) => file === 'ssh' && args.includes('BatchMode=no') ? { code: 255, stdout: '', stderr: 'Permission denied confidential remote detail' } : undefined })
  rmSync(join(f.userData, 'bridge-admin.json'))
  let r = await f.service.adoptExistingBridge({ user: 'bad login', password: 'fixture-once', acceptedFingerprint: m.fingerprint(hostKey) })
  assert.equal(r.steps[0].error.code, 'invalid_user'); assert.equal(f.calls.some(c => c.file === 'ssh'), false)
  r = await f.service.adoptExistingBridge({ user: 'root', password: 'fixture-once', acceptedFingerprint: m.fingerprint(hostKey) })
  assert.equal(r.steps[0].error.code, 'password_rejected'); assert.doesNotMatch(JSON.stringify(r), /confidential remote detail|fixture-once/)
  assert.equal((await f.service.state()).bridgeMachineId, null)
})
