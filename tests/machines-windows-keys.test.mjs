import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'

const dir = mkdtempSync(join(tmpdir(), 'drover-windows-keys-bundle-'))
await build({ entryPoints: ['src/main/machines/permissions.ts'], outfile: join(dir, 'permissions.cjs'), bundle: true, platform: 'node', format: 'cjs', alias: { '@shared': resolve('src/shared') }, logLevel: 'silent' })
const { windowsKeyScript } = createRequire(import.meta.url)(join(dir, 'permissions.cjs'))
rmSync(dir, { recursive: true, force: true })
const installer = readFileSync('remote/machines/install-windows.ps1', 'utf8')
const pwsh = process.env.DROVER_TEST_PWSH || 'pwsh'
const available = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']).status === 0
const key = seed => {
  const algorithm = Buffer.from('ssh-ed25519'), length = Buffer.alloc(4); length.writeUInt32BE(algorithm.length)
  return 'ssh-ed25519 ' + Buffer.concat([length, algorithm, Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, seed)]).toString('base64')
}
const caseVariant = value => {
  const fields = value.split(' '), chars = [...fields[1]]
  const index = chars.findIndex((char, index) => index > 30 && /[A-Za-z]/.test(char))
  chars[index] = chars[index] === chars[index].toUpperCase() ? chars[index].toLowerCase() : chars[index].toUpperCase()
  return fields[0] + ' ' + chars.join('')
}

test('Windows key ownership uses case-sensitive comparisons in every key cleanup path', () => {
  const generated = windowsKeyScript(key(20), key(21), true, true)
  assert.doesNotMatch(generated, /\s-(?:eq|ne|in|notin)\s/)
  const identity = installer.match(/function Key-Identity\([\s\S]*?\n}\n/)[0]
  assert.doesNotMatch(identity, /\s-eq\s/)
  assert.match(installer, /\(Key-Identity \$line\.Value\) -cnotin \$owned/)
  assert.match(installer, /\$match\.Groups\[1\]\.Value -cnotin \$oldBlobs/)
  assert.match(installer, /\$d\.agentsAuthorizedKey -cne /)
  assert.match(installer, /\) -cne \(Key-Fingerprint \$d\.bridge\.tunnelPublicKey\)/)
})

test('PowerShell revoke, removal, reinstall and recovery preserve case-only foreign key identities', { skip: !available && 'Set DROVER_TEST_PWSH or provide pwsh to execute the PowerShell fixture.' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'drover-windows-keys-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const sshRoot = join(root, 'ssh'), auth = join(sshRoot, 'drover_agent_authorized_keys')
  mkdirSync(sshRoot)
  const agent = key(20), manager = key(21), foreignAgent = caseVariant(agent), foreignManager = caseVariant(manager)
  for (const [owned, foreign] of [[agent, foreignAgent], [manager, foreignManager]]) {
    assert.notEqual(owned, foreign); assert.equal(owned.toLowerCase(), foreign.toLowerCase())
    const fingerprints = [owned, foreign].map((value, index) => {
      const path = join(root, `key-${index}.pub`); writeFileSync(path, value + '\n')
      return execFileSync('ssh-keygen', ['-lf', path, '-E', 'sha256'], { encoding: 'utf8' }).split(/\s+/)[1]
    })
    assert.notEqual(fingerprints[0], fingerprints[1])
  }
  const foreign = Buffer.from(`  restrict,command="printf foreign agent" ${foreignAgent} drover-agents\r\n${foreignManager} drover-management\r\n# ${agent} drover-agents\r\n`)
  const managed = Buffer.from(`${agent} drover-agents\n${manager} drover-management\n`)
  const execute = script => {
    const path = join(root, 'fixture.ps1'); writeFileSync(path, script)
    execFileSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path], { env: { ...process.env, ProgramData: root }, timeout: 15_000, stdio: 'pipe' })
  }
  for (const [remove, removeManagement] of [[true, false], [true, true], [false, false]]) {
    writeFileSync(auth, Buffer.concat([foreign, managed]))
    execute(windowsKeyScript(agent, manager, remove, removeManagement))
    const expected = remove ? removeManagement ? foreign : Buffer.concat([foreign, Buffer.from(`${manager} drover-management\n`)]) : Buffer.concat([foreign, managed])
    assert.deepEqual(readFileSync(auth), expected)
  }
  const identity = installer.match(/function Key-Identity\([\s\S]*?\n}\n/)[0]
  const installKeys = installer.match(/# Dedicated key file:[\s\S]*?(?=\$cfg =)/)[0]
  // The exact Windows snippet passes a backslash path to .NET, which remains
  // literal on macOS. Use that filename while keeping the filter unchanged.
  const installerAuth = sshRoot + '\\drover_agent_authorized_keys'
  writeFileSync(join(root, 'credentials.json'), JSON.stringify({ agentsPublicKey: agent, managementPublicKey: manager, agentsAuthorizedKey: agent + ' drover-agents' }))
  writeFileSync(installerAuth, Buffer.concat([foreign, managed]))
  execute(`$ErrorActionPreference='Stop'
$sshRoot=Join-Path $env:ProgramData 'ssh'
$d=[IO.File]::ReadAllText((Join-Path $env:ProgramData 'credentials.json'))|ConvertFrom-Json
function Assert-Path([string]$Path) {}
function Write-Private([string]$Path,[string]$Value) {[IO.File]::WriteAllText($Path,$Value,[Text.UTF8Encoding]::new($false))}
${identity}
${installKeys}`)
  assert.deepEqual(readFileSync(installerAuth), Buffer.concat([foreign, managed]))
  const recovery = installer.match(/  \$kept = @\(\)\n([\s\S]*?)(?=  if \(\$oldTask\))/)[0]
  const recoveryForeign = foreign.toString().split('\r\n').slice(0, 2)
  writeFileSync(auth, recoveryForeign.join('\r\n') + '\r\n' + managed)
  execute(`$ErrorActionPreference='Stop'
$oldAuth=Join-Path (Join-Path $env:ProgramData 'ssh') 'drover_agent_authorized_keys'
$oldBlobs=@('${agent.split(' ')[1]}','${manager.split(' ')[1]}')
${recovery}
[IO.File]::WriteAllText((Join-Path $env:ProgramData 'kept.json'),(ConvertTo-Json -InputObject @($kept)),[Text.UTF8Encoding]::new($false))`)
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'kept.json'), 'utf8')), recoveryForeign)
})
