import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'drover-project-tests-'))
await build({ stdin: { contents: `
  export * from './src/shared/projects'
  export * from './src/renderer/src/office/project-preferences'
  export { OfficeLayout } from './src/renderer/src/office/layout'
  export { SettingsStore } from './src/main/settings'
  export { validateSettingsPatch, validStoredSettings } from './src/main/remote/validation'
  export { REMOTE_LOCAL_ONLY_METHODS } from './src/shared/remote'
`, resolveDir: resolve('.'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: join(dir, 'tests.cjs'), alias: { '@shared': resolve('src/shared') }, logLevel: 'silent' })
const m = createRequire(import.meta.url)(join(dir, 'tests.cjs'))
rmSync(dir, { recursive: true, force: true })
const group = (id, cwd) => ({ workspace: { workspace_id: id }, cwd })
const projects = [group('w1', '/regular'), group('w2', '/background'), group('w3', '/important'), group('w4', '/primary')]
const preferences = { projectOrder: [], projectImportance: { '/background': 'background', '/important': 'important', '/primary': 'primary' } }
const folders = groups => groups.map(p => p.cwd)

test('importance supplies the default order; manual positions win and stable ties preserve workspace order', () => {
  assert.deepEqual(folders(m.orderedProjects(projects, preferences)), ['/primary', '/important', '/regular', '/background'])
  assert.deepEqual(folders(m.orderedProjects(projects, { ...preferences, projectOrder: ['/background', '/regular'] })), ['/background', '/regular', '/primary', '/important'])
  const equal = { projectOrder: [], projectImportance: {} }
  assert.equal(m.orderedProjects(projects, equal), projects, 'unchanged lists preserve model identity')
  assert.deepEqual(m.orderedProjects([group('w0', null), ...projects], equal).map(p => p.workspace.workspace_id), ['w0', 'w1', 'w2', 'w3', 'w4'])
})

test('drag/drop and phone arrows capture visible order before/after the target and retain closed folders', () => {
  const saved = { ...preferences, projectOrder: ['/primary', '/important', '/regular', '/background', '/closed'] }
  assert.deepEqual(m.moveProjectOrder(projects, saved, '/background', '/primary'), ['/background', '/primary', '/important', '/regular', '/closed'])
  assert.deepEqual(m.moveProjectOrder(projects, saved, '/primary', '/regular', true), ['/important', '/regular', '/primary', '/background', '/closed'])
  assert.equal(m.moveProjectOrder(projects, saved, '/outside', '/primary'), saved.projectOrder)
  assert.equal(m.moveProjectOrder(projects, saved, '/primary', '/primary'), saved.projectOrder)
  const duplicate = [...projects, group('w5', '/primary')]
  const moved = m.moveProjectOrder(duplicate, saved, '/primary', '/background', true)
  assert.equal(moved.filter(folder => folder === '/primary').length, 1, 'several workspaces share folder preferences')
})

test('folder preferences persist across reload and workspace recreation, and reset returns to importance', t => {
  const root = mkdtempSync(join(tmpdir(), 'drover-project-settings-'))
  const store = m.SettingsStore.at(root)
  t.after(() => { store.flush(); rmSync(root, { recursive: true, force: true }) })
  store.set({ projectOrder: ['/background', '/primary', '/regular', '/important'], projectImportance: preferences.projectImportance })
  store.flush()
  const reloaded = m.SettingsStore.at(root)
  assert.deepEqual(reloaded.get().projectOrder, store.get().projectOrder)
  assert.deepEqual(reloaded.get().projectImportance, store.get().projectImportance)
  const recreated = projects.map((p, i) => group(`new${i}`, p.cwd))
  assert.deepEqual(folders(m.orderedProjects(recreated, reloaded.get())), store.get().projectOrder)
  reloaded.set({ projectOrder: [] }); reloaded.flush()
  assert.deepEqual(folders(m.orderedProjects(recreated, reloaded.get())), ['/primary', '/important', '/regular', '/background'])
})

test('phone allowlist admits only bounded folder order/importance, without launch or filesystem capabilities', () => {
  assert.doesNotThrow(() => m.validateSettingsPatch({ projectOrder: ['/work/a', '/work/b'], projectImportance: { '/work/a': 'primary', '/work/b': 'background' } }, true))
  for (const patch of [
    { projectOrder: ['relative'] }, { projectOrder: ['/a', '/a'] }, { projectOrder: ['/a\0'] },
    { projectOrder: Array.from({ length: 501 }, (_, i) => `/a${i}`) }, { projectOrder: {} },
    { projectImportance: { '/a': 'urgent' } }, { projectImportance: { relative: 'important' } },
    { projectImportance: { '/a': { args: '--unsafe' } } }, { projectImportance: [] },
    { projectImportance: JSON.parse('{"__proto__":"primary"}') }
  ]) assert.throws(() => m.validateSettingsPatch(patch, true), { code: 'invalid_args' }, JSON.stringify(patch))
  for (const key of ['agentArgs', 'agentBypass', 'autoStartServer', 'session']) {
    assert.throws(() => m.validateSettingsPatch({ projectOrder: ['/a'], [key]: true }, true), { code: 'not_available_remotely' })
  }
  assert.deepEqual(m.validStoredSettings({ projectOrder: ['/a', '/a'], projectImportance: { '/a': 'invalid' } }), {})
  assert.ok(m.REMOTE_LOCAL_ONLY_METHODS.includes('codexIntegrationStatus'))
  assert.ok(m.REMOTE_LOCAL_ONLY_METHODS.includes('codexIntegrationInstall'))
  assert.ok(m.REMOTE_LOCAL_ONLY_METHODS.includes('codexDaemonRestartPlan'))
  assert.ok(m.REMOTE_LOCAL_ONLY_METHODS.includes('codexDaemonRestart'))
})

test('office uses the same ordered project folders and importance, including departments with several workspaces', () => {
  const ordered = m.orderedProjects(projects, preferences)
  const state = { departments: [
    { id: 'regular', workspaceIds: ['w1'], number: 1 },
    { id: 'background', workspaceIds: ['w2'], number: 2 },
    { id: 'important', workspaceIds: ['w3', 'w5'], number: 3 },
    { id: 'primary', workspaceIds: ['w4'], number: 4 }
  ] }
  const office = m.officeProjectPreferences(state, ordered, preferences)
  assert.deepEqual(office.departments.map(d => d.id), ['primary', 'important', 'regular', 'background'])
  assert.deepEqual([...office.importance.values()], ['primary', 'important', 'normal', 'background'])
  const layout = new m.OfficeLayout().update(office.departments.map((d, order) => ({ ...d, order })), [])
  assert.deepEqual(layout.lots.map(l => l.departmentId), office.departments.map(d => d.id))
  const manual = { ...preferences, projectOrder: ['/background', '/regular', '/important', '/primary'] }
  const moved = m.officeProjectPreferences(state, m.orderedProjects(projects, manual), manual)
  assert.deepEqual(new m.OfficeLayout().update(moved.departments.map((d, order) => ({ ...d, order })), []).lots.map(l => l.departmentId), ['background', 'regular', 'important', 'primary'])
})
