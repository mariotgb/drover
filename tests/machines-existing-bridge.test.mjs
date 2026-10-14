import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, createHmac } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { createServer, request } from 'node:http'
import { once } from 'node:events'

const bundle = mkdtempSync(join(tmpdir(), 'drover-existing-bundle-'))
await build({ stdin: { contents: `export * from './src/main/machines/service'; export * from './src/main/machines/ssh'; export * from './src/main/machines/existing-bridge'; export * from './src/main/machines/provision'; export { bridgeStatus } from './src/renderer/src/machines'; export { RemoteServer } from './src/main/remote/server'; export { RpcHandlers } from './src/main/remote/rpc';`, resolveDir: resolve('.'), loader: 'ts' }, outfile: join(bundle, 'test.cjs'), bundle: true, platform: 'node', format: 'cjs', alias: { '@shared': resolve('src/shared') }, loader: { '.sh': 'text', '.py': 'text', '.ps1': 'text' }, logLevel: 'silent' })
globalThis.window ??= {}
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
  return { home, userData, adminPath, pins, plist, args, calls, run, service, progress, set running(v) { running = v }, set scan(v) { scan = v }, set verification(v) { verification = v }, set sshFail(v) { sshFail = v } }
}

test('split bridge jobs retain both routes and verify each process without SSH or restarts', async t => {
  const f = fixture(t), phonePlist = f.plist.replace('.plist', '.phone.plist')
  const machine = f.args.filter((_, i) => ![6, 7].includes(i))
  const phone = f.args.filter((_, i) => ![4, 5].includes(i))
  writeFileSync(phonePlist, '<plist fixture/>')
  let phoneRunning = true
  const run = async (file, args, options) => {
    if (file === 'plutil') return ok(JSON.stringify({ Label: args.at(-1) === phonePlist ? 'dev.drover.bridge.phone' : 'dev.drover.bridge', ProgramArguments: args.at(-1) === phonePlist ? phone : machine }))
    if (file === 'launchctl' && args.at(-1).endsWith('.phone')) return phoneRunning ? ok('state = running\npid = 234\n') : ok('state = waiting\n')
    return f.run(file, args, options)
  }
  const options = { home: f.home, userData: f.userData, run, env: {} }
  const found = await m.detectLocalBridge(options)
  assert.deepEqual(found.forwards.map(f => f.listenPort), [2222, 8780]); assert.equal(found.tunnelRunning, true)
  phoneRunning = false; assert.equal((await m.detectLocalBridge(options)).tunnelRunning, false)
  assert.equal(f.calls.some(c => c.file === 'ssh' || c.args[0] === 'bootstrap'), false)
})

test('incomplete tunnel recovery blocks discovery instead of claiming a surviving machine job is recovered service', async t => {
  const f = fixture(t)
  writeFileSync(f.plist.replace('.plist', '.plist.recovery.json'), '{"transaction":"synthetic-backup"}')
  await assert.rejects(f.service.detectExistingBridge(), { code: 'existing_bridge_invalid' })
  assert.equal(f.calls.length, 0, 'recovery marker blocks job inspection, bootstrap and SSH')
})

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

test('Found suggests ranked SSH key pairs using public metadata only, excluding transport keys and unsafe files', async t => {
  const f = fixture(t), ssh = join(f.home, '.ssh')
  rmSync(join(f.userData, 'bridge-admin.json'))
  const pair = (name, publicKey = key(9) + ' administrator@fixture') => {
    // Even an unreadable private file can be suggested: detection never opens it.
    writeFileSync(join(ssh, name), 'DO NOT READ PRIVATE CANDIDATE', { mode: 0o000 })
    writeFileSync(join(ssh, name + '.pub'), publicKey + '\n')
  }
  for (const name of ['id_ed25519', 'admin_ed25519', 'vps_ed25519', 'drover_admin_ed25519', host + '_admin_ed25519', host.replace(/\./g, '-') + '_root', 'config', 'known_hosts.old']) pair(name)
  for (const name of ['agents_ed25519', 'mac_bridge_ed25519', 'mac_jump_ed25519', 'drover-tunnel-old']) pair(name, key(10) + ' drover-agents')
  pair('orphan'); rmSync(join(ssh, 'orphan'))
  pair('private-only'); rmSync(join(ssh, 'private-only.pub'))
  pair('invalid', 'invalid public metadata')
  pair('public-link'); rmSync(join(ssh, 'public-link.pub')); symlinkSync(join(ssh, 'id_ed25519.pub'), join(ssh, 'public-link.pub'))
  pair('private-link'); rmSync(join(ssh, 'private-link')); symlinkSync(join(ssh, 'id_ed25519'), join(ssh, 'private-link'))
  pair('folder'); rmSync(join(ssh, 'folder')); mkdirSync(join(ssh, 'folder'))
  pair('renamed-transport', key(10) + ' drover-tunnel-fixture')
  const found = await f.service.detectExistingBridge()
  assert.equal(found.adminKey, false)
  const names = found.adminKeyCandidates.map(k => k.name)
  assert.deepEqual(new Set(names.slice(0, 2)), new Set([host + '_admin_ed25519', host.replace(/\./g, '-') + '_root']))
  assert.deepEqual(names.slice(2), ['drover_admin_ed25519', 'vps_ed25519', 'admin_ed25519', 'id_ed25519'])
  assert.deepEqual(found.adminKeyCandidates.find(k => k.name === 'id_ed25519'), { path: join(ssh, 'id_ed25519'), name: 'id_ed25519', algorithm: 'ssh-ed25519', fingerprint: m.fingerprint(key(9)), comment: 'administrator@fixture' })
  assert.ok(f.calls.every(c => ['plutil', 'launchctl'].includes(c.file)))
  assert.equal(existsSync(join(f.home, '.drover')), false)
  assert.doesNotMatch(JSON.stringify(found), /DO NOT READ|PRIVATE CANDIDATE/)
})

test('admin candidates exclude Linux transport and renamed copies by public identity, keeping genuine Drover admin names', async t => {
  const f = fixture(t), ssh = join(f.home, '.ssh')
  const pair = (name, seed, comment = 'administrator@fixture') => {
    writeFileSync(join(ssh, name), 'DO NOT OPEN PRIVATE FILE', { mode: 0o000 })
    writeFileSync(join(ssh, name + '.pub'), key(seed) + ' ' + comment + '\n')
  }
  pair('drover_bridge_ed25519', 11, 'drover-bridge')
  pair('drover_jump_ed25519', 12, 'drover-bridge')
  pair('renamed-linux-bridge', 11, 'changed comment')
  pair('renamed-linux-jump', 12, 'changed comment')
  pair('transport-custom-name', 13, 'drover-bridge')
  pair('renamed-comment-transport', 13, 'changed comment')
  pair('drover_admin_ed25519', 14, 'administrator@fixture')
  pair('management-copy', 15, 'changed comment')
  const managed = join(f.home, '.drover/machines/keys')
  mkdirSync(managed, { recursive: true })
  // A recorded .pub is enough to exclude copies: the private file need not be read or present.
  writeFileSync(join(managed, 'management_ed25519.pub'), key(15) + ' drover-management_ed25519')
  const config = join(f.home, 'custom-config')
  mkdirSync(join(config, 'drover'), { recursive: true })
  const transport = join(f.home, 'custom-transport')
  writeFileSync(transport + '.pub', key(16) + ' renamed metadata')
  writeFileSync(join(config, 'drover/bridge.json'), JSON.stringify({ version: 1, service: 'dev.drover.bridge.service', identityFile: transport }))
  pair('metadata-copy', 16, 'changed comment')
  const found = await m.detectLocalBridge({ home: f.home, userData: f.userData, env: { XDG_CONFIG_HOME: config }, run: async file => file === 'plutil' ? ok(JSON.stringify({ Label: 'dev.drover.bridge', ProgramArguments: f.args })) : ok('') })
  assert.deepEqual(found.adminKeyCandidates.map(k => k.name), ['drover_admin_ed25519'])
  assert.doesNotMatch(JSON.stringify(found), /DO NOT OPEN PRIVATE/)
})

test('saved generated public identities and transport references exclude renamed keys after restarting detection', async t => {
  const f = fixture(t), savedMachine = await f.service.add({ kind: 'direct', name: 'old', host, port, user: 'root' })
  const stateFile = join(f.userData, 'machines.json'), saved = JSON.parse(readFileSync(stateFile, 'utf8'))
  const pair = (name, publicKey) => {
    writeFileSync(join(f.home, '.ssh', name), 'DO NOT OPEN PRIVATE', { mode: 0o000 })
    writeFileSync(join(f.home, '.ssh', name + '.pub'), publicKey.split(' ').slice(0, 2).join(' ') + ' changed-comment')
  }
  pair('generated-agents-copy', saved.agentsKey.publicKey)
  saved.revocations[savedMachine.id] = [key(41) + ' old-key']
  pair('revoked-copy', key(41))
  saved.credentialRemovals[savedMachine.id] = { agentsPublicKeys: [key(42)], managementPublicKey: key(43) }
  pair('removal-agents-copy', key(42)); pair('removal-management-copy', key(43))
  const jump = join(f.home, 'recorded-jump')
  writeFileSync(jump + '.pub', key(44)); pair('jump-copy', key(44))
  saved.bridgeConnections = { [savedMachine.id]: { source: 'existing', jumpKeyPath: jump, jumpUser: 'jump', tunnelUser: 'bridge-mac', forwards: [], macTunnel: 'missing' } }
  pair('drover_admin_ed25519', key(45))
  writeFileSync(stateFile, JSON.stringify(saved))
  rmSync(join(f.home, '.drover/machines/keys'), { recursive: true })
  const restarted = new m.MachinesService({ home: f.home, userData: f.userData, run: async file => file === 'plutil' ? ok(JSON.stringify({ Label: 'dev.drover.bridge', ProgramArguments: f.args })) : file === 'launchctl' ? ok('') : assert.fail('Detection must not contact SSH or generate keys'), tcp: async () => assert.fail('No TCP') })
  t.after(() => restarted.dispose())
  const found = await restarted.detectExistingBridge()
  assert.deepEqual(found.adminKeyCandidates.map(k => k.name), ['drover_admin_ed25519'])
  assert.equal(existsSync(join(f.home, '.drover/machines/keys')), false)
})

test('existing admin key mode pins before key-only authentication, persists a private reference, and adopts without installing keys', async t => {
  const f = fixture(t)
  rmSync(join(f.userData, 'bridge-admin.json'))
  const options = { acceptedFingerprint: m.fingerprint(hostKey), user: 'root', keyPath: f.adminPath }
  let adopted = await f.service.adoptExistingBridge({ ...options, acceptedFingerprint: m.fingerprint(`[${host}]:${port} ${key(8)}`) })
  assert.equal(adopted.steps[0].error.code, 'host_key_changed'); assert.equal(f.calls.some(c => c.file === 'ssh'), false)
  adopted = await f.service.adoptExistingBridge(options)
  assert.ok(adopted.steps.every(s => s.state === 'done'), JSON.stringify(adopted))
  const commands = f.calls.filter(c => c.file === 'ssh'), auth = commands[0]
  assert.equal(commands.length, 2)
  assert.deepEqual(auth.args.slice(0, 2), ['-F', '/dev/null'])
  for (const option of ['BatchMode=yes', 'IdentitiesOnly=yes', 'StrictHostKeyChecking=yes', 'PreferredAuthentications=publickey', 'PasswordAuthentication=no', 'KbdInteractiveAuthentication=no']) assert.ok(auth.args.includes(option), option)
  assert.equal(auth.args[auth.args.indexOf('-i') + 1], f.adminPath)
  assert.equal(auth.args[auth.args.indexOf('-l') + 1], 'root')
  assert.deepEqual(auth.args.slice(-2), [host, 'true'])
  assert.equal(auth.input, undefined); assert.equal(auth.env.SSH_ASKPASS, undefined)
  const pinPath = auth.args.find(a => a.startsWith('UserKnownHostsFile=')).slice('UserKnownHostsFile='.length)
  assert.equal(m.fingerprint(readFileSync(pinPath, 'utf8')), options.acceptedFingerprint)
  const metadata = join(f.userData, 'bridge-admin.json')
  assert.deepEqual(JSON.parse(readFileSync(metadata, 'utf8')), { host, port, user: 'root', keyPath: f.adminPath })
  assert.equal(statSync(metadata).mode & 0o777, 0o600)
  assert.equal((await f.service.detectExistingBridge()).adminKey, true)
  assert.equal((await f.service.state()).bridgeMachineId, adopted.machineId)
  assert.ok(!f.calls.some(c => c.args.includes('BatchMode=no') || c.input?.includes('authorized_keys')))
  assert.doesNotMatch(readFileSync(f.service.configPath, 'utf8'), /admin_ed25519|User root/)
  const control = readFileSync(join(f.home, '.drover/machines/ssh_control_config'), 'utf8')
  assert.match(control, /admin_ed25519/); assert.match(control, /IdentitiesOnly yes/); assert.doesNotMatch(control.split(/(?=^Host )/m).find(b => b.startsWith(`Host drover-management-${adopted.machineId}\n`)), /IdentityAgent none/)
  await f.service.remove(adopted.machineId, { confirmed: true })
  assert.equal(f.calls.filter(c => c.file === 'ssh').length, 2)
})

test('selected administrator keys fail clearly without saving a rejected or unreadable key reference', async t => {
  for (const [stderr, code] of [
    ['Permission denied (publickey). confidential failure', 'bridge_admin_key_rejected'],
    ['Load key "secret-path": incorrect passphrase supplied to decrypt private key', 'bridge_admin_key_unreadable'],
    ['sign_and_send_pubkey: signing failed for ED25519 from agent: agent refused operation', 'bridge_admin_key_unreadable'],
    ['debug1: Server accepts key: secret-path\nPermission denied (publickey).', 'bridge_admin_key_unreadable'],
    ['Load key "secret-path": invalid format', 'bridge_admin_key_unreadable']
  ]) {
    const f = fixture(t, { overrideRun: (file, args) => file === 'ssh' && args.includes('-i') ? { code: 255, stdout: '', stderr } : undefined })
    rmSync(join(f.userData, 'bridge-admin.json'))
    const result = await f.service.adoptExistingBridge({ acceptedFingerprint: m.fingerprint(hostKey), user: 'root', keyPath: f.adminPath })
    assert.equal(result.steps[0].error.code, code)
    if (code === 'bridge_admin_key_unreadable') assert.match(result.steps[0].error.detail, /passphrase.*ssh-agent.*BatchMode/)
    assert.doesNotMatch(JSON.stringify(result), /secret-path|confidential failure/)
    assert.equal(existsSync(join(f.userData, 'bridge-admin.json')), false)
    const state = await f.service.state()
    assert.equal(state.bridgeMachineId, null); assert.equal(state.machines.length, 0)
    assert.equal(f.calls.filter(c => c.file === 'ssh').length, 1)
  }
  for (const keyPath of ['~/missing-key', 'relative-key', 'bad\nkey']) {
    const f = fixture(t); rmSync(join(f.userData, 'bridge-admin.json'))
    const result = await f.service.adoptExistingBridge({ acceptedFingerprint: m.fingerprint(hostKey), user: 'root', keyPath })
    assert.equal(result.steps[0].error.code, 'bridge_admin_key_unreadable')
    assert.equal(f.calls.some(c => c.file === 'ssh'), false)
  }
  const f = fixture(t)
  const result = await f.service.adoptExistingBridge({ acceptedFingerprint: m.fingerprint(hostKey), user: 'root', keyPath: f.adminPath, password: 'do-not-use' })
  assert.equal(result.steps[0].error.code, 'invalid_bridge_auth'); assert.equal(f.calls.some(c => c.file === 'ssh' || c.file === 'ssh-keyscan'), false)
})

test('rejected key login can be corrected on the next attempt without a stale saved administrator', async t => {
  const f = fixture(t, { overrideRun: (file, args) => file === 'ssh' && args.includes('-i') && args[args.indexOf('-l') + 1] !== 'root' ? { code: 255, stdout: '', stderr: 'Permission denied (publickey).' } : undefined })
  rmSync(join(f.userData, 'bridge-admin.json'))
  const options = { acceptedFingerprint: m.fingerprint(hostKey), keyPath: f.adminPath }
  const rejected = await f.service.adoptExistingBridge({ ...options, user: 'wrong' })
  assert.equal(rejected.steps[0].error.code, 'bridge_admin_key_rejected')
  assert.deepEqual((await f.service.state()).machines, [])
  const adopted = await f.service.adoptExistingBridge({ ...options, user: 'root' })
  assert.ok(adopted.steps.every(s => s.state === 'done'), JSON.stringify(adopted))
  assert.equal((await f.service.state()).machines[0].user, 'root')
})

test('host-key probe discovers server password policy without offering any credentials or altering trust', async t => {
  for (const [stderr, expected] of [['root@fixture: Permission denied (publickey).', false], ['Permission denied (publickey,password,keyboard-interactive).', true], ['Permission denied (keyboard-interactive).', false], ['Connection closed by fixture', undefined]]) {
    const f = fixture(t, { overrideRun: (file, args) => {
      if (file !== 'ssh' || !args.includes('PreferredAuthentications=none')) return
      const pins = args.find(a => a.startsWith('UserKnownHostsFile=')).slice('UserKnownHostsFile='.length)
      assert.equal(m.fingerprint(readFileSync(pins, 'utf8')), m.fingerprint(hostKey))
      return { code: 255, stdout: '', stderr }
    } })
    const probe = await f.service.probeHostKey(host, port)
    assert.equal(probe.passwordAllowed, expected); assert.equal(probe.known, false)
    const auth = f.calls.find(c => c.file === 'ssh')
    for (const option of ['PreferredAuthentications=none', 'PubkeyAuthentication=no', 'IdentityAgent=none', 'IdentityFile=none', 'BatchMode=yes', 'StrictHostKeyChecking=yes']) assert.ok(auth.args.includes(option), option)
    assert.ok(!auth.args.includes('-i')); assert.ok(!auth.env.SSH_ASKPASS)
    assert.equal(existsSync(auth.args.find(a => a.startsWith('UserKnownHostsFile=')).slice('UserKnownHostsFile='.length)), false)
    assert.equal(existsSync(f.service.knownHosts), false)
  }
  const f = fixture(t, { overrideRun: file => file === 'ssh' ? { code: 255, stdout: '', stderr: 'Host key verification failed.' } : undefined })
  await assert.rejects(f.service.probeHostKey(host, port), { code: 'host_key_changed' })
})

test('password probe follows the supplied login and rejects malformed users before any SSH or persistence', async t => {
  const f = fixture(t, { overrideRun: (file, args) => {
    if (file !== 'ssh' || !args.includes('PreferredAuthentications=none')) return
    const login = args[args.indexOf('-l') + 1]
    return { code: 255, stdout: '', stderr: `Permission denied (${login === 'admin' ? 'publickey,password' : 'publickey'}).` }
  } })
  assert.equal((await f.service.probeHostKey(host, port, 'root')).passwordAllowed, false)
  assert.equal((await f.service.probeHostKey(host, port, 'admin')).passwordAllowed, true)
  assert.deepEqual(f.calls.filter(c => c.file === 'ssh').map(c => c.args[c.args.indexOf('-l') + 1]), ['root', 'admin'])
  for (const command of f.calls.filter(c => c.file === 'ssh')) {
    for (const option of ['PreferredAuthentications=none', 'PubkeyAuthentication=no', 'IdentityAgent=none', 'IdentityFile=none', 'PasswordAuthentication=no', 'KbdInteractiveAuthentication=no']) assert.ok(command.args.includes(option))
    assert.equal(command.input, undefined)
  }
  const g = fixture(t, { existing: false })
  for (const user of ['', 'has space', '-oProxyCommand=bad', 'root\nHost evil', null, 1]) await assert.rejects(g.service.probeHostKey(host, port, user), { code: 'invalid_user' })
  assert.equal(g.calls.length, 0); assert.equal(existsSync(join(g.home, '.drover')), false)
  assert.equal(existsSync(join(g.userData, 'machines.json')), false)
  await f.service.add({ kind: 'direct', name: 'saved', host, port, user: 'admin' })
  assert.equal((await f.service.probeHostKey(host, port)).passwordAllowed, true)
  assert.equal((await f.service.probeHostKey(host, port, 'root')).passwordAllowed, false)
})

test('host-key scan retries a transient broken pipe up to three attempts with backoff and a useful final error', async t => {
  let attempts = 0
  const f = fixture(t, { overrideRun: file => file === 'ssh-keyscan' && ++attempts < 3 ? { code: 1, stdout: '', stderr: 'write (fixture): Broken pipe' } : undefined })
  const start = performance.now(), probe = await f.service.probeHostKey(host, port)
  assert.equal(attempts, 3); assert.equal(probe.fingerprint, m.fingerprint(hostKey)); assert.ok(performance.now() - start >= 700)
  let failures = 0
  const g = fixture(t, { overrideRun: file => {
    if (file === 'ssh-keyscan') { failures++; throw new m.MachinesFailure('timeout', 'fake timeout') }
  } })
  await assert.rejects(g.service.probeHostKey(host, port), error => error.code === 'host_unreachable' && error.message.includes('The server may be briefly busy; try again in a minute.'))
  assert.equal(failures, 3); assert.equal(g.calls.some(c => c.file === 'ssh'), false)
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
  assert.match(readFileSync(join(f.home, '.drover/machines/MACHINES.md'), 'utf8'), /alias `drover-bridge`.*not connected yet/)
  assert.match(readFileSync(join(f.home, '.drover/machines/ssh_control_config'), 'utf8'), /admin_ed25519/)
  assert.doesNotMatch(JSON.stringify(state), /adminKeyPath|DO NOT READ/)
  const restarted = new m.MachinesService({ home: f.home, userData: f.userData, run: async () => { throw Error('No startup SSH') }, tcp: async () => 1 }); t.after(() => restarted.dispose())
  assert.equal((await restarted.state()).bridgeMachineId, r.machineId)
  await assert.rejects(f.service.setupBridge(r.machineId, { caddy: true, confirmed: true }), { code: 'bridge_repair_required' })
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

test('adopted bridge retains failed phone-site error in durable setup state', async t => {
  for (const issue of [
    { caddy: { configured: false, active: false }, missing: ['phone_route_missing'], code: 'phone_route_missing' },
    { caddy: { configured: true, active: false }, missing: ['phone_route_missing'], code: 'phone_route_missing' },
    { listeners: [2222], code: 'mac_tunnel_stopped' },
    { stopped: true, code: 'mac_tunnel_stopped' }
  ]) {
    const f = fixture(t); f.verification = { ...report(), ...issue }; if (issue.stopped) f.running = false
    const result = await f.service.adoptExistingBridge({ acceptedFingerprint: m.fingerprint(hostKey) })
    const saved = (await f.service.state()).machines.find(machine => machine.id === result.machineId)
    assert.equal(saved.bridgeSetup.error.code, issue.code)
    assert.equal(m.bridgeStatus(saved, { total: 0, online: 0 }).tone, 'bad')
    f.service.dispose()
    const restarted = new m.MachinesService({ home: f.home, userData: f.userData, run: f.run, tcp: async () => 1 })
    t.after(() => restarted.dispose())
    const reloaded = (await restarted.state()).machines.find(machine => machine.id === result.machineId)
    assert.equal(reloaded.bridgeSetup.error.code, issue.code)
    assert.equal(m.bridgeStatus(reloaded, { total: 0, online: 0 }).tone, 'bad')
  }
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

test('repair keeps an adopted stopped tunnel red until all post-repair checks pass', async t => {
  const f = fixture(t); f.running = false
  const adopted = await f.service.adoptExistingBridge({ acceptedFingerprint: m.fingerprint(hostKey) })
  const bridge = async service => (await service.state()).machines.find(machine => machine.id === adopted.machineId)
  const before = await bridge(f.service)
  assert.equal(before.bridgeSetup.error.code, 'mac_tunnel_stopped')
  assert.equal(m.bridgeStatus(before, { total: 0, online: 0 }).tone, 'bad')
  const repaired = await f.service.repairExistingBridge({ machineId: adopted.machineId, acceptedFingerprint: m.fingerprint(hostKey), confirmed: true })
  assert.equal(repaired.steps.find(step => step.step === 'mac_tunnel').error.code, 'mac_tunnel_stopped')
  const after = await bridge(f.service)
  assert.equal(after.bridgeSetup.state, 'failed')
  assert.equal(after.bridgeSetup.error.code, 'mac_tunnel_stopped')
  const card = m.bridgeStatus(after, { total: 0, online: 0 })
  assert.equal(card.tone, 'bad'); assert.match(card.text, /tunnel to the bridge is stopped/)
  f.service.dispose()
  const restarted = new m.MachinesService({ home: f.home, userData: f.userData, run: f.run, tcp: async () => 1 })
  t.after(() => restarted.dispose())
  assert.equal((await bridge(restarted)).bridgeSetup.error.code, 'mac_tunnel_stopped')
  assert.equal(m.bridgeStatus(await bridge(restarted), { total: 0, online: 0 }).tone, 'bad')
  f.running = true
  const recovered = await restarted.repairExistingBridge({ machineId: adopted.machineId, acceptedFingerprint: m.fingerprint(hostKey), confirmed: true })
  assert.ok(recovered.steps.every(step => step.state === 'done'), JSON.stringify(recovered))
  const working = await bridge(restarted)
  assert.equal(working.bridgeSetup.state, 'ready'); assert.equal(working.bridgeSetup.error, undefined)
  assert.equal(m.bridgeStatus(working, { total: 0, online: 0 }).tone, 'ok')
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
    assert.ok(readFileSync(join(f.home, '.drover/machines/MACHINES.md'), 'utf8').includes(`alias \`${bridge.alias}\``)); assert.match(readFileSync(join(f.home, '.drover/machines/MACHINES.md'), 'utf8'), /not connected yet/)
    await f.service.agentInstructions(join(f.home, 'project'))
    const stored = JSON.parse(readFileSync(join(f.home, '.drover/machines/projects.json'), 'utf8'))
    assert.equal(stored.length, 1)
    // Registered guides/configs also exclude the bridge, including advisory project scope.
    const path = join(f.home, '.drover/machines/projects', createHash('sha256').update(stored[0]).digest('hex') + '.md')
    assert.ok(readFileSync(path, 'utf8').includes(`alias \`${bridge.alias}\``)); assert.match(readFileSync(path, 'utf8'), /not connected yet/)
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


test('phone movement verifies route, keeps generated key restricted, and rolls back exact helper transaction on settings failure', async t => {
  const f=fixture(t),events=[]
  const adopted=await f.service.adoptExistingBridge({acceptedFingerprint:m.fingerprint(hostKey)})
  f.service.options.platform='darwin'
  let allowed = false
  f.service.options.phoneOriginTransition = async url => { assert.equal(url, publicUrl); events.push('origins'); allowed = true; return async committed => { events.push(committed ? 'commit-origin' : 'rollback-origin'); allowed = false } }
  const base=f.service.run
  f.service.run=async(file,args,options)=>{
    if(file==='python3'){
      const manifest=JSON.parse(readFileSync(args[1],'utf8'));events.push(manifest.action)
      assert.equal(options.timeoutMs,90000)
      if(manifest.action==='move-phone'){
        assert.equal(allowed, true, 'new Host must be allowed before helper verification')
        assert.equal(manifest.hostKeyAlias,`[${host}]:${port}`)
        assert.match(manifest.keyPath,/phone-tunnel-/)
        assert.equal(manifest.forwards[0].listenPort,8780)
        return ok('DROVER_MAC_BRIDGE_REPORT '+JSON.stringify({moved:true,verified:true,tunnelRunning:true,phoneTunnelRunning:true,missing:[],backupPath:'/synthetic/transaction'}))
      }
      return ok('DROVER_MAC_BRIDGE_REPORT '+JSON.stringify({recovered:true,moved:true,verified:true,tunnelRunning:true,phoneTunnelRunning:true,missing:[]}))
    }
    return base(file,args,options)
  }
  f.service.options.configurePhone=async()=>{events.push('settings');throw Error('synthetic save failure')}
  const before=f.calls.length
  await assert.rejects(f.service.movePhoneToBridge(adopted.machineId,{confirmed:'true'}),{code:'confirmation_required'})
  assert.equal(f.calls.length,before)
  await assert.rejects(f.service.movePhoneToBridge(adopted.machineId,{confirmed:true}),{code:'phone_settings_failed'})
  assert.deepEqual(events,['origins','move-phone','settings','rollback-phone','rollback-origin'])
  assert.equal(allowed, false)
  const grant=f.calls.find(c=>c.input?.includes('DROVER_PHONE_GRANT'))
  assert.match(grant.input,/restrict,port-forwarding,permitlisten="127\.0\.0\.1:8780"/)
  assert.doesNotMatch(grant.input,/sshd -t|systemctl|useradd/)
  events.length=0
  f.service.options.configurePhone=async()=>events.push('settings')
  await f.service.movePhoneToBridge(adopted.machineId,{confirmed:true})
  assert.deepEqual(events,['origins','move-phone','settings','finish-phone','commit-origin'])
  assert.equal(allowed, false)
})

test('phone helper probe reaches real Host guard before origin commit and both settings/tunnel roll back on finish failure', async t => {
  const f = fixture(t), adopted = await f.service.adoptExistingBridge({ acceptedFingerprint: m.fingerprint(hostKey) })
  const reserve = createServer().listen(0, '127.0.0.1'); await once(reserve, 'listening'); const port = reserve.address().port
  await new Promise(resolve => reserve.close(resolve))
  const webRoot = join(f.home, 'web'); mkdirSync(join(webRoot, 'auth'), { recursive: true }); writeFileSync(join(webRoot, 'auth/index.html'), 'synthetic phone page')
  const old = 'https://old.example.test'
  let settings = { remoteEnabled: true, remotePort: port, remotePublicUrl: old, remoteBehindProxy: true }
  const remote = new m.RemoteServer({ webRoot, userData: f.userData, handlers: new m.RpcHandlers(), settings: () => settings, saveSettings: next => { settings = next }, statusChanged: () => {} })
  t.after(() => remote.stop()); await remote.sync()
  const probe = host => new Promise((resolve, reject) => { const req = request({ host: '127.0.0.1', port, path: '/pair', headers: { Host: host } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)) }); req.on('error', reject); req.end() })
  assert.equal(await probe(new URL(publicUrl).host), 403)
  f.service.options.platform = 'darwin'
  f.service.options.phoneOriginTransition = async url => remote.beginPublicOriginMove(url)
  f.service.options.configurePhone = async url => { await remote.configure({ remotePublicUrl: url }) }
  const runner = f.service.run, actions = []
  let failFinish = true
  f.service.run = async (file, args, options) => {
    if (file !== 'python3') return runner(file, args, options)
    const manifest = JSON.parse(readFileSync(args[1], 'utf8')); actions.push(manifest.action)
    if (manifest.action === 'move-phone') { assert.equal(settings.remotePublicUrl, old); assert.equal(await probe(new URL(manifest.publicUrl).host), 200) }
    if (manifest.action === 'finish-phone') { assert.equal(await probe(new URL(old).host), 200); if (failFinish) return ok('DROVER_MAC_BRIDGE_REPORT ' + JSON.stringify({ verified: false, missing: ['transaction_cleanup_failed'] })) }
    return ok('DROVER_MAC_BRIDGE_REPORT ' + JSON.stringify({ moved: true, verified: true, recovered: true, phoneTunnelRunning: true, missing: [], backupPath: '/synthetic/transaction' }))
  }
  await assert.rejects(f.service.movePhoneToBridge(adopted.machineId, { confirmed: true }), { code: 'phone_recovery_incomplete' })
  assert.deepEqual(actions, ['move-phone', 'finish-phone', 'rollback-phone'])
  assert.equal(settings.remotePublicUrl, old); assert.equal(await probe(new URL(publicUrl).host), 403)
  failFinish = false; actions.length = 0
  await f.service.movePhoneToBridge(adopted.machineId, { confirmed: true })
  assert.deepEqual(actions, ['move-phone', 'finish-phone'])
  assert.equal(settings.remotePublicUrl, publicUrl); assert.equal(await probe(new URL(old).host), 403); assert.equal(await probe(new URL(publicUrl).host), 200)
})

test('phone key additive primitive preserves mixed newline foreign keys and unterminated final bytes', t => {
  const dir=mkdtempSync(join(tmpdir(),'drover-phone-grant-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const input=join(dir,'authorized_keys'),output=join(dir,'out')
  const foreign=`  ${key(3)} personal\r\nrestrict,command="printf foreign" ${key(4)} other\n# tail without newline`
  writeFileSync(input,foreign)
  const options='restrict,port-forwarding,permitlisten="127.0.0.1:8780"'
  execFileSync('python3',['remote/machines/bridge-data.py','additive-key',input,options,key(5),output])
  assert.equal(readFileSync(output,'utf8'),foreign+'\n'+options+' '+key(5)+' drover-machines\n')
  const original=readFileSync(output)
  execFileSync('python3',['remote/machines/bridge-data.py','additive-key',output,options,key(5),input])
  assert.deepEqual(readFileSync(input),original)
})

test('phone key grant extension preserves managed line endings and all foreign bytes', t => {
  const dir = mkdtempSync(join(tmpdir(), 'drover-phone-grant-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const input = join(dir, 'authorized_keys'), output = join(dir, 'out')
  const existing = 'restrict,port-forwarding,permitlisten="127.0.0.1:2222"'
  const addition = ',permitlisten="127.0.0.1:8780"', options = existing + addition
  const foreign = `  ${key(3)} personal\r\nrestrict,command="printf foreign" ${key(4)} other\n`
  for (const ending of ['\r\n', '\n', '']) {
    const tail = ending ? '# foreign tail without newline' : ''
    const original = Buffer.from(foreign + existing + '\t' + key(5) + ' managed comment' + ending + tail)
    const expected = Buffer.from(original.toString().replace(existing, options))
    writeFileSync(input, original)
    execFileSync('python3', ['remote/machines/bridge-data.py', 'additive-key', input, options, key(5), output])
    assert.deepEqual(readFileSync(input), original, 'input remains unchanged')
    assert.deepEqual(readFileSync(output), expected, 'only the missing grant is inserted')
    execFileSync('python3', ['remote/machines/bridge-data.py', 'additive-key', output, options, key(5), input])
    assert.deepEqual(readFileSync(input), expected, 'grant extension is byte-idempotent')
  }
})


test('bridge can explicitly connect agents as root while preserving tunnel users, hub policy and foreign keys', async t => {
  let rootHome, enabled = false
  const f = fixture(t, {overrideRun:async(file,args,options)=>{
    if (!enabled || file!=='ssh' || !options.input?.includes('auth="$HOME/.ssh/authorized_keys"')) return
    execFileSync('/bin/sh',['-s'],{input:options.input,env:{PATH:'/usr/bin:/bin',HOME:rootHome}})
    return ok('')
  }})
  rootHome = join(f.home,'synthetic-root'); mkdirSync(join(rootHome,'.ssh'),{recursive:true})
  const foreign = `# foreign exact bytes\nrestrict ${key(41)} admin\n${key(42)} jump\n`
  const auth = join(rootHome,'.ssh','authorized_keys'); writeFileSync(auth,foreign)
  const adopted = await f.service.adoptExistingBridge({acceptedFingerprint:m.fingerprint(hostKey)})
  const before = JSON.parse(readFileSync(join(f.userData,'machines.json'),'utf8'))
  assert.equal(before.installed.includes(adopted.machineId),false)
  const pointer = await f.service.agentInstructions(join(f.home,'project')), guide = pointer.match(/read (.+?\.md)\./)[1]
  assert.match(readFileSync(guide,'utf8'),/not connected yet/)
  await assert.rejects(f.service.installKey(adopted.machineId,{keyPath:f.adminPath}),{code:'host_key_unconfirmed'})
  enabled = true
  const connected = await f.service.installKey(adopted.machineId,{keyPath:f.adminPath,acceptedFingerprint:m.fingerprint(hostKey)})
  assert.equal(connected.user,'root'); assert.equal(connected.status.checks.auth,true)
  const after = JSON.parse(readFileSync(join(f.userData,'machines.json'),'utf8'))
  assert.deepEqual(after.bridgeConnections,before.bridgeConnections); assert.equal(after.bridgeMachineId,before.bridgeMachineId)
  assert.deepEqual(after.machines[0].bridgeSetup,before.machines[0].bridgeSetup)
  assert.ok(readFileSync(auth,'utf8').startsWith(foreign)); assert.match(readFileSync(auth,'utf8'),/drover-agents/)
  assert.match(readFileSync(f.service.configPath,'utf8'),/Host drover-bridge\n[\s\S]*User root/)
  assert.doesNotMatch(readFileSync(f.service.configPath,'utf8'),/admin_ed25519|management_ed25519|mac_jump/)
  assert.match(readFileSync(guide,'utf8'),/permission: full/); assert.doesNotMatch(readFileSync(guide,'utf8'),/not connected yet —/)
  await f.service.setPermissions(adopted.machineId,{mode:'projects',projects:[join(f.home,'project')]})
  assert.match(readFileSync(guide,'utf8'),/permission: full SSH with advisory project scope/)
  assert.doesNotMatch(readFileSync(f.service.configPath,'utf8'),/Host drover-bridge\n/)
  assert.match(readFileSync(guide+'.ssh_config','utf8'),/Host drover-bridge\n/)
  assert.deepEqual(JSON.parse(readFileSync(join(f.userData,'machines.json'),'utf8')).bridgeConnections,before.bridgeConnections)
})
