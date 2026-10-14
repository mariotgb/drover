import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const bundle = mkdtempSync(join(tmpdir(), 'drover-machines-bundle-'))
await build({ stdin: { contents: `export * from './src/main/machines/service'; export * from './src/main/machines/ssh'; export * from './src/main/machines/permissions'; export * from './src/main/machines/sessions'; export * from './src/main/machines/awareness'; export * from './src/main/machines/launch'; export * from './src/main/machines/ipc'; export * from './src/main/machines/herdr'; export * from './src/main/machines/helper'; export * from './src/main/office/collector';`, resolveDir: resolve('.'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: join(bundle, 'test.cjs'), alias: { '@shared': resolve('src/shared') }, loader: { '.sh': 'text', '.py': 'text', '.ps1': 'text' }, logLevel: 'silent' })
const m = createRequire(import.meta.url)(join(bundle, 'test.cjs'))
rmSync(bundle, { recursive: true, force: true })
const blob = seed => {
  const algorithm = Buffer.from('ssh-ed25519'), size = Buffer.alloc(4); size.writeUInt32BE(algorithm.length)
  return Buffer.concat([size, algorithm, Buffer.from([0,0,0,32]), Buffer.alloc(32, seed)]).toString('base64')
}
const publicKey = seed => `ssh-ed25519 ${blob(seed)} drover-test`
const hostKey = `[example.invalid]:22 ssh-ed25519 ${blob(7)}`

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'drover-machines-test-')), home = join(dir, 'home'), userData = join(dir, 'profile'), calls = [], events = []
  mkdirSync(home); mkdirSync(userData)
  let keySeed = 20, scan = hostKey, authFailure = '', managementFailure = false, tcpFailure = null, confirmed = false
  const run = async (file, args, opts = {}) => {
    calls.push({ file, args: [...args], input: opts.input, env: opts.env })
    if (file === 'ssh-keygen') {
      const path = args[args.indexOf('-f') + 1]
      writeFileSync(path, '-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE\n-----END OPENSSH PRIVATE KEY-----\n', { mode: 0o600 })
      writeFileSync(path + '.pub', publicKey(keySeed++), { mode: 0o600 })
      return { code: 0, stdout: '', stderr: '' }
    }
    if (file === 'ssh-keyscan' || args.at(-1).startsWith('ssh-keyscan')) return { code: 0, stdout: scan, stderr: '' }
    if (managementFailure && args.some(a => a.startsWith('drover-management-'))) return { code: 255, stdout: '', stderr: 'Connection timed out' }
    if (authFailure && !args.some(a => a.startsWith('drover-management-'))) return { code: 255, stdout: '', stderr: authFailure }
    return { code: 0, stdout: opts.input?.includes('DROVER_SESSION_CLEANUP') ? 'DROVER_SESSIONS {"terminated":2,"incomplete":false}\n' : args.at(-1).startsWith('sh -c') ? 'os=Linux\nlabel=Debian 12\ndisk=4096\nmemoryTotal=8192\nmemoryAvailable=2048\ndocker=1\nherdr=0\n' : '', stderr: '' }
  }
  const provisioner = { setupBridge: async (_, __, ___, ____, step) => { await step('bridge-policy') }, installCommand: async ctx => { calls.push({ context: ctx }); return 'fake install command' }, switchBridge: async (_, __, targets) => ({ updated: targets.filter(t => t.os === 'linux').map(t => t.id), needsReinstall: targets.filter(t => t.os !== 'linux').map(t => t.id) }), revokeBridgeKey: async () => {}, removeTargets: async () => {}, revokeInstallers: async bridge => { calls.push({ revokeInstallers: bridge?.id ?? null }) }, retireBridge: async bridge => { calls.push({ retireBridge: bridge.id }) }, ...options.provisioner }
  const { provisioner: override, ...settings } = options
  const service = new m.MachinesService({ home, userData, run, tcp: async () => { if (tcpFailure) throw tcpFailure; return 9 }, changed: s => events.push(s), provisioner: Object.hasOwn(options, 'provisioner') && override === undefined ? undefined : provisioner, confirmInclude: async () => confirmed, ...settings })
  t.after(() => { service.dispose(); rmSync(dir, { recursive: true, force: true }) })
  const direct = async name => service.add({ kind: 'direct', name, host: '203.0.113.5', port: 22, user: 'root' })
  const connect = async machine => service.installKey(machine.id, { password: 'temporary-password', acceptedFingerprint: m.fingerprint(hostKey) })
  return { dir, home, userData, calls, events, service, direct, connect, set scan(s) { scan = s }, set authFailure(s) { authFailure = s }, set managementFailure(s) { managementFailure = s }, set tcpFailure(s) { tcpFailure = s }, set confirmed(s) { confirmed = s } }
}

test('empty store is lazy; add validates, stores private metadata and never touches user SSH config', async t => {
  const f = fixture(t)
  assert.deepEqual((await f.service.state()).machines, [])
  assert.equal(existsSync(join(f.home, '.drover')), false)
  await assert.rejects(f.service.add({ kind: 'direct', name: 'bad', host: '-oProxyCommand=bad', port: 22, user: 'root' }), /IP address/)
  await assert.rejects(f.service.add({ kind: 'direct', name: 'bad', host: 'example.invalid', port: 22, user: 'x\nHost evil' }), /login name/)
  const machine = await f.direct('public-vps')
  await assert.rejects(f.direct('public-vps'), /already exists/)
  assert.equal(machine.alias, 'drover-public-vps')
  assert.equal(machine.publicIp, true)
  assert.equal(statSync(join(f.userData, 'machines.json')).mode & 0o777, 0o600)
  assert.equal(existsSync(join(f.home, '.ssh')), false)
  for (const file of readdirSync(join(f.home, '.drover/machines/keys'))) assert.equal(statSync(join(f.home, '.drover/machines/keys', file)).mode & 0o777, 0o600)
  const config = readFileSync(f.service.configPath, 'utf8')
  assert.match(config, /IdentitiesOnly yes/); assert.match(config, /StrictHostKeyChecking yes/); assert.match(config, /GlobalKnownHostsFile \/dev\/null/)
  assert.doesNotMatch(config, /management_ed25519|drover-management-/)
})

test('pins only confirmed host key, re-scans to catch a change, and gathers key-only metrics', async t => {
  const f = fixture(t), machine = await f.direct('vps')
  const probe = await f.service.probeHostKey('203.0.113.5', 22)
  assert.equal(probe.known, false)
  f.scan = `example.invalid ssh-ed25519 ${blob(8)}`
  await assert.rejects(f.connect(machine), /key changed/)
  assert.equal(f.calls.some(c => c.file === 'ssh' && !c.args.includes('PreferredAuthentications=none')), false)
  f.scan = hostKey
  const checked = await f.connect(machine)
  assert.equal(checked.status.state, 'online')
  assert.deepEqual(checked.status.checks, { tcp: true, auth: true, diskAvailableBytes: 4096, memoryTotalBytes: 8192, memoryAvailableBytes: 2048, docker: true, herdr: false })
  assert.equal((await f.service.probeHostKey('203.0.113.5', 22)).known, true)
  const persisted = readFileSync(join(f.userData, 'machines.json'), 'utf8')
  assert.doesNotMatch(persisted, /temporary-password|PRIVATE KEY/)
  for (const c of f.calls) { assert.doesNotMatch(JSON.stringify(c), /temporary-password/) }
  const bootstrap = f.calls.find(c => c.args?.includes('BatchMode=no'))
  assert.ok(bootstrap.env.SSH_ASKPASS); assert.equal(bootstrap.env.SSH_ASKPASS_REQUIRE, 'force')
  assert.equal(existsSync(bootstrap.env.SSH_ASKPASS), false)
})

test('connection failures return plain reasons and never authenticate before host confirmation', async t => {
  const f = fixture(t), machine = await f.direct('vps')
  let checked = await f.service.check(machine.id)
  assert.equal(checked.status.error.code, 'host_key_unconfirmed')
  assert.deepEqual(checked.status.checks, { tcp: true, auth: false })
  await f.connect(machine)
  f.authFailure = 'Permission denied (publickey)'
  checked = await f.service.check(machine.id)
  assert.equal(checked.status.error.code, 'auth_failed')
  f.tcpFailure = new m.MachinesFailure('refused', 'No SSH listener.')
  assert.equal((await f.service.check(machine.id)).status.error.code, 'refused')
})

test('bridged flow supports LAN, confirms target through bridge and switches tunnel targets', async t => {
  const f = fixture(t)
  const target = await f.service.add({ kind: 'bridged', name: 'home', os: 'linux' })
  const started = Date.now(), lan = await f.service.installCommand(target.id, 'linux')
  assert.equal(lan.command, 'fake install command')
  assert.ok(lan.expiresAt >= started + 7_200_000 && lan.expiresAt <= Date.now() + 7_200_000)
  const context = f.calls.find(c => c.context)?.context
  assert.equal(context.bridge, null)
  assert.equal(typeof context.onReport, 'function')
  const b = await f.direct('bridge'); await f.connect(b)
  await f.service.setupBridge(b.id, { caddy: false, confirmed: true }); await f.service.setBridge(b.id, { confirmed: true })
  const cmd = await f.service.installCommand(target.id, 'linux')
  assert.equal(cmd.command, 'fake install command')
  const checked = await f.service.check(target.id)
  assert.equal(checked.status.error.code, 'host_key_unconfirmed')
  assert.equal(checked.status.checks.tcp, true)
  const probe = await f.service.probeHostKey(target.alias, target.bridgePort)
  const connected = await f.service.installKey(target.id, { acceptedFingerprint: probe.fingerprint })
  assert.equal(connected.status.checks.auth, true)
  assert.match(readFileSync(f.service.configPath, 'utf8'), /ProxyJump drover-jump-/)
  const next = await f.direct('next'); await f.connect(next); await f.service.setupBridge(next.id, { caddy: false, confirmed: true }); await f.service.setBridge(next.id, { confirmed: true })
  const state = await f.service.state(), updated = state.machines.find(m => m.id === target.id)
  assert.equal(state.bridgeMachineId, next.id)
  assert.equal(updated.bridgeMachineId, next.id)
  assert.equal(updated.needsReinstall, false)
})

test('LAN report records the peer address and never grants host trust; stale reports are ignored', async t => {
  const f = fixture(t), target = await f.service.add({ kind: 'bridged', name: 'lan', os: 'linux' })
  await f.service.installCommand(target.id, 'linux')
  const old = f.calls.find(c => c.context).context
  await f.service.installCommand(target.id, 'linux')
  const current = f.calls.filter(c => c.context).at(-1).context
  const report = { machineId: target.id, os: 'linux', state: 'installed', hostKey: publicKey(7), lanHost: '10.2.3.4' }
  await old.onReport(report)
  assert.equal((await f.service.state()).machines[0].host, undefined)
  await assert.rejects(current.onReport({ ...report, lanHost: 'example.invalid' }), /private local network/)
  await current.onReport(report)
  const received = (await f.service.state()).machines[0]
  assert.equal(received.host, '10.2.3.4'); assert.equal(received.port, 22)
  assert.equal(received.installReport.fingerprint, m.fingerprint(publicKey(7)))
  assert.equal(received.status.error.code, 'host_key_unconfirmed')
  assert.equal(f.calls.some(c => c.file === 'ssh'), false)
  assert.equal(readFileSync(f.service.knownHosts, 'utf8'), '')
  assert.match(readFileSync(f.service.configPath, 'utf8'), /Host drover-lan\n  HostName 10\.2\.3\.4\n  Port 22/)
  const probe = await f.service.probeHostKey(target.alias, target.bridgePort)
  await f.service.installKey(target.id, { acceptedFingerprint: probe.fingerprint })
  assert.equal((await f.service.state()).machines[0].status.state, 'online')
})

test('target removal revokes live LAN capabilities before credentials and fails closed on revocation error', async t => {
  const f = fixture(t, { provisioner: undefined, lanHost: '127.0.0.1' })
  const target = await f.service.add({ kind: 'bridged', name: 'lan-remove', os: 'linux' })
  const { command } = await f.service.installCommand(target.id, 'linux')
  const url = command.match(/'(http:\/\/[^']+)\/script'/)[1]
  assert.equal((await fetch(url + '/script')).status, 200)
  await f.service.remove(target.id, { confirmed: true })
  assert.equal((await fetch(url + '/key')).status, 410)
  assert.equal((await fetch(url + '/script')).status, 410)
  assert.deepEqual((await f.service.state()).machines, [])
  const rejected = fixture(t, { provisioner: { revokeInstallers: async () => { throw new m.MachinesFailure('offline', 'Capability service offline.') } } })
  const other = await rejected.service.add({ kind: 'bridged', name: 'retain', os: 'linux' })
  await rejected.service.installCommand(other.id, 'linux')
  const before = rejected.calls.length
  await assert.rejects(rejected.service.remove(other.id, { confirmed: true }), /Capability service offline/)
  assert.equal(rejected.calls.slice(before).some(c => c.file === 'ssh'), false)
  assert.equal((await rejected.service.state()).machines.length, 1)
  assert.ok(JSON.parse(readFileSync(join(rejected.userData, 'machines.json'))).issuedInstallers.includes(other.id))
})

test('active bridge removal revokes reachable target credentials before retirement and keeps offline cleanup across restart', async t => {
  const f = fixture(t), bridge = await f.direct('retire'); await f.connect(bridge)
  await f.service.setupBridge(bridge.id, { caddy: false, confirmed: true }); await f.service.setBridge(bridge.id, { confirmed: true })
  const online = await f.service.add({ kind: 'bridged', name: 'reachable', os: 'linux' })
  const offline = await f.service.add({ kind: 'bridged', name: 'offline', os: 'linux' })
  await f.service.installCommand(online.id, 'linux'); await f.service.installCommand(offline.id, 'linux')
  const fallback = f.service.run
  f.service.run = (file, args, options) => file === 'ssh' && args.includes(`drover-management-${offline.id}`) ? Promise.resolve({ code: 255, stdout: '', stderr: 'Connection timed out' }) : fallback(file, args, options)
  const before = f.calls.length
  await f.service.remove(bridge.id, { confirmed: true })
  const calls = f.calls.slice(before), retireIndex = calls.findIndex(c => c.retireBridge)
  const revokeIndex = calls.findIndex(c => c.args?.includes(`drover-management-${online.id}`) && c.input?.includes('manager='))
  assert.ok(revokeIndex >= 0 && revokeIndex < retireIndex)
  const ownManagement = calls.findIndex(c => c.args?.includes(`drover-management-${bridge.id}`) && c.input?.includes(publicKey(21).split(' ')[1]))
  assert.ok(ownManagement > retireIndex)
  const stored = JSON.parse(readFileSync(join(f.userData, 'machines.json')))
  assert.equal(stored.credentialRemovals[online.id], undefined)
  assert.equal(stored.credentialRemovals[offline.id].bridgeMachineId, bridge.id)
  assert.equal(stored.credentialRemovals[offline.id].managementPublicKey, publicKey(21))
  assert.ok(stored.credentialRemovals[offline.id].agentsPublicKeys.includes(publicKey(20)))
  assert.equal(stored.bridgeMachineId, null)
  assert.ok(stored.machines.every(target => target.needsReinstall && !target.bridgeMachineId && target.status.error.code === 'no_bridge'))
  assert.doesNotMatch(readFileSync(f.service.configPath, 'utf8'), /Host drover-(reachable|offline)\n/)
  f.service.dispose()
  const restarted = new m.MachinesService({ home: f.home, userData: f.userData, run: fallback, tcp: async () => 9, provisioner: {} })
  t.after(() => restarted.dispose())
  assert.equal((await restarted.state()).machines.length, 2)
  assert.equal((await restarted.check(offline.id)).status.error.code, 'no_bridge')
  assert.equal(JSON.parse(readFileSync(join(f.userData, 'machines.json'))).credentialRemovals[offline.id].bridgeMachineId, bridge.id)
})

test('offline issued target recovers after active bridge removal through LAN or a replacement bridge without its old route', async t => {
  for (const replacement of [false, true]) await t.test(replacement ? 'replacement bridge' : 'LAN', async t => {
    const f = fixture(t, { lanHost: '127.0.0.1' }), bridge = await f.direct('retired')
    await f.connect(bridge); await f.service.setupBridge(bridge.id, { caddy: false, confirmed: true }); await f.service.setBridge(bridge.id, { confirmed: true })
    const target = await f.service.add({ kind: 'bridged', name: 'recover', os: 'linux' })
    await f.service.installCommand(target.id, 'linux')
    const issued = f.calls.filter(c => c.context).at(-1).context
    const fallback = f.service.run
    let targetManagementCalls = 0
    f.service.run = (file, args, options) => {
      if (file === 'ssh' && args.includes(`drover-management-${target.id}`)) {
        targetManagementCalls++
        return Promise.resolve({ code: 255, stdout: '', stderr: 'Connection timed out' })
      }
      return fallback(file, args, options)
    }
    await f.service.remove(bridge.id, { confirmed: true })
    assert.equal(targetManagementCalls, 1)
    const persisted = () => JSON.parse(readFileSync(join(f.userData, 'machines.json')))
    assert.equal(persisted().machines[0].host, undefined)
    assert.equal(persisted().machines[0].bridgeMachineId, undefined)
    assert.equal(persisted().credentialRemovals[target.id].bridgeMachineId, bridge.id)
    if (replacement) {
      const next = await f.direct('replacement'); await f.connect(next)
      await f.service.setupBridge(next.id, { caddy: false, confirmed: true }); await f.service.setBridge(next.id, { confirmed: true })
    }
    const oldRouteCalls = targetManagementCalls
    const publish = f.service.provisioner.installCommand
    f.service.provisioner.installCommand = async (context, os) => {
      assert.equal(persisted().credentialRemovals[target.id].recoveryId, context.recoveryCleanup.id, 'cleanup ID must be durable before publishing the capability')
      return publish(context, os)
    }
    await f.service.installCommand(target.id, 'linux')
    const recovery = f.calls.filter(c => c.context).at(-1).context
    assert.equal(targetManagementCalls, oldRouteCalls, 'installer publication must not require target management SSH')
    assert.equal(recovery.bridge?.name ?? null, replacement ? 'replacement' : null)
    assert.deepEqual(recovery.recoveryCleanup.agentsPublicKeys, [issued.agentsPublicKey])
    assert.equal(recovery.recoveryCleanup.managementPublicKey, issued.managementPublicKey)
    assert.equal(persisted().credentialRemovals[target.id].recoveryId, recovery.recoveryCleanup.id)
    assert.equal((await f.service.state()).machines.find(m => m.id === target.id).needsReinstall, true)
    assert.doesNotMatch(readFileSync(f.service.configPath, 'utf8'), /Host drover-recover\n/)
    await assert.rejects(f.service.finishCredentialRemoval(f.service.d.machines.find(m => m.id === target.id)), /receipt arrives/)
    assert.equal(targetManagementCalls, oldRouteCalls, 'automatic cleanup must not remove newly installed credentials before receipt')
    const report = { machineId: target.id, os: 'linux', state: 'installed', hostKey: publicKey(7), ...(replacement ? {} : { lanHost: '10.2.3.4' }) }
    await assert.rejects(recovery.onReport(report), /not acknowledged/)
    await assert.rejects(recovery.onReport({ ...report, cleanupId: 'b122dd2b-0cab-43cf-976a-16d76a96ffd1' }), /not acknowledged/)
    assert.ok(persisted().credentialRemovals[target.id])
    await f.service.installCommand(target.id, 'linux')
    const latest = f.calls.filter(c => c.context).at(-1).context
    assert.notEqual(latest.recoveryCleanup.id, recovery.recoveryCleanup.id)
    assert.ok(f.calls.some(c => Object.hasOwn(c, 'revokeInstallers') && c.revokeInstallers === (latest.bridge?.id ?? null)))
    await recovery.onReport({ ...report, cleanupId: recovery.recoveryCleanup.id })
    assert.equal(persisted().credentialRemovals[target.id].recoveryId, latest.recoveryCleanup.id, 'stale receipt must not clear current recovery')
    await latest.onReport({ ...report, cleanupId: latest.recoveryCleanup.id })
    assert.equal(persisted().credentialRemovals[target.id], undefined)
    const recovered = (await f.service.state()).machines.find(m => m.id === target.id)
    assert.equal(recovered.needsReinstall, false)
    assert.equal(recovered.status.error.code, 'host_key_unconfirmed')
    assert.equal(recovered.installReport.fingerprint, m.fingerprint(publicKey(7)))
    assert.equal(readFileSync(f.service.knownHosts, 'utf8').includes(`drover-machine-${target.id}`), false)
    assert.equal(targetManagementCalls, oldRouteCalls)
  })
})

test('published recovery remains durable across restart and can be regenerated without target SSH', async t => {
  const f = fixture(t), bridge = await f.direct('before-restart'); await f.connect(bridge)
  await f.service.setupBridge(bridge.id, { caddy: false, confirmed: true }); await f.service.setBridge(bridge.id, { confirmed: true })
  const target = await f.service.add({ kind: 'bridged', name: 'restart-recover', os: 'linux' })
  await f.service.installCommand(target.id, 'linux')
  const run = f.service.run
  f.service.run = async (file, args, options) => {
    if (file === 'ssh' && args.includes(`drover-management-${target.id}`)) return { code: 255, stdout: '', stderr: 'Connection timed out' }
    return run(file, args, options)
  }
  await f.service.remove(bridge.id, { confirmed: true })
  await f.service.installCommand(target.id, 'linux')
  const previousId = f.calls.filter(c => c.context).at(-1).context.recoveryCleanup.id
  f.service.dispose()
  let context
  const restarted = new m.MachinesService({ home: f.home, userData: f.userData, run: async () => { throw Error('No old target route is allowed') }, tcp: async () => 9, provisioner: { revokeInstallers: async () => {}, installCommand: async ctx => { context = ctx; return 'recovery command' } } })
  t.after(() => restarted.dispose())
  assert.equal((await restarted.state()).machines[0].needsReinstall, true)
  await assert.rejects(restarted.finishCredentialRemoval(restarted.d.machines[0]), /receipt arrives/)
  assert.equal((await restarted.installCommand(target.id, 'linux')).command, 'recovery command')
  assert.notEqual(context.recoveryCleanup.id, previousId)
  assert.equal(JSON.parse(readFileSync(join(f.userData, 'machines.json'))).credentialRemovals[target.id].recoveryId, context.recoveryCleanup.id)
  await context.onReport({ machineId: target.id, os: 'linux', state: 'installed', hostKey: publicKey(7), lanHost: '10.2.3.4', cleanupId: context.recoveryCleanup.id })
  assert.equal(JSON.parse(readFileSync(join(f.userData, 'machines.json'))).credentialRemovals[target.id], undefined)
  assert.equal((await restarted.state()).machines[0].status.error.code, 'host_key_unconfirmed')
})

test('live LAN recovery capability binds cleanup receipt to the durable removal and keeps host trust separate', async t => {
  const f = fixture(t), bridge = await f.direct('lan-recovery-source'); await f.connect(bridge)
  await f.service.setupBridge(bridge.id, { caddy: false, confirmed: true }); await f.service.setBridge(bridge.id, { confirmed: true })
  const target = await f.service.add({ kind: 'bridged', name: 'live-recovery', os: 'linux' })
  await f.service.installCommand(target.id, 'linux')
  const run = f.service.run
  f.service.run = (file, args, options) => file === 'ssh' && args.includes(`drover-management-${target.id}`) ? Promise.resolve({ code: 255, stdout: '', stderr: 'Connection timed out' }) : run(file, args, options)
  await f.service.remove(bridge.id, { confirmed: true })
  f.service.dispose()
  const service = new m.MachinesService({ home: f.home, userData: f.userData, lanHost: '127.0.0.1', run: async () => { throw Error('Recovery must not use the old SSH route') }, tcp: async () => 9 })
  t.after(() => service.dispose())
  const { command } = await service.installCommand(target.id, 'linux')
  const url = command.match(/'(http:\/\/[^']+)\/script'/)[1]
  const script = await (await fetch(url + '/script')).text()
  assert.ok(!script.includes('__DROVER_RECOVERY_UNIX__'))
  const credentials = await (await fetch(url + '/key')).json()
  const file = join(f.userData, 'machines.json'), stored = () => JSON.parse(readFileSync(file))
  assert.equal(credentials.recoveryCleanup.id, stored().credentialRemovals[target.id].recoveryId)
  assert.equal((await fetch(url + '/key')).status, 410)
  const report = { machineId: target.id, os: 'linux', state: 'installed', hostKey: publicKey(7) }
  const post = cleanupId => fetch(url + '/report', { method: 'POST', headers: { Authorization: 'Bearer ' + credentials.receipt }, body: JSON.stringify({ ...report, ...(cleanupId ? { cleanupId } : {}) }) })
  assert.equal((await post()).status, 400)
  assert.equal((await post('wrong-cleanup')).status, 400)
  assert.ok(stored().credentialRemovals[target.id])
  assert.equal((await post(credentials.recoveryCleanup.id)).status, 200)
  assert.equal(stored().credentialRemovals[target.id], undefined)
  const result = (await service.state()).machines[0]
  assert.equal(result.host, '127.0.0.1')
  assert.equal(result.status.error.code, 'host_key_unconfirmed')
  assert.equal(readFileSync(service.knownHosts, 'utf8').includes(`drover-machine-${target.id}`), false)
})

test('failed bridge retirement retains bridge and queue; a retry cancels only after successful retirement', async t => {
  let fails = true
  const f = fixture(t, { provisioner: { retireBridge: async () => { if (fails) throw new m.MachinesFailure('offline', 'Retirement failed.') } } })
  const b = await f.direct('keep'); await f.connect(b); await f.service.setupBridge(b.id, { caddy: false, confirmed: true }); await f.service.setBridge(b.id, { confirmed: true })
  await f.service.bridgeCleanup.enqueue(b.id, [], (await f.service.state()).agentsKey.publicKey)
  await assert.rejects(f.service.remove(b.id, { confirmed: true }), /Retirement failed/)
  assert.equal((await f.service.state()).bridgeMachineId, b.id)
  assert.equal((await f.service.state()).machines[0].bridgeSetup.cleanup.state, 'blocked')
  await f.service.check(b.id)
  assert.ok(JSON.parse(readFileSync(join(f.userData, 'machines.json'))).credentialRemovals[b.id])
  fails = false; await f.service.remove(b.id, { confirmed: true })
  assert.deepEqual(JSON.parse(readFileSync(join(f.userData, 'bridge-cleanup.json'))).jobs, [])
  assert.equal((await f.service.state()).machines.length, 0)
})

test('bridge switch writes cleanup ahead, projects pending state, and retries on startup/check without touching the active bridge', async t => {
  const actions = []; let oldId, fail = true
  const f = fixture(t, { provisioner: {
    switchBridge: async (_old, _next, targets) => {
      if (oldId) assert.ok(JSON.parse(readFileSync(join(f.userData, 'bridge-cleanup.json'))).jobs.some(j => j.bridgeId === oldId))
      return { updated: targets.map(m => m.id), needsReinstall: [], pendingOldCleanup: oldId ? [oldId] : [] }
    },
    removeTargets: async b => { actions.push(['remove', b.id]); if (fail) throw Error('offline') },
    revokeInstallers: async b => { actions.push(['revoke', b?.id]) }
  } })
  const b = await f.direct('old'); await f.connect(b); await f.service.setupBridge(b.id, { caddy: false, confirmed: true }); await f.service.setBridge(b.id, { confirmed: true })
  oldId = b.id
  const next = await f.direct('new'); await f.connect(next); await f.service.setupBridge(next.id, { caddy: false, confirmed: true }); await f.service.setBridge(next.id, { confirmed: true })
  const state = await f.service.state()
  assert.equal(state.machines.find(m => m.id === b.id).bridgeSetup.cleanup.state, 'pending')
  assert.ok(actions.every(a => a[1] === b.id))
  const file = join(f.userData, 'bridge-cleanup.json'), queued = JSON.parse(readFileSync(file)); queued.jobs[0].nextAttemptAt = 0; writeFileSync(file, JSON.stringify(queued), { mode: 0o600 })
  f.service.dispose(); fail = false
  const restarted = new m.MachinesService({ home: f.home, userData: f.userData, run: f.service.run, tcp: async () => 9, provisioner: {
    removeTargets: async b => actions.push(['remove', b.id]), revokeInstallers: async b => actions.push(['revoke', b.id])
  } }); t.after(() => restarted.dispose())
  assert.equal((await restarted.state()).machines.find(m => m.id === b.id).bridgeSetup.cleanup, undefined)
  await restarted.bridgeCleanup.enqueue(b.id, [], state.agentsKey.publicKey)
  await restarted.check(next.id)
  assert.ok(actions.every(a => a[1] === b.id))
  assert.equal(restarted.bridgeCleanup.cleanupState(b.id), undefined)
})

test('permission change/revoke/remove report dedicated session termination and warn for supplied accounts', async t => {
  const f = fixture(t), target = await f.service.add({ kind: 'bridged', name: 'sessions', os: 'linux' })
  await f.service.installCommand(target.id, 'linux')
  await f.service.setPermissions(target.id, { mode: 'read-only', projects: [] })
  assert.deepEqual((await f.service.state()).machines[0].sessionCleanup.last.reason, 'permissions')
  assert.equal((await f.service.state()).machines[0].sessionCleanup.last.terminated, 2)
  const reports = await f.service.revokeAgentsKey({ confirmed: true })
  assert.equal(reports[0].terminated, 2); assert.equal(reports[0].incomplete, false)
  const removed = await f.service.remove(target.id, { confirmed: true })
  assert.equal(removed.terminated, 2); assert.equal(removed.incomplete, false)
  const supplied = await f.direct('supplied'); await f.connect(supplied)
  await f.service.setPermissions(supplied.id, { mode: 'read-only', projects: [] })
  const warning = (await f.service.state()).machines[0].sessionCleanup
  assert.equal(warning.account, 'supplied'); assert.equal(warning.last.incomplete, true)
  assert.equal((await f.service.remove(supplied.id, { confirmed: true })).incomplete, true)
  assert.equal(f.calls.filter(c => c.args?.includes(`drover-management-${supplied.id}`)).some(c => c.input?.includes('DROVER_SESSION_CLEANUP')), false)
})

test('selected-project aliases are advisory and visible only in the scoped guide/config', async t => {
  const f = fixture(t), machine = await f.direct('scoped'), selected = join(f.dir, 'chosen'), unrelated = join(f.dir, 'other')
  await f.service.setPermissions(machine.id, { mode: 'projects', projects: [selected] })
  assert.doesNotMatch(readFileSync(f.service.configPath, 'utf8'), /Host drover-scoped\n/)
  assert.doesNotMatch(readFileSync(join(f.service.root, 'MACHINES.md'), 'utf8'), /drover-scoped/)
  const pointer = await f.service.agentInstructions(selected), path = pointer.match(/read (.+?\.md)\./)[1]
  assert.match(readFileSync(path, 'utf8'), /drover-scoped/); assert.match(readFileSync(path, 'utf8'), /advisory, not a security boundary/)
  assert.match(readFileSync(path + '.ssh_config', 'utf8'), /Host drover-scoped/)
  const otherPointer = await f.service.agentInstructions(unrelated), other = otherPointer.match(/read (.+?\.md)\./)[1]
  assert.doesNotMatch(readFileSync(other, 'utf8'), /drover-scoped/)
  await f.service.setPermissions(machine.id, { mode: 'projects', projects: [unrelated] })
  assert.doesNotMatch(readFileSync(path, 'utf8'), /drover-scoped/)
  assert.doesNotMatch(readFileSync(path + '.ssh_config', 'utf8'), /Host drover-scoped/)
})

test('key revocation regenerates, cleans reachable machines and retains pending offline cleanup', async t => {
  const f = fixture(t), machine = await f.direct('vps'); await f.connect(machine)
  const old = (await f.service.state()).agentsKey
  f.managementFailure = true
  await f.service.revokeAgentsKey({ confirmed: true })
  const state = await f.service.state()
  assert.notEqual(state.agentsKey.fingerprint, old.fingerprint)
  assert.equal(state.machines[0].status.error.code, 'revocation_pending')
  assert.equal(state.machines[0].needsReinstall, true)
  assert.doesNotMatch(readFileSync(f.service.configPath, 'utf8'), /Host drover-vps\n/)
  await assert.rejects(f.service.remove(machine.id, { confirmed: true }), /did not answer/)
  assert.equal((await f.service.state()).machines.length, 1)
  f.managementFailure = false
  await f.service.check(machine.id)
  assert.deepEqual(JSON.parse(readFileSync(join(f.userData, 'machines.json'))).revocations, {})
  assert.ok(f.calls.some(c => c.input?.includes(old.publicKey.split(' ')[1])))
})

test('Include requires confirmation, backs up, deduplicates and rejects symlinks', async t => {
  const f = fixture(t); await f.direct('vps')
  mkdirSync(join(f.home, '.ssh')); const config = join(f.home, '.ssh/config')
  const old = 'Host personal\n  HostName example.invalid\n'
  writeFileSync(config, old)
  await f.service.state(); assert.equal(readFileSync(config, 'utf8'), old)
  await assert.rejects(f.service.addSshInclude(), /not installed/)
  assert.equal(readFileSync(config, 'utf8'), old)
  f.confirmed = true
  await f.service.addSshInclude(); await f.service.addSshInclude()
  const state = await f.service.state()
  assert.equal(state.sshInclude.installed, true)
  assert.equal(readFileSync(config, 'utf8').split('\n').filter(line => line.startsWith('Include')).length, 1)
  assert.ok(readdirSync(join(f.home, '.ssh')).some(file => file.startsWith('config.drover-backup-')))
  assert.match(readFileSync(config, 'utf8'), /Host personal/)
  rmSync(config); symlinkSync(join(f.dir, 'unrelated'), config)
  await assert.rejects(f.service.addSshInclude(), /symlink/)
})

test('askpass password is one-use, memory-only and cleaned after failure', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'drover-askpass-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  let launcher
  await assert.rejects(m.withAskpass('one-use-secret', dir, process.execPath, async env => {
    launcher = env.SSH_ASKPASS
    assert.doesNotMatch(JSON.stringify(env), /one-use-secret/)
    assert.doesNotMatch(readFileSync(launcher, 'utf8'), /one-use-secret/)
    // Async runner permits the in-process password socket to answer.
    const first = await m.runCommand(launcher, [], { env: { ...process.env, ...env } })
    assert.equal(first.stdout, 'one-use-secret\n')
    const second = await m.runCommand(launcher, [], { env: { ...process.env, ...env } })
    assert.equal(second.stdout, '')
    throw new Error('bootstrap failed')
  }), /bootstrap failed/)
  assert.equal(existsSync(launcher), false)
})

test('read-only key sandbox fails closed before authorization; existing keys preserved', t => {
  const dir = mkdtempSync(join(tmpdir(), 'drover-policy-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const home = join(dir, 'home'); mkdirSync(home); mkdirSync(join(home, '.ssh'))
  const auth = join(home, '.ssh/authorized_keys'); writeFileSync(auth, publicKey(3) + ' personal\n')
  const script = m.keyInstallScript(publicKey(20), publicKey(21), { mode: 'read-only', projects: [] })
  assert.throws(() => execFileSync('/bin/sh', ['-s'], { input: script, env: { PATH: '/usr/bin:/bin', HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] }))
  assert.equal(readFileSync(auth, 'utf8'), publicKey(3) + ' personal\n')
  assert.match(m.READ_ONLY_GUARD, /--seccomp/); assert.match(m.READ_ONLY_GUARD, /--unshare-all/)
  execFileSync('/bin/sh', ['-s'], { input: m.keyInstallScript(publicKey(20), publicKey(21), { mode: 'full', projects: [] }), env: { PATH: '/usr/bin:/bin', HOME: home } })
  assert.match(readFileSync(auth, 'utf8'), /personal/)
  assert.match(readFileSync(auth, 'utf8'), /drover-management/)
})

test('key bootstrap, replacement and removal preserve other installations with identical comments byte-for-byte', t => {
  const f = fixture(t), authHome = join(f.dir, 'remote-home'), auth = join(authHome, '.ssh/authorized_keys')
  mkdirSync(join(authHome, '.ssh'), { recursive: true })
  const foreign = [
    `  ${publicKey(3).replace('drover-test', 'drover-management')}\r\n`,
    `restrict,command="printf foreign key" ${publicKey(4).replace('drover-test', 'drover-agents')}\n`,
    `# ssh-ed25519 ${blob(20)} drover-agents\n`,
    `ssh-ed25519\n`,
    `${publicKey(5)} mentions owned blob ${blob(20)} and ${blob(21)} drover-management\n`
  ].join('')
  writeFileSync(auth, foreign)
  const run = input => execFileSync('/bin/sh', ['-s'], { input, env: { PATH: '/usr/bin:/bin', HOME: authHome } })
  run(m.adminKeyInstallScript(publicKey(21)))
  assert.equal(readFileSync(auth, 'utf8'), foreign + `ssh-ed25519 ${blob(21)} drover-management\n`)
  writeFileSync(auth, foreign + `restrict,command="printf old agent" ssh-ed25519 ${blob(19)}\r\n` + `ssh-ed25519 ${blob(21)}\r\n`)
  const install = m.keyInstallScript(publicKey(20), publicKey(21), { mode: 'full', projects: [] }, publicKey(19))
  run(install); run(install)
  assert.equal(readFileSync(auth, 'utf8'), foreign + `ssh-ed25519 ${blob(20)} drover-agents\nssh-ed25519 ${blob(21)} drover-management\n`)
  run(m.removeKeyScript(publicKey(20), publicKey(21)))
  assert.equal(readFileSync(auth, 'utf8'), foreign + `ssh-ed25519 ${blob(21)} drover-management\n`)
  run(m.removeKeyScript(publicKey(20), publicKey(21), true))
  assert.deepEqual(readFileSync(auth), Buffer.from(foreign))
  assert.throws(() => m.removeKeyScript('', publicKey(21)), /Invalid managed public key/)
})

test('destructive IPC rejects non-boolean confirmation before loading, persistence, queue execution or key rotation', async t => {
  const f = fixture(t), old = await f.direct('old'), next = await f.direct('next')
  await f.connect(old); await f.connect(next)
  await f.service.setupBridge(old.id, { caddy: false, confirmed: true })
  await f.service.setupBridge(next.id, { caddy: false, confirmed: true })
  await f.service.setBridge(old.id, { confirmed: true })
  const cleanup = join(f.userData, 'bridge-cleanup.json')
  writeFileSync(cleanup, JSON.stringify({ version: 1, jobs: [{ bridgeId: next.id, targetIds: [], agentsPublicKey: publicKey(20).split(' ').slice(0, 2).join(' '), targetsRemoved: false, attempts: 0, nextAttemptAt: 0 }] }))
  const snapshot = path => {
    const files = {}
    const visit = dir => { for (const name of readdirSync(dir)) { const file = join(dir, name), stat = statSync(file); if (stat.isDirectory()) visit(file); else files[file] = { data: readFileSync(file).toString('base64'), mtime: stat.mtimeMs } } }
    visit(path); return files
  }
  const saved = snapshot(f.dir), calls = f.calls.length
  let effects = 0
  const service = new m.MachinesService({ home: f.home, userData: f.userData, run: async () => { effects++; throw Error('Unexpected command') }, tcp: async () => { effects++; return 1 }, changed: () => { effects++ }, provisioner: { setupBridge: async () => { effects++ }, removeTargets: async () => { effects++ }, revokeInstallers: async () => { effects++ }, switchBridge: async () => { effects++ }, retireBridge: async () => { effects++ } } })
  t.after(() => service.dispose())
  const handlers = new Map()
  m.registerMachinesIpc({ handle(channel, fn) { handlers.set(channel, fn) } }, service, () => true)
  const attempts = [
    ['machines:remove', old.id],
    ['machines:set-bridge', next.id],
    ['machines:revoke-key'],
    ['machines:setup-bridge', next.id]
  ]
  for (const [channel, machineId] of attempts) {
    for (const options of [undefined, null, {}, { confirmed: false }, { confirmed: 'true' }, { confirmed: 1 }]) {
      const args = machineId ? [machineId, options] : [options]
      if (channel === 'machines:setup-bridge' && options) args[1] = { ...options, caddy: false }
      await assert.rejects(handlers.get(channel)({}, ...args), /Explicitly confirm/)
      assert.deepEqual(snapshot(f.dir), saved)
      assert.equal(effects, 0)
    }
  }
  assert.equal(f.calls.length, calls)
  const empty = fixture(t)
  for (const action of [() => empty.service.remove(old.id), () => empty.service.setBridge(next.id, { confirmed: 'true' }), () => empty.service.revokeAgentsKey({ confirmed: 1 }), () => empty.service.setupBridge(next.id, { caddy: true, confirmed: false })]) await assert.rejects(action(), { code: 'confirmation_required' })
  assert.equal(existsSync(join(empty.home, '.drover')), false)
  assert.deepEqual(readdirSync(empty.userData), [])
  assert.equal(empty.calls.length, 0); assert.equal(empty.events.length, 0)
})

test('launch pointers preserve native user arguments and IPC denies non-desktop callers', async () => {
  const args = ['--append-system-prompt', 'user instructions', '--model', 'opus']
  assert.deepEqual(m.machineLaunchArgs('claude', args, 'machine pointer'), ['--append-system-prompt', 'user instructions\n\nmachine pointer', '--model', 'opus'])
  assert.equal(args[1], 'user instructions')
  assert.deepEqual(m.machineLaunchArgs('codex', ['-c', 'developer_instructions="user"'], 'machine pointer'), ['-c', 'developer_instructions="user\\n\\nmachine pointer"'])
  const handlers = new Map(); let calls = 0
  m.registerMachinesIpc({ handle(channel, fn) { handlers.set(channel, fn) } }, { state() { calls++; return {} } }, e => e.desktop)
  await assert.rejects(handlers.get('machines:state')({ desktop: false }), /local desktop/)
  await handlers.get('machines:state')({ desktop: true })
  assert.equal(calls, 1)
})

test('administrator key picker is desktop-only, opens hidden SSH files and returns only one path', async () => {
  const handlers = new Map(), calls = [], path = '/home/fixture/.ssh/admin_ed25519'
  let result = { canceled: false, filePaths: [path, '/home/fixture/unused'] }
  m.registerMachinesIpc({ handle(channel, fn) { handlers.set(channel, fn) } }, {}, event => event.desktop, { home: '/home/fixture', open: async options => { calls.push(options); return result } })
  const choose = handlers.get('machines:choose-bridge-key-file')
  await assert.rejects(choose({ desktop: false }), /local desktop/)
  assert.equal(calls.length, 0)
  assert.equal(await choose({ desktop: true }), path)
  assert.equal(calls[0].defaultPath, '/home/fixture/.ssh')
  assert.deepEqual(calls[0].properties, ['openFile', 'showHiddenFiles'])
  result = { canceled: true, filePaths: [path] }; assert.equal(await choose({ desktop: true }), null)
  result = { canceled: false, filePaths: [] }; assert.equal(await choose({ desktop: true }), null)
})

test('desktop IPC preserves safe machine error codes and hides unexpected exception details', async () => {
  const handlers = new Map()
  let error = new m.MachinesFailure('bridge_admin_key_rejected', 'The server rejected the administrator key.')
  m.registerMachinesIpc({ handle(channel, fn) { handlers.set(channel, fn) } }, { state() { throw error } }, () => true)
  await assert.rejects(handlers.get('machines:state')({}), { message: '[bridge_admin_key_rejected] The server rejected the administrator key.' })
  error = new Error('private unexpected exception')
  await assert.rejects(handlers.get('machines:state')({}), { message: 'The machine operation could not be completed.' })
})

test('confirmation options survive preload and desktop IPC forwarding', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'drover-preload-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  await build({ entryPoints: ['src/preload/index.ts'], outfile: join(dir, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], alias: { '@shared': resolve('src/shared') }, logLevel: 'silent' })
  mkdirSync(join(dir, 'node_modules/electron'), { recursive: true })
  writeFileSync(join(dir, 'node_modules/electron/index.js'), `module.exports={contextBridge:{exposeInMainWorld(name,api){globalThis.__droverPreloadTest=api}},ipcRenderer:{invoke(...args){globalThis.__droverPreloadCalls.push(args);return Promise.resolve()},on(){},removeListener(){}},webUtils:{}}`)
  globalThis.__droverPreloadCalls = []
  t.after(() => { delete globalThis.__droverPreloadTest; delete globalThis.__droverPreloadCalls })
  createRequire(import.meta.url)(join(dir, 'preload.cjs'))
  const api = globalThis.__droverPreloadTest.machines, confirmed = { confirmed: true }, setup = { caddy: false, confirmed: true }
  await api.remove('machine', confirmed); await api.setBridge('machine', confirmed); await api.revokeAgentsKey(confirmed); await api.setupBridge('machine', setup)
  assert.deepEqual(globalThis.__droverPreloadCalls, [['machines:remove', 'machine', confirmed], ['machines:set-bridge', 'machine', confirmed], ['machines:revoke-key', confirmed], ['machines:setup-bridge', 'machine', setup]])
  const calls = [], handlers = new Map(), service = Object.fromEntries(['remove', 'setBridge', 'revokeAgentsKey', 'setupBridge'].map(method => [method, (...args) => calls.push([method, ...args])]))
  m.registerMachinesIpc({ handle(channel, fn) { handlers.set(channel, fn) } }, service, () => true)
  for (const [channel, ...args] of globalThis.__droverPreloadCalls) await handlers.get(channel)({}, ...args)
  assert.deepEqual(calls, [['remove', 'machine', confirmed], ['setBridge', 'machine', confirmed], ['revokeAgentsKey', confirmed], ['setupBridge', 'machine', setup]])
  await api.chooseBridgeKeyFile()
  assert.deepEqual(globalThis.__droverPreloadCalls.at(-1), ['machines:choose-bridge-key-file'])
  const adopt = { acceptedFingerprint: 'fingerprint', user: 'root', keyPath: '/home/fixture/.ssh/admin_ed25519' }
  await api.adoptExistingBridge(adopt)
  assert.deepEqual(globalThis.__droverPreloadCalls.at(-1), ['machines:adopt-existing-bridge', adopt])
  await api.probeHostKey('example.invalid', 22, 'admin')
  const probe = globalThis.__droverPreloadCalls.at(-1)
  assert.deepEqual(probe, ['machines:probe-host-key', 'example.invalid', 22, 'admin'])
  const probes = [], probeHandlers = new Map()
  m.registerMachinesIpc({ handle(channel, fn) { probeHandlers.set(channel, fn) } }, { probeHostKey: (...args) => probes.push(args) }, () => true)
  await probeHandlers.get(probe[0])({}, ...probe.slice(1))
  assert.deepEqual(probes, [['example.invalid', 22, 'admin']])
})
test('subprocess fake ssh enforces private config arguments and redacts failed password output', async t => {
  const f = fixture(t)
  const fake = join(f.dir, 'ssh')
  writeFileSync(fake, `#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2);
if(args[0]!=='-F'||!fs.readFileSync(args[1],'utf8').includes('StrictHostKeyChecking yes'))process.exit(2);
if(args.includes('BatchMode=no')) {
 const cp=require('node:child_process').spawn(process.env.SSH_ASKPASS,[],{env:process.env});let secret='';
 cp.stdout.on('data',b=>secret+=b);cp.on('close',()=>{process.stderr.write('Permission denied '+secret);process.exit(255)});
} else process.stdout.write('os=Linux\\nlabel=Debian\\ndisk=1\\n');
`, { mode: 0o700 })
  const fallback = f.service.run
  f.service.run = (file, args, options) => file === 'ssh' ? m.runCommand(fake, args, options) : fallback(file, args, options)
  const machine = await f.direct('vps')
  await assert.rejects(f.connect(machine), error => /password was rejected/.test(error.message) && !error.message.includes('temporary-password'))
  assert.doesNotMatch(readFileSync(join(f.userData, 'machines.json'), 'utf8'), /temporary-password/)
})

test('issued installer is tracked before target trust and key revoke keeps unconfirmed cleanup pending', async t => {
  const f = fixture(t), b = await f.direct('bridge'); await f.connect(b); await f.service.setupBridge(b.id, { caddy: false, confirmed: true }); await f.service.setBridge(b.id, { confirmed: true })
  const target = await f.service.add({ kind: 'bridged', name: 'home', os: 'linux' })
  await f.service.installCommand(target.id, 'linux')
  assert.ok(JSON.parse(readFileSync(join(f.userData, 'machines.json'))).issuedInstallers.includes(target.id))
  f.managementFailure = true
  await f.service.revokeAgentsKey({ confirmed: true })
  assert.equal((await f.service.state()).machines.find(m => m.id === target.id).status.error.code, 'revocation_pending')
})


test('saved herdr import deduplicates endpoints and never configures or connects imported machines', async t => {
  const rows = [
    { id:'saved-a',label:'fixture-one',host:'10.8.0.21',port:22,user:'drover',target:'drover@10.8.0.21',session:'fixture',enabled:true },
    { id:'saved-b',label:'fixture-two',host:'10.8.0.22',port:22,user:'drover',target:'drover@10.8.0.22',session:'fixture',enabled:true },
    { id:'saved-c',label:'fixture-three',host:'10.8.0.23',port:22,user:'drover',target:'drover@10.8.0.23',session:'fixture',enabled:true }
  ]
  const writes=[], registry={ list:async()=>rows, statuses:async()=>rows.map(r=>({id:r.id,status:'reachable'})), snapshot:async()=>({version:'fixture',workspaces:[],panes:[],agents:[]}), workspaces:()=>[], add:async(...args)=>{writes.push(args);throw Error('not allowed')}, update:async(...args)=>writes.push(args), rename:async(...args)=>writes.push(args) }
  const f=fixture(t,{herdr:registry})
  const local=await f.service.add({name:'local',firstRoute:'lan',host:rows[0].host,user:'drover'})
  let state=await f.service.state()
  assert.equal(state.machines.length,3)
  assert.equal(state.machines.find(r=>r.herdrId==='saved-a').id,local.id)
  assert.deepEqual(state.machines.filter(r=>r.origin==='herdr').map(r=>r.status.state),['online','online'])
  assert.ok(state.machines.filter(r=>r.origin==='herdr').every(r=>r.status.error.code==='key_not_installed'))
  assert.equal(writes.length,0)
  const before=f.calls.length
  await f.service.check(state.machines.find(r=>r.origin==='herdr').id)
  assert.equal(f.calls.length,before)
  await assert.rejects(f.service.startHerdrAgent({machineId:'saved-b',agent:'codex'}),{code:'key_not_installed'})
  await assert.rejects(f.service.syncHerdr({confirmed:'true'}),{code:'confirmation_required'})
  const imported=state.machines.find(r=>r.herdrId==='saved-c')
  registry.update=async(action,id)=>{writes.push([action,id]);if(action==='remove') rows.splice(rows.findIndex(r=>r.id===id),1)}
  await f.service.remove(imported.id,{confirmed:true})
  state=await f.service.state();assert.equal(state.machines.length,2)
  assert.deepEqual(writes,[['remove','saved-c']])
})

test('internal herdr SSH retains Drover scoped aliases despite a later herdr config', async t => {
  const f = fixture(t), machine = await f.direct('scoped-herdr'), project = join(f.dir, 'chosen')
  await f.service.setPermissions(machine.id, { mode: 'projects', projects: [project] })
  const configPath = join(f.service.root, 'herdr_ssh_config'), calls = []
  const registry = new m.HerdrMachineRegistry({ root: f.service.root, userData: f.userData, configPath, env: () => ({ PATH: '/usr/bin:/bin' }), binary: () => 'fake-herdr', run: async (file, args, options) => { calls.push({ file, args, options }); return { code: 0, stdout: '[]', stderr: '' } } })
  await registry.list()
  assert.equal(calls[0].options.env.PATH.split(':')[0], join(f.service.root, 'herdr-bin'))
  assert.equal(calls[0].options.env.SSH_ASKPASS_REQUIRE, 'never')
  const foreign = join(f.dir, "herdr's config")
  writeFileSync(foreign, `Host ${machine.alias}\n  HostName wrong.invalid\n  User wrong\n`)
  const shim = join(f.service.root, 'herdr-bin/ssh')
  for (const override of [['-F', foreign], ['-F' + foreign]]) {
    const actual = execFileSync(shim, [...override, '-o', 'ControlMaster=no', '-T', '-G', machine.alias], { encoding: 'utf8' })
    assert.match(actual, /^hostname 203\.0\.113\.5$/m)
    assert.match(actual, /^user root$/m)
    assert.match(actual, /^stricthostkeychecking true$/m)
    assert.match(actual, /^batchmode yes$/m)
    assert.match(actual, /^identityfile .*agents_ed25519$/m)
    assert.doesNotMatch(actual, /management_ed25519|wrong\.invalid/)
  }
  const fakeSsh = join(f.dir, 'fake-ssh'), fakeShim = join(f.dir, 'fake-shim'), command = 'tool -F "keep this remote flag"'
  writeFileSync(fakeSsh, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 })
  writeFileSync(fakeShim, readFileSync(shim, 'utf8').replace('exec /usr/bin/ssh', 'exec ' + m.quote(fakeSsh)), { mode: 0o700 })
  const retained = execFileSync(fakeShim, ['-F', foreign, '-o', 'ControlPath=/tmp/herdr socket', '-T', machine.alias, command, '-F', 'remote-file'], { encoding: 'utf8' }).trim().split('\n')
  assert.deepEqual(retained.slice(8), ['-o', 'ControlPath=/tmp/herdr socket', '-T', machine.alias, command, '-F', 'remote-file'])
  assert.doesNotMatch(readFileSync(f.service.configPath, 'utf8'), new RegExp(`Host ${machine.alias}\\n`))
  const terminal = await registry.remoteTerminalCommand({ target: machine.alias, session: 'fixture' })
  assert.ok(terminal.includes(join(f.service.root, 'herdr-bin')))
  assert.ok(terminal.includes(`--remote '${machine.alias}'`))
})

test('three imported machines connect with known-host confirmation, additive login keys and selected-project aliases', async t => {
  const rows = [56, 72, 57].map((last, index) => ({ id: 'saved-' + index, label: 'fixture-' + index, host: '10.8.0.' + last, port: 22, user: 'drover', target: 'drover@10.8.0.' + last, session: 'fixture', enabled: true }))
  const writes = [], probes = [], registry = {
    list: async () => structuredClone(rows),
    statuses: async ids => { probes.push([...ids]); return ids.map(id => ({ id, status: 'reachable' })) },
    snapshot: async () => ({ workspaces: [], panes: [], agents: [] }), workspaces: () => [],
    add: async (target, label, session) => { writes.push(['add', target]); const profile = { id: 'scoped-' + label, label, target, session, enabled: true, ...m.parseHerdrTarget(target) }; rows.push(profile); return profile },
    update: async (action, id) => { writes.push([action, id]); if (action === 'remove') rows.splice(rows.findIndex(p => p.id === id), 1) },
    rename: async () => { throw Error('Already named correctly') }
  }
  const f = fixture(t, { herdr: registry }), ssh = join(f.home, '.ssh'), selected = join(f.dir, 'chosen'), other = join(f.dir, 'other')
  mkdirSync(ssh)
  const originals = structuredClone(rows), accounts = new Map()
  const foreign = `# Existing user key, preserve bytes\r\ncommand="echo hello world" ${publicKey(2)}\r\n${publicKey(3).replace('drover-test', 'drover-agents')}\n`
  for (const profile of originals) {
    const key = join(ssh, 'id_' + profile.host.replaceAll('.', '_'))
    writeFileSync(key, 'PRIVATE LOGIN MUST NEVER BE READ', { mode: 0o600 }); writeFileSync(key + '.pub', publicKey(4))
    const account = join(f.dir, profile.id); mkdirSync(join(account, '.ssh'), { recursive: true }); writeFileSync(join(account, '.ssh/authorized_keys'), foreign)
    accounts.set(profile.host, account)
  }
  writeFileSync(join(ssh, 'known_hosts'), originals.map(p => `${p.host} ssh-ed25519 ${blob(7)}`).join('\n') + '\n', { mode: 0o644 })
  const runner = f.service.run
  f.service.run = async (file, args, options = {}) => {
    if (file === 'ssh-keygen' && args.includes('-F')) return { code: 0, stdout: `${args[args.indexOf('-F') + 1]} ssh-ed25519 ${blob(7)}\n`, stderr: '' }
    if (file === 'ssh' && options.input?.includes('drover-auth.')) {
      const host = args.at(-2).startsWith('drover-') ? readFileSync(f.service.controlConfig, 'utf8').split(`Host ${args.at(-2)}\n`)[1].match(/HostName (\S+)/)[1] : args.at(-2)
      execFileSync('/bin/sh', ['-s'], { input: options.input, env: { PATH: '/usr/bin:/bin', HOME: accounts.get(host) } })
    }
    return runner(file, args, options)
  }
  let state = await f.service.state()
  assert.equal(state.machines.length, 3)
  assert.ok(state.machines.every(p => p.status.state === 'online' && p.status.checks.tcp && p.status.error.code === 'key_not_installed'))
  assert.deepEqual(writes, []); assert.deepEqual(probes, [])
  assert.deepEqual(await f.service.projectMachinePolicy(selected), { configureRoles: ['lead', 'orchestrator', 'devops'] })
  await f.service.agentInstructions(selected); await f.service.agentInstructions(other)
  for (const imported of state.machines) {
    const probe = await f.service.probeHostKey(imported.host, 22, 'drover')
    assert.equal(probe.known, true)
    const [best] = await f.service.loginKeyCandidates(imported.host)
    assert.equal(best.name, 'id_' + imported.host.replaceAll('.', '_'))
    await assert.rejects(f.service.installKey(imported.id, { keyPath: best.path }), { code: 'host_key_unconfirmed' })
    assert.equal(readFileSync(join(accounts.get(imported.host), '.ssh/authorized_keys'), 'utf8'), foreign)
    await f.service.installKey(imported.id, { keyPath: best.path, acceptedFingerprint: probe.fingerprint })
    await f.service.setPermissions(imported.id, { mode: 'projects', projects: [selected] })
    assert.ok(readFileSync(join(accounts.get(imported.host), '.ssh/authorized_keys'), 'utf8').startsWith(foreign))
  }
  const before = structuredClone(writes)
  await f.service.syncHerdr({ confirmed: true }); await f.service.state(); await f.service.herdrMachines()
  assert.deepEqual(writes, before)
  assert.equal(writes.filter(w => w[0] === 'add').length, 3)
  state = await f.service.state(); assert.equal(state.machines.length, 3)
  const chosenGuide = (await f.service.agentInstructions(selected)).match(/read (.+?\.md)\./)[1], otherGuide = (await f.service.agentInstructions(other)).match(/read (.+?\.md)\./)[1]
  for (const imported of state.machines) {
    assert.match(readFileSync(chosenGuide, 'utf8'), new RegExp(imported.alias))
    assert.match(readFileSync(chosenGuide + '.ssh_config', 'utf8'), new RegExp(`Host ${imported.alias}\\n`))
    for (const file of [otherGuide, otherGuide + '.ssh_config', f.service.configPath, join(f.service.root, 'MACHINES.md')]) assert.doesNotMatch(readFileSync(file, 'utf8'), new RegExp(imported.alias))
  }
  for (const call of f.calls.filter(c => c.args?.includes('-i'))) {
    assert.ok(call.args.includes('BatchMode=yes')); assert.ok(call.args.includes('StrictHostKeyChecking=yes'))
  }
  assert.equal(statSync(join(ssh, 'known_hosts')).mode & 0o777, 0o644)
  assert.doesNotMatch(readFileSync(join(f.userData, 'machines.json'), 'utf8'), /PRIVATE LOGIN|temporary-password|id_10_/)
})

test('one machine retains LAN login and falls back through bridge, then returns to LAN', async t => {
  let failLan=false;const probes=[]
  const f=fixture(t,{tcp:async(host,port,timeout)=>{probes.push({host,port,timeout});if(failLan&&host==='10.8.0.40')throw new m.MachinesFailure('timeout','LAN unavailable');return 4}})
  const b=await f.direct('bridge');await f.connect(b);await f.service.setupBridge(b.id,{confirmed:true,caddy:false});await f.service.setBridge(b.id,{confirmed:true})
  const home=await f.service.add({name:'home',firstRoute:'lan',host:'10.8.0.40',user:'drover',os:'linux'})
  await f.connect(home)
  await f.service.addRoute(home.id,{kind:'bridge',os:'linux'},{confirmed:true})
  assert.deepEqual((await f.service.state()).machines.find(r=>r.id===home.id).routes.map(r=>r.kind),['lan','bridge'])
  failLan=true
  const fallback=await f.service.check(home.id)
  assert.equal(fallback.activeRoute,'bridge');assert.equal(fallback.fallback,true)
  assert.equal(fallback.routes[0].state,'down')
  assert.match(readFileSync(f.service.configPath,'utf8'),new RegExp('Host drover-home\\n  HostName 127\\.0\\.0\\.1[\\s\\S]*User agent'))
  failLan=false
  const lan=await f.service.check(home.id)
  assert.equal(lan.activeRoute,'lan');assert.equal(lan.fallback,false)
  assert.match(readFileSync(f.service.configPath,'utf8'),/Host drover-home\n  HostName 10\.8\.0\.40\n  Port 22\n  User drover/)
  assert.equal(probes.find(p=>p.host==='10.8.0.40').timeout,800)
  const before=f.calls.length
  await assert.rejects(f.service.removeRoute(home.id,'bridge',{confirmed:1}),{code:'confirmation_required'})
  assert.equal(f.calls.length,before)
  await f.service.removeRoute(home.id,'bridge',{confirmed:true})
  await assert.rejects(f.service.removeRoute(home.id,'lan',{confirmed:true}),{code:'last_route'})
})

test('key revocation visits both route logins and retains an unreachable login for retry after restart', async t => {
  const f = fixture(t), bridge = await f.direct('route-bridge')
  await f.connect(bridge); await f.service.setupBridge(bridge.id, { confirmed: true, caddy: false }); await f.service.setBridge(bridge.id, { confirmed: true })
  const home = await f.service.add({ name: 'two-logins', firstRoute: 'lan', host: '10.8.0.40', user: 'drover', os: 'linux' })
  await f.connect(home); await f.service.addRoute(home.id, { kind: 'bridge', os: 'linux' }, { confirmed: true })
  const old = (await f.service.state()).agentsKey.publicKey, runner = f.service.run, logins = []
  let bridgeOffline = true
  const run = async (file, args, options = {}) => {
    if (file === 'ssh' && args.includes(`drover-management-${home.id}`) && options.input?.includes('awk -v agent=')) {
      const login = readFileSync(f.service.controlConfig, 'utf8').split(`Host drover-management-${home.id}\n`)[1].match(/\n  User (\S+)/)[1]
      logins.push(login)
      if (login === 'agent' && bridgeOffline) return { code: 255, stdout: '', stderr: 'Connection timed out' }
      assert.equal(options.input.includes('DROVER_SESSION_CLEANUP'), login === 'agent')
    }
    return runner(file, args, options)
  }
  f.service.run = run
  const reports = await f.service.revokeAgentsKey({ confirmed: true })
  assert.deepEqual(logins, ['drover', 'agent'])
  assert.equal(reports.find(r => r.machineId === home.id).incomplete, true)
  assert.ok(JSON.parse(readFileSync(join(f.userData, 'machines.json'))).revocations[home.id].includes(old))
  assert.equal((await f.service.state()).machines.find(r => r.id === home.id).status.error.code, 'revocation_pending')
  f.service.dispose(); bridgeOffline = false; logins.length = 0
  const restarted = new m.MachinesService({ home: f.home, userData: f.userData, run, tcp: async () => 1, provisioner: { revokeBridgeKey: async () => {} } })
  t.after(() => restarted.dispose())
  const checked = await restarted.check(home.id)
  assert.deepEqual(logins, ['agent'], 'only the pending login is retried')
  assert.equal(JSON.parse(readFileSync(join(f.userData, 'machines.json'))).revocations[home.id], undefined)
  assert.equal(checked.sessionCleanup.last.incomplete, true, 'supplied-account sessions cannot be declared terminated')
  assert.equal(checked.sessionCleanup.last.terminated, 2)
  assert.equal(checked.activeRoute, 'lan')
})

test('route deletion revokes the departing login first and keeps failed cleanup retryable', async t => {
  const f = fixture(t), bridge = await f.direct('delete-bridge')
  await f.connect(bridge); await f.service.setupBridge(bridge.id, { confirmed: true, caddy: false }); await f.service.setBridge(bridge.id, { confirmed: true })
  const home = await f.service.add({ name: 'delete-login', firstRoute: 'lan', host: '10.8.0.41', user: 'drover', os: 'linux' })
  await f.connect(home); await f.service.addRoute(home.id, { kind: 'bridge', os: 'linux' }, { confirmed: true })
  const runner = f.service.run, events = []
  let offline = true
  f.service.run = async (file, args, options = {}) => {
    if (file === 'ssh' && args.includes(`drover-management-${home.id}`) && options.input?.includes('awk -v agent=')) {
      const block = readFileSync(f.service.controlConfig, 'utf8').split(`Host drover-management-${home.id}\n`)[1]
      assert.match(block, /\n  User agent\n/)
      events.push('revoke-login')
      if (offline) return { code: 255, stdout: '', stderr: 'Connection timed out' }
    }
    return runner(file, args, options)
  }
  f.service.provisioner.removeTargets = async () => { events.push('remove-tunnel') }
  await assert.rejects(f.service.removeRoute(home.id, 'bridge', { confirmed: true }), { code: 'timeout' })
  assert.deepEqual(events, ['revoke-login'])
  assert.deepEqual((await f.service.state()).machines.find(r => r.id === home.id).routes.map(r => r.user), ['drover', 'agent'])
  assert.equal(JSON.parse(readFileSync(join(f.userData, 'machines.json'))).machines.find(r => r.id === home.id).routes.length, 2)
  offline = false; events.length = 0
  await f.service.removeRoute(home.id, 'bridge', { confirmed: true })
  assert.deepEqual(events, ['revoke-login', 'remove-tunnel'])
  assert.deepEqual((await f.service.state()).machines.find(r => r.id === home.id).routes.map(r => r.user), ['drover'])
})

test('offline first LAN login does not prevent bridge revocation and only pending login retries', async t => {
  const f = fixture(t), bridge = await f.direct('offline-first-bridge')
  await f.connect(bridge); await f.service.setupBridge(bridge.id, { confirmed: true, caddy: false }); await f.service.setBridge(bridge.id, { confirmed: true })
  const home = await f.service.add({ name: 'offline-first', firstRoute: 'lan', host: '10.8.0.42', user: 'drover', os: 'linux' })
  await f.connect(home); await f.service.addRoute(home.id, { kind: 'bridge', os: 'linux' }, { confirmed: true })
  const runner = f.service.run, calls = [], attempts = [], old = (await f.service.state()).agentsKey.publicKey
  let offline = true
  const tcp = async host => { if (host === home.host) { attempts.push('lan'); if (offline) throw new m.MachinesFailure('timeout', 'LAN offline') } return 1 }
  const run = async (file, args, options = {}) => {
    if (file === 'ssh' && args.includes(`drover-management-${home.id}`) && options.input?.includes('awk -v agent=')) calls.push(readFileSync(f.service.controlConfig, 'utf8').split(`Host drover-management-${home.id}\n`)[1].match(/\n  User (\S+)/)[1])
    return runner(file, args, options)
  }
  f.service.tcp = tcp; f.service.run = run
  const reports = await f.service.revokeAgentsKey({ confirmed: true })
  assert.ok(attempts.length); assert.deepEqual(calls, ['agent'])
  assert.equal(reports.find(r => r.machineId === home.id).terminated, 2)
  const stored = JSON.parse(readFileSync(join(f.userData, 'machines.json')))
  assert.ok(stored.revocations[home.id].includes(old))
  assert.deepEqual(stored.keyRemovalProgress[home.id][0].completedLogins, ['agent'])
  f.service.dispose(); calls.length = 0; offline = false
  const restarted = new m.MachinesService({ home: f.home, userData: f.userData, run, tcp, provisioner: { revokeBridgeKey: async () => {} } })
  t.after(() => restarted.dispose())
  const checked = await restarted.check(home.id)
  assert.deepEqual(calls, ['drover'])
  assert.equal(checked.sessionCleanup.last.terminated, 2)
  assert.equal(checked.sessionCleanup.last.incomplete, true)
  const finished = JSON.parse(readFileSync(join(f.userData, 'machines.json')))
  assert.equal(finished.revocations[home.id], undefined); assert.equal(finished.keyRemovalProgress[home.id], undefined)
})

test('same login key revocation falls back after LAN SSH failure', async t => {
  const f = fixture(t), machine = await f.direct('same-login'); await f.connect(machine)
  const probe = await f.service.addRoute(machine.id, { kind: 'lan', host: '10.8.0.43' }, { confirmed: true })
  await f.service.addRoute(machine.id, { kind: 'lan', host: '10.8.0.43', acceptedFingerprint: probe.fingerprint }, { confirmed: true })
  const runner = f.service.run, hosts = []
  f.service.run = async (file, args, options = {}) => {
    if (file === 'ssh' && args.includes(`drover-management-${machine.id}`) && options.input?.includes('awk -v agent=')) {
      const host = readFileSync(f.service.controlConfig, 'utf8').split(`Host drover-management-${machine.id}\n`)[1].match(/HostName (\S+)/)[1]
      hosts.push(host)
      if (host === '10.8.0.43') return { code: 255, stdout: '', stderr: 'Connection timed out' }
    }
    return runner(file, args, options)
  }
  await f.service.revokeAgentsKey({ confirmed: true })
  assert.deepEqual(hosts, ['10.8.0.43', '203.0.113.5'])
  assert.equal(JSON.parse(readFileSync(join(f.userData, 'machines.json'))).revocations[machine.id].length, 0)
})

test('punctuated imported herdr labels keep safe stable aliases and original display labels across refresh and restart', async t => {
  const labels = ['!! Build Host', 'Build Host', '...', '😺', '-'.repeat(80), 'A'.repeat(100)]
  const rows = labels.map((label, index) => ({ id: 'label-' + index, label, host: '10.8.1.' + (index + 1), port: 22, user: 'drover', target: 'drover@10.8.1.' + (index + 1), session: 'fixture', enabled: true }))
  const registry = { list: async () => structuredClone(rows) }, f = fixture(t, { herdr: registry })
  const first = await f.service.state(), names = first.machines.map(m => m.name)
  assert.equal(new Set(names).size, rows.length)
  assert.ok(names.every(name => /^[a-z0-9][a-z0-9-]{0,30}$/.test(name)))
  assert.deepEqual(first.machines.map(m => m.herdrLabel), labels)
  assert.deepEqual((await f.service.state()).machines.map(m => m.name), names)
  f.service.dispose()
  const restarted = new m.MachinesService({ home: f.home, userData: f.userData, herdr: registry, run: async () => { throw Error('Imports must not connect') } })
  t.after(() => restarted.dispose())
  const next = await restarted.state()
  assert.deepEqual(next.machines.map(m => m.name), names)
  assert.deepEqual(next.machines.map(m => m.herdrLabel), labels)
  assert.deepEqual(next.machines.map(m => m.alias), names.map(name => 'drover-' + name))
})

test('route additions require a matching fresh fingerprint and purpose is metadata only', async t => {
  const f=fixture(t), machine=await f.direct('first');await f.connect(machine)
  const before=(await f.service.state()).machines[0].routes
  await f.service.setPurpose(machine.id,'Build host')
  const probe=await f.service.addRoute(machine.id,{kind:'lan',host:'10.8.0.50'},{confirmed:true})
  assert.equal(probe.algorithm,'ssh-ed25519')
  assert.deepEqual((await f.service.state()).machines[0].routes,before)
  f.scan=`fixture ssh-ed25519 ${blob(8)}`
  await assert.rejects(f.service.addRoute(machine.id,{kind:'lan',host:'10.8.0.50',acceptedFingerprint:probe.fingerprint},{confirmed:true}),{code:'host_key_changed'})
  f.scan=hostKey
  await f.service.addRoute(machine.id,{kind:'lan',host:'10.8.0.50',acceptedFingerprint:probe.fingerprint},{confirmed:true})
  const state=await f.service.state()
  assert.equal(state.machines[0].purpose,'Build host')
  assert.deepEqual(state.machines[0].routes.map(r=>r.kind),['lan','internet'])
})

test('home first LAN without host uses installer locally even when a bridge exists', async t => {
  const f=fixture(t),bridge=await f.direct('bridge');await f.connect(bridge);await f.service.setupBridge(bridge.id,{confirmed:true,caddy:false});await f.service.setBridge(bridge.id,{confirmed:true})
  const home=await f.service.add({name:'installer-home',firstRoute:'lan',os:'linux',alsoBridge:false})
  assert.deepEqual(home.routes.map(r=>r.kind),['lan']);assert.equal(home.routes[0].state,'setup')
  await f.service.installCommand(home.id,'linux')
  const ctx=f.calls.filter(c=>c.context).at(-1).context
  assert.equal(ctx.bridge,null)
  await ctx.onReport({machineId:home.id,os:'linux',state:'installed',hostKey:publicKey(7),lanHost:'10.8.0.60'})
  assert.equal((await f.service.state()).machines.find(r=>r.id===home.id).routes[0].host,'10.8.0.60')
})

test('key-only login bootstrap shows user known_hosts match but still requires explicit confirmation', async t => {
  const f=fixture(t),machine=await f.service.add({name:'imported',firstRoute:'lan',host:'10.8.0.70',user:'drover'})
  mkdirSync(join(f.home,'.ssh'));const known=join(f.home,'.ssh/known_hosts'),key=join(f.home,'.ssh/id_fixture')
  writeFileSync(known,`10.8.0.70 ssh-ed25519 ${blob(7)}\n`,{mode:0o644});writeFileSync(key,'not read by Drover',{mode:0o600})
  const base=f.service.run
  f.service.run=async(file,args,opts)=>file==='ssh-keygen'&&args.includes('-F')?{code:0,stdout:readFileSync(known,'utf8'),stderr:''}:base(file,args,opts)
  const probe=await f.service.probeHostKey(machine.host,22,'drover')
  assert.equal(probe.known,true);assert.equal(statSync(known).mode&0o777,0o644)
  await assert.rejects(f.service.installKey(machine.id,{keyPath:key}),{code:'host_key_unconfirmed'})
  await f.service.installKey(machine.id,{keyPath:key,acceptedFingerprint:probe.fingerprint})
  const login=f.calls.find(c=>c.args?.includes(key))
  assert.ok(login);assert.ok(login.args.includes('BatchMode=yes'));assert.ok(login.input.includes('drover-agents'))
  assert.doesNotMatch(readFileSync(join(f.userData,'machines.json'),'utf8'),/not read by Drover|id_fixture/)
})


test('helper checks the live bound role, native approval and incarnation before performing metadata changes', async t => {
  const f=fixture(t),machine=await f.direct('helper-host')
  let role=null,approve=true,agent={pane_id:'w1:p1',terminal_id:'fixture-terminal',agent:'codex',name:'devops',cwd:'/fixture',agent_session:{value:'fixture-incarnation'}}
  let confirmations=0
  const helper=new m.MachineHelper({root:f.service.root,runtime:process.execPath,session:()=> 'fixture',service:f.service,agent:async()=>agent,role:async()=>role,writable:()=>true,confirm:async()=>{confirmations++;return approve}})
  await helper.start();t.after(()=>helper.dispose())
  const config=JSON.parse(readFileSync(join(f.service.root,'helper/runtime.json'),'utf8'))
  const request={token:config.token,session:'fixture',paneId:'w1:p1',action:'set-purpose',args:[machine.id,'Build host'],role:'lead'}
  await assert.rejects(helper.dispatch(request),{code:'role_denied'});assert.equal(confirmations,0)
  role='devops';approve=false
  await assert.rejects(helper.dispatch(request),{code:'confirmation_required'})
  assert.equal((await f.service.state()).machines[0].purpose,undefined)
  approve=true;await helper.dispatch(request)
  assert.equal((await f.service.state()).machines[0].purpose,'Build host')
  helper.options.confirm=async()=>{agent={...agent,terminal_id:'replacement-terminal'};return true}
  await assert.rejects(helper.dispatch({...request,args:[machine.id,'Changed']}),{code:'unauthorized'})
  assert.equal((await f.service.state()).machines[0].purpose,'Build host')
})

test('office infrastructure projection includes routes, purpose, phones and remote agents without paths or secrets', t => {
  const office=new m.OfficeCollector({session:()=> 'fixture',snapshot:()=>null,settings:()=>({roles:[],projectLeads:{}})},()=>{})
  t.after(()=>office.dispose())
  office.onInfrastructure([{id:'fixture-id',name:'build-host',alias:'drover-build-host',purpose:'Build jobs',status:{state:'online'},activeRoute:'bridge',fallback:true,routes:[{kind:'lan',state:'down',host:'10.8.0.99',error:{detail:'/private/key'}},{kind:'bridge',state:'ok',latencyMs:18}]}],[{id:'phone',name:'My phone',lastSeenAt:1,online:true}],[{id:'saved',droverMachineId:'fixture-id',session:'fixture',workspaces:[{agents:[{paneId:'w1:p1',name:'builder',agent:'codex',status:'working',cwd:'/private/project'}]}]}])
  const state=office.getState(),node=state.externalNodes.find(n=>n.kind==='machine')
  assert.equal(node.purpose,'Build jobs');assert.equal(node.fallback,true);assert.equal(node.routes[1].latencyMs,18)
  assert.equal(node.remoteAgents[0].status,'working');assert.equal(state.externalNodes[0].phones[0].online,true)
  assert.doesNotMatch(JSON.stringify(state),/10\.8\.0\.99|private\/key|private\/project/)
})


test('unconnected imports probe every TCP route without SSH and retain resumable sign-in failures after pinning', async t => {
  const rows = [{id:'saved',label:'synthetic',host:'10.8.0.75',port:22,user:'drover',target:'drover@10.8.0.75',session:'fixture',enabled:true}]
  const probes = [], writes = []
  let reachable = true
  const registry = {list:async()=>rows,statuses:async()=>{throw Error('No auth probes')},snapshot:async()=>{throw Error('No remote reads')},workspaces:()=>[],add:async()=>{writes.push(1);throw Error('Not now')}}
  const f = fixture(t, {herdr:registry,tcp:async(host,port)=>{probes.push([host,port]);if (!reachable) throw new m.MachinesFailure('timeout','No TCP response');return 7}})
  let machine = (await f.service.state()).machines[0]
  assert.deepEqual(machine.status.checks,{tcp:true,auth:false}); assert.equal(machine.status.state,'online')
  assert.equal(machine.routes[0].state,'ok'); assert.equal(f.calls.length,0); assert.equal(writes.length,0)
  const stored = JSON.parse(readFileSync(join(f.userData,'machines.json'),'utf8'))
  stored.machines[0].routes.push({kind:'internet',host:'example.invalid',port:2222,user:'drover',state:'unknown'})
  writeFileSync(join(f.userData,'machines.json'),JSON.stringify(stored))
  // Restart against synthetic data only, verifying both routes are actually visited.
  await f.service.dispose()
  const restarted = new m.MachinesService({home:f.home,userData:f.userData,herdr:registry,run:async()=>{throw Error('SSH forbidden')},tcp:async(host,port)=>{probes.push([host,port]);throw new m.MachinesFailure('timeout','No TCP response')}})
  t.after(()=>restarted.dispose())
  machine = (await restarted.state()).machines[0]
  assert.equal(machine.status.state,'offline'); assert.deepEqual(machine.status.checks,{tcp:false,auth:false})
  assert.ok(probes.some(([host,port])=>host==='example.invalid'&&port===2222))
  await restarted.dispose()
  // Supplied key rejection happens after pinning and must be persisted, thrown and retryable.
  const g = fixture(t, {herdr:registry}); machine = (await g.service.state()).machines[0]
  mkdirSync(join(g.home,'.ssh')); const key = join(g.home,'.ssh','login'); writeFileSync(key,'synthetic-private-key')
  g.authFailure = 'Permission denied (publickey).'
  await assert.rejects(g.service.installKey(machine.id,{keyPath:key,acceptedFingerprint:m.fingerprint(hostKey)}),{code:'auth_failed'})
  machine = (await g.service.state()).machines[0]
  assert.ok(machine.hostKeyPinnedAt); assert.equal(machine.status.error.code,'key_not_installed'); assert.ok(machine.status.error.detail)
  assert.equal(JSON.parse(readFileSync(join(g.userData,'machines.json'),'utf8')).installed.includes(machine.id),false)
  g.authFailure = ''
  const done = await g.service.installKey(machine.id,{keyPath:key,acceptedFingerprint:m.fingerprint(hostKey)})
  assert.equal(done.status.checks.auth,true); assert.notEqual(done.status.error?.code,'key_not_installed')
})
