import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { packagingTarget, builderArgs } from '../scripts/dist-platform.mjs'

const dir = mkdtempSync(join(tmpdir(), 'drover-platform-'))
await build({ entryPoints: ['src/main/platform.ts'], outfile: join(dir, 'platform.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
const p = createRequire(import.meta.url)(join(dir, 'platform.cjs'))
rmSync(dir, { recursive: true, force: true })

test('Linux respects absolute XDG roots; Mac retains attachment paths and Electron app paths', () => {
  assert.deepEqual(p.desktopPaths('linux', '/home/fixture', {}), { userData: '/home/fixture/.config/Drover', attachments: '/home/fixture/.local/share/drover/attachments' })
  assert.deepEqual(p.desktopPaths('linux', '/home/fixture', { XDG_CONFIG_HOME: '/config', XDG_DATA_HOME: '/data' }), { userData: '/config/Drover', attachments: '/data/drover/attachments' })
  assert.deepEqual(p.desktopPaths('linux', '/home/fixture', { XDG_CONFIG_HOME: 'relative', XDG_DATA_HOME: '' }), p.desktopPaths('linux', '/home/fixture', {}))
  assert.deepEqual(p.desktopPaths('darwin', '/home/fixture', { XDG_DATA_HOME: '/data' }), { userData: null, attachments: '/home/fixture/.drover/attachments' })
})

test('shell probe preserves Mac argv and quotes fish executables without POSIX syntax', () => {
  const marker = '__DROVER_ENV_123__'
  assert.equal(p.loginShell('darwin', undefined, null), '/bin/zsh')
  assert.equal(p.loginShell('linux', undefined, null), '/bin/sh')
  assert.equal(p.loginShell('linux', undefined, '/bin/bash'), '/bin/bash')
  assert.equal(p.loginShell('linux', '/usr/bin/fish', '/bin/bash'), '/usr/bin/fish')
  assert.deepEqual(p.shellProbeArgs('/bin/zsh', "/app/Drover's binary", marker), ['-ilc', `'${"/app/Drover's binary".replace(/'/g, "'\\''")}' -e 'process.stdout.write("${marker}"+JSON.stringify(process.env)+"${marker}")'`])
  const fish = p.shellProbeArgs('/usr/bin/fish', "/app/Drover's binary", marker, 'linux')
  assert.deepEqual(fish.slice(0, 3), ['--login', '--interactive', '-c'])
  assert.ok(fish[3].includes("Drover\\'s binary"))
})

test('Linux login probe retains graphical bus/display but excludes live herdr and agent context', () => {
  const env = { XDG_RUNTIME_DIR: '/run/user/123', XDG_CONFIG_HOME: '/config', DISPLAY: ':1', WAYLAND_DISPLAY: 'wayland-0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/123/bus', SSH_AUTH_SOCK: '/ssh-agent', HERDR_PANE_ID: 'live', CLAUDE_CODE_CHILD_SESSION: '1', ELECTRON_RUN_AS_NODE: '1', PATH: '/agent-bin' }
  const out = p.graphicalSessionEnv('linux', env)
  assert.equal(out.DISPLAY, ':1'); assert.equal(out.DBUS_SESSION_BUS_ADDRESS, env.DBUS_SESSION_BUS_ADDRESS)
  assert.equal(out.XDG_CONFIG_HOME, '/config'); assert.equal(out.SSH_AUTH_SOCK, '/ssh-agent')
  for (const key of ['HERDR_PANE_ID', 'CLAUDE_CODE_CHILD_SESSION', 'ELECTRON_RUN_AS_NODE', 'PATH']) assert.equal(out[key], undefined)
  assert.deepEqual(p.graphicalSessionEnv('darwin', env), {})
})

test('Mac window and utility commands are unchanged; Linux uses native decorations and argv-based image tooling', () => {
  assert.deepEqual(p.desktopWindowOptions('darwin'), { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 19 }, vibrancy: 'sidebar', visualEffectState: 'followWindow', backgroundColor: '#00000000' })
  assert.equal(p.desktopWindowOptions('linux').titleBarStyle, undefined)
  assert.equal(p.lsofCommand('darwin'), '/usr/sbin/lsof'); assert.equal(p.lsofCommand('linux'), '/usr/bin/lsof')
  assert.deepEqual(p.imageCommand('darwin', 'convert', '/tmp/photo.tiff', '/tmp/photo.jpg'), { file: '/usr/bin/sips', args: ['-s', 'format', 'jpeg', '/tmp/photo.tiff', '--out', '/tmp/photo.jpg'] })
  assert.deepEqual(p.imageCommand('darwin', 'dimensions', '/tmp/photo.png'), { file: '/usr/bin/sips', args: ['-g', 'pixelWidth', '-g', 'pixelHeight', '/tmp/photo.png'] })
  assert.deepEqual(p.imageCommand('linux', 'convert', '/tmp/photo $(id).tiff', '/tmp/photo.jpg'), { file: '/usr/bin/convert', args: ['/tmp/photo $(id).tiff[0]', 'jpeg:/tmp/photo.jpg'] })
})

test('Linux app shortcuts leave readline controls available and all Mac accelerators retain their keys', () => {
  const keys = ['N', 'Shift+N', 'T', 'Shift+A', 'K', 'B', 'J', 'Shift+T', 'Shift+P', 'Shift+C', '.', ']', '[', 'Shift+]', '1']
  for (const key of keys) assert.equal(p.appAccelerator('darwin', key), 'CmdOrCtrl+' + key)
  const map = Object.fromEntries(keys.map(key => [key, p.appAccelerator('linux', key)]))
  assert.equal(map.N, 'Ctrl+Shift+N'); assert.equal(map['Shift+N'], 'Ctrl+Alt+N')
  assert.equal(map['Shift+T'], 'Ctrl+Alt+T'); assert.equal(map['Shift+C'], 'Ctrl+Shift+C')
  assert.equal(p.appAccelerator('linux', ','), 'Ctrl+,')
  assert.ok(Object.values(map).every(value => value.startsWith('Ctrl+Shift+') || value.startsWith('Ctrl+Alt+')))
})

test('packaging chooses host or explicit Linux target without macOS icon probing/options', () => {
  assert.equal(packagingTarget('linux', []), '--linux')
  assert.equal(packagingTarget('darwin', ['--linux', '--x64']), '--linux')
  assert.deepEqual(builderArgs('--linux', ['--linux', '--x64']), ['electron-builder', '--linux', '--x64'])
  assert.deepEqual(builderArgs('--mac', ['--dir'], false), ['electron-builder', '--mac', '-c.mac.icon=resources/icon.icns', '--dir'])
  assert.deepEqual(builderArgs('--mac', ['--dir'], true), ['electron-builder', '--mac', '--dir'])
  assert.throws(() => packagingTarget('linux', ['--linux', '--mac']), /one operating system/)
  assert.throws(() => packagingTarget('win32', []), /not implemented/)
})

test('Linux TIFF conversion uses the actual distro codec and leaves a private JPEG', { skip: process.platform !== 'linux' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'drover-linux-image-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  await build({ entryPoints: ['src/main/attachments.ts'], outfile: join(root, 'image.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
  const image = createRequire(import.meta.url)(join(root, 'image.cjs'))
  const source = join(root, 'photo $(id).png'), tiff = join(root, 'photo $(id).tiff'), dest = join(root, 'result.jpg')
  writeFileSync(source, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64'))
  execFileSync('/usr/bin/convert', [source, tiff])
  await image.convertToJpeg(tiff, dest)
  assert.equal(readFileSync(dest).subarray(0, 3).toString('hex'), 'ffd8ff')
  assert.equal(statSync(dest).mode & 0o777, 0o600)
  const command = p.imageCommand('linux', 'dimensions', tiff)
  assert.equal(execFileSync(command.file, command.args, { encoding: 'utf8' }).trim(), '1 1')
})
