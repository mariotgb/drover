import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const bundle = mkdtempSync(join(tmpdir(), 'drover-machines-bundle-'))
await build({ stdin: { contents: `export * from './src/main/machines/service'; export * from './src/main/machines/ssh'; export * from './src/main/machines/permissions'; export * from './src/main/machines/sessions'; export * from './src/main/machines/awareness'; export * from './src/main/machines/launch'; export * from './src/main/machines/ipc';`, resolveDir: resolve('.'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: join(bundle, 'test.cjs'), alias: { '@shared': resolve('src/shared') }, loader: { '.sh': 'text', '.py': 'text', '.ps1': 'text' }, logLevel: 'silent' })
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
  assert.equal(f.calls.some(c => c.file === 'ssh'), false)
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
  await f.service.setupBridge(b.id, { caddy: false }); await f.service.setBridge(b.id)
  const cmd = await f.service.installCommand(target.id, 'linux')
  assert.equal(cmd.command, 'fake install command')
  const checked = await f.service.check(target.id)
  assert.equal(checked.status.error.code, 'host_key_unconfirmed')
  assert.equal(checked.status.checks.tcp, true)
  const probe = await f.service.probeHostKey(target.alias, target.bridgePort)
  const connected = await f.service.installKey(target.id, { acceptedFingerprint: probe.fingerprint })
  assert.equal(connected.status.checks.auth, true)
  assert.match(readFileSync(f.service.configPath, 'utf8'), /ProxyJump drover-jump-/)
  const next = await f.direct('next'); await f.connect(next); await f.service.setupBridge(next.id, { caddy: false }); await f.service.setBridge(next.id)
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
  await f.service.remove(target.id)
  assert.equal((await fetch(url + '/key')).status, 410)
  assert.equal((await fetch(url + '/script')).status, 410)
  assert.deepEqual((await f.service.state()).machines, [])
  const rejected = fixture(t, { provisioner: { revokeInstallers: async () => { throw new m.MachinesFailure('offline', 'Capability service offline.') } } })
  const other = await rejected.service.add({ kind: 'bridged', name: 'retain', os: 'linux' })
  await rejected.service.installCommand(other.id, 'linux')
  const before = rejected.calls.length
  await assert.rejects(rejected.service.remove(other.id), /Capability service offline/)
  assert.equal(rejected.calls.slice(before).some(c => c.file === 'ssh'), false)
  assert.equal((await rejected.service.state()).machines.length, 1)
  assert.ok(JSON.parse(readFileSync(join(rejected.userData, 'machines.json'))).issuedInstallers.includes(other.id))
})

test('active bridge removal revokes reachable target credentials before retirement and keeps offline cleanup across restart', async t => {
  const f = fixture(t), bridge = await f.direct('retire'); await f.connect(bridge)
  await f.service.setupBridge(bridge.id, { caddy: false }); await f.service.setBridge(bridge.id)
  const online = await f.service.add({ kind: 'bridged', name: 'reachable', os: 'linux' })
  const offline = await f.service.add({ kind: 'bridged', name: 'offline', os: 'linux' })
  await f.service.installCommand(online.id, 'linux'); await f.service.installCommand(offline.id, 'linux')
  const fallback = f.service.run
  f.service.run = (file, args, options) => file === 'ssh' && args.includes(`drover-management-${offline.id}`) ? Promise.resolve({ code: 255, stdout: '', stderr: 'Connection timed out' }) : fallback(file, args, options)
  const before = f.calls.length
  await f.service.remove(bridge.id)
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
    await f.connect(bridge); await f.service.setupBridge(bridge.id, { caddy: false }); await f.service.setBridge(bridge.id)
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
    await f.service.remove(bridge.id)
    assert.equal(targetManagementCalls, 1)
    const persisted = () => JSON.parse(readFileSync(join(f.userData, 'machines.json')))
    assert.equal(persisted().machines[0].host, undefined)
    assert.equal(persisted().machines[0].bridgeMachineId, undefined)
    assert.equal(persisted().credentialRemovals[target.id].bridgeMachineId, bridge.id)
    if (replacement) {
      const next = await f.direct('replacement'); await f.connect(next)
      await f.service.setupBridge(next.id, { caddy: false }); await f.service.setBridge(next.id)
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
  await f.service.setupBridge(bridge.id, { caddy: false }); await f.service.setBridge(bridge.id)
  const target = await f.service.add({ kind: 'bridged', name: 'restart-recover', os: 'linux' })
  await f.service.installCommand(target.id, 'linux')
  const run = f.service.run
  f.service.run = async (file, args, options) => {
    if (file === 'ssh' && args.includes(`drover-management-${target.id}`)) return { code: 255, stdout: '', stderr: 'Connection timed out' }
    return run(file, args, options)
  }
  await f.service.remove(bridge.id)
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
  await f.service.setupBridge(bridge.id, { caddy: false }); await f.service.setBridge(bridge.id)
  const target = await f.service.add({ kind: 'bridged', name: 'live-recovery', os: 'linux' })
  await f.service.installCommand(target.id, 'linux')
  const run = f.service.run
  f.service.run = (file, args, options) => file === 'ssh' && args.includes(`drover-management-${target.id}`) ? Promise.resolve({ code: 255, stdout: '', stderr: 'Connection timed out' }) : run(file, args, options)
  await f.service.remove(bridge.id)
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
  const b = await f.direct('keep'); await f.connect(b); await f.service.setupBridge(b.id, { caddy: false }); await f.service.setBridge(b.id)
  await f.service.bridgeCleanup.enqueue(b.id, [], (await f.service.state()).agentsKey.publicKey)
  await assert.rejects(f.service.remove(b.id), /Retirement failed/)
  assert.equal((await f.service.state()).bridgeMachineId, b.id)
  assert.equal((await f.service.state()).machines[0].bridgeSetup.cleanup.state, 'blocked')
  await f.service.check(b.id)
  assert.ok(JSON.parse(readFileSync(join(f.userData, 'machines.json'))).credentialRemovals[b.id])
  fails = false; await f.service.remove(b.id)
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
  const b = await f.direct('old'); await f.connect(b); await f.service.setupBridge(b.id, { caddy: false }); await f.service.setBridge(b.id)
  oldId = b.id
  const next = await f.direct('new'); await f.connect(next); await f.service.setupBridge(next.id, { caddy: false }); await f.service.setBridge(next.id)
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
  const reports = await f.service.revokeAgentsKey()
  assert.equal(reports[0].terminated, 2); assert.equal(reports[0].incomplete, false)
  const removed = await f.service.remove(target.id)
  assert.equal(removed.terminated, 2); assert.equal(removed.incomplete, false)
  const supplied = await f.direct('supplied'); await f.connect(supplied)
  await f.service.setPermissions(supplied.id, { mode: 'read-only', projects: [] })
  const warning = (await f.service.state()).machines[0].sessionCleanup
  assert.equal(warning.account, 'supplied'); assert.equal(warning.last.incomplete, true)
  assert.equal((await f.service.remove(supplied.id)).incomplete, true)
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
  await f.service.revokeAgentsKey()
  const state = await f.service.state()
  assert.notEqual(state.agentsKey.fingerprint, old.fingerprint)
  assert.equal(state.machines[0].status.error.code, 'revocation_pending')
  assert.equal(state.machines[0].needsReinstall, true)
  assert.doesNotMatch(readFileSync(f.service.configPath, 'utf8'), /Host drover-vps\n/)
  await assert.rejects(f.service.remove(machine.id), /did not answer/)
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
  const f = fixture(t), b = await f.direct('bridge'); await f.connect(b); await f.service.setupBridge(b.id, { caddy: false }); await f.service.setBridge(b.id)
  const target = await f.service.add({ kind: 'bridged', name: 'home', os: 'linux' })
  await f.service.installCommand(target.id, 'linux')
  assert.ok(JSON.parse(readFileSync(join(f.userData, 'machines.json'))).issuedInstallers.includes(target.id))
  f.managementFailure = true
  await f.service.revokeAgentsKey()
  assert.equal((await f.service.state()).machines.find(m => m.id === target.id).status.error.code, 'revocation_pending')
})
