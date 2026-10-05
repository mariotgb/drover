import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const bundle = mkdtempSync(join(tmpdir(), 'drover-settings-allowlist-'))
await build({ stdin: { contents: `
  export * from './src/main/remote/validation'
  export * from './src/main/remote/rpc'
  export { SettingsStore } from './src/main/settings'
  export { DEFAULT_SETTINGS } from './src/shared/types'
  export { THEMES, GRADIENTS, MONO_FONTS } from './src/shared/themes'
`, resolveDir: resolve('.'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: join(bundle, 'test.cjs'), alias: { '@shared': resolve('src/shared') }, logLevel: 'silent' })
const m = createRequire(import.meta.url)(join(bundle, 'test.cjs'))
rmSync(bundle, { recursive: true, force: true })
const call = patch => ({ t: 'call', id: 'settings', method: 'setSettings', args: [patch] })
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'drover-settings-case-'))
  t.after(() => { store.flush(); rmSync(root, { recursive: true, force: true }) })
  const backgrounds = join(root, 'backgrounds'); mkdirSync(backgrounds)
  const store = m.SettingsStore.at(root); store.flush()
  const handlers = new m.RpcHandlers(), connection = new m.RemoteRpcConnection('phone')
  handlers.register('settings:set', (_, patch) => store.setRemote(patch, backgrounds))
  return { root, backgrounds, store, handlers, connection }
}

test('remote setSettings rejects every desktop-only key before its handler runs', async t => {
  const { root, backgrounds, store } = fixture(t), handlers = new m.RpcHandlers()
  let invoked = 0; handlers.register('settings:set', () => { invoked++ })
  const allowed = new Set(['notifications', 'notificationSound', 'terminalFontSize', 'chatFontSize', 'language', 'leadOnly', 'projectLeads', 'projectOrder', 'projectImportance', 'appearance'])
  const forbidden = Object.entries(m.DEFAULT_SETTINGS).filter(([key]) => !allowed.has(key))
  forbidden.push(['remoteEnabled', true], ['remotePort', 7780], ['remotePublicUrl', 'https://drover.example'], ['remoteBehindProxy', true], ['futureLaunchFlag', true])
  const previous = store.get(), disk = readFileSync(join(root, 'settings.json'), 'utf8')
  for (const [key, value] of forbidden) {
    const patch = { language: 'ru', [key]: value }
    const result = await m.dispatchRemoteRpc(handlers, new m.RemoteRpcConnection('phone'), call(patch))
    assert.equal(result.ok, false, key); assert.equal(result.error.code, 'not_available_remotely', key)
    assert.throws(() => store.setRemote(patch, backgrounds), { code: 'not_available_remotely' }, key)
  }
  assert.equal(invoked, 0); assert.equal(store.get(), previous)
  assert.equal(readFileSync(join(root, 'settings.json'), 'utf8'), disk)
  // Desktop settings keep their existing capabilities.
  assert.doesNotThrow(() => store.set({ autoStartServer: false, agentArgs: { codex: '--sandbox workspace-write' }, agentBypass: { codex: true }, teamBypass: true }))
})

test('phone project order and importance persist, broadcast settings, and cannot smuggle launch options', async t => {
  const { root, store, handlers, connection } = fixture(t)
  const changes = []; const off = store.onChange(settings => changes.push(settings))
  t.after(off)
  const patch = { projectOrder: ['/project/b', '/project/a'], projectImportance: { '/project/a': 'primary', '/project/b': 'background' } }
  const result = await m.dispatchRemoteRpc(handlers, connection, call(patch))
  assert.equal(result.ok, true)
  assert.deepEqual(store.get().projectOrder, patch.projectOrder)
  assert.deepEqual(store.get().projectImportance, patch.projectImportance)
  assert.deepEqual(changes.map(s => s.projectOrder), [patch.projectOrder])
  store.flush()
  const reloaded = m.SettingsStore.at(root)
  assert.deepEqual(reloaded.get().projectOrder, patch.projectOrder)
  assert.deepEqual(reloaded.get().projectImportance, patch.projectImportance)
  const previous = store.get()
  const rejected = await m.dispatchRemoteRpc(handlers, connection, call({ ...patch, agentArgs: { codex: '--unsafe' } }))
  assert.equal(rejected.ok, false); assert.equal(rejected.error.code, 'not_available_remotely')
  assert.equal(store.get(), previous); assert.equal(changes.length, 1)
})

test('remote appearance rejects injected definitions, unknown fields and values outside the displayed lists', async t => {
  const { store, handlers, connection } = fixture(t), previous = store.get()
  for (const appearance of [
    { customThemes: [] }, { injected: true }, { background: { injected: true } },
    { background: { gradient: 'arbitrary-css' } }, { monoFont: "font'; injected" },
    { theme: 'not-a-saved-theme' }, { accent: 'red' }, { glass: 0.1 }, { background: { blur: 100 } }
  ]) {
    const result = await m.dispatchRemoteRpc(handlers, connection, call({ appearance }))
    assert.equal(result.ok, false, JSON.stringify(appearance)); assert.equal(store.get(), previous)
  }
})

test('phone settings merge editable fields, select existing themes/presets and preserve desktop-owned values', t => {
  const { store, backgrounds } = fixture(t)
  const custom = { ...m.THEMES[0], id: 'custom-existing', name: 'My theme', custom: true }
  store.set({ appearance: { ...store.get().appearance, customThemes: [custom] }, agentArgs: { codex: '--sandbox workspace-write' }, agentBypass: { codex: true } })
  const previous = store.get()
  for (const theme of ['system', ...m.THEMES.map(t => t.id), custom.id]) {
    store.setRemote({ appearance: { theme } }, backgrounds)
    assert.equal(store.get().appearance.theme, theme)
  }
  for (const gradient of m.GRADIENTS.map(g => g.id)) {
    store.setRemote({ appearance: { background: { kind: 'gradient', gradient } } }, backgrounds)
    assert.equal(store.get().appearance.background.gradient, gradient)
  }
  for (const monoFont of m.MONO_FONTS) assert.equal(store.setRemote({ appearance: { monoFont } }, backgrounds).appearance.monoFont, monoFont)
  const next = store.setRemote({ language: 'ru', notifications: false, notificationSound: false, leadOnly: true, projectLeads: { '/project': 'lead' }, terminalFontSize: 18, chatFontSize: 16,
    appearance: { accent: '#123456', glass: 0.6, radius: 'round', density: 'compact', uiFont: 'serif', background: { blur: 12, dim: 40, fit: 'contain' } }
  }, backgrounds)
  assert.equal(next.language, 'ru'); assert.equal(next.leadOnly, true); assert.equal(next.notifications, false); assert.equal(next.notificationSound, false)
  assert.deepEqual(next.projectLeads, { '/project': 'lead' }); assert.equal(next.terminalFontSize, 18); assert.equal(next.chatFontSize, 16)
  assert.equal(next.appearance.glass, 0.6); assert.equal(next.appearance.background.blur, 12); assert.equal(next.appearance.background.kind, 'gradient')
  assert.equal(next.appearance.customThemes, previous.appearance.customThemes)
  assert.equal(next.agentArgs, previous.agentArgs); assert.equal(next.agentBypass, previous.agentBypass); assert.equal(next.autoStartServer, previous.autoStartServer)
  store.flush(); assert.deepEqual(m.SettingsStore.at(resolve(backgrounds, '..')).get(), next)
})

test('remote background paths must be existing regular files inside Drover backgrounds, including after symlink resolution', async t => {
  const { root, backgrounds, store, handlers, connection } = fixture(t)
  const image = join(backgrounds, 'saved.jpg'), video = join(backgrounds, 'saved.mp4')
  writeFileSync(image, 'image'); writeFileSync(video, 'video')
  for (const [path, kind] of [[image, 'image'], [video, 'video']]) {
    const result = await m.dispatchRemoteRpc(handlers, connection, call({ appearance: { background: { kind, path } } }))
    assert.equal(result.ok, true); assert.equal(store.get().appearance.background.path, path)
  }
  const outside = join(root, 'secret.jpg'); writeFileSync(outside, 'secret')
  const sibling = join(root, 'backgrounds-other'); mkdirSync(sibling); writeFileSync(join(sibling, 'secret.jpg'), 'secret')
  symlinkSync(outside, join(backgrounds, 'escape.jpg')); symlinkSync(root, join(backgrounds, 'escape-dir'))
  for (const path of [outside, join(sibling, 'secret.jpg'), join(backgrounds, '../secret.jpg'), join(backgrounds, 'escape.jpg'), join(backgrounds, 'escape-dir/secret.jpg'), join(backgrounds, 'missing.jpg'), backgrounds]) {
    const previous = store.get(), disk = readFileSync(join(root, 'settings.json'), 'utf8')
    const result = await m.dispatchRemoteRpc(handlers, connection, call({ appearance: { background: { kind: 'image', path } } }))
    assert.equal(result.ok, false, path); assert.equal(result.error.code, 'not_available_remotely', path)
    assert.equal(store.get(), previous); assert.equal(readFileSync(join(root, 'settings.json'), 'utf8'), disk)
  }
  assert.doesNotThrow(() => store.set({ appearance: { ...store.get().appearance, background: { ...store.get().appearance.background, path: outside } } }), 'desktop paths are unaffected')
  assert.throws(() => store.setRemote({ appearance: { background: { kind: 'image' } } }, backgrounds), { code: 'not_available_remotely' }, 'a partial patch cannot enable an inherited path outside the folder')
  const fresh = m.SettingsStore.at(join(root, 'fresh'))
  assert.throws(() => fresh.setRemote({ appearance: { background: { kind: 'video' } } }, backgrounds), { code: 'not_available_remotely' }, 'media selection requires an existing file')
})
