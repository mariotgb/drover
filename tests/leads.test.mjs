import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'drover-leads-'))
await build({
  stdin: { contents: `export * from './src/renderer/src/leads'\nexport { renameAgent } from './src/renderer/src/actions'\nexport { validateSettingsPatch, validStoredSettings } from './src/main/remote/validation'`, resolveDir: resolve('.'), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', outfile: join(dir, 'leads.cjs'), alias: { '@shared': resolve('src/shared') }, logLevel: 'silent',
  plugins: [{ name: 'rename-ui-fixture', setup(b) {
    const mocks = {
      './api': `export const api = {}; export const isRemote = false; export const humanizeError = String; export const call = (...args) => globalThis.renameFixture.call(...args)`,
      './i18n': `export const t = text => text`,
      './store': `export const useStore = { getState: () => globalThis.renameFixture.state, setState: patch => Object.assign(globalThis.renameFixture.state, patch) };
        export const getModel = () => ({groups: globalThis.renameFixture.groups});
        export const updateSettings = async patch => {globalThis.renameFixture.writes.push(patch);Object.assign(globalThis.renameFixture.state.settings,patch)};
        export const guard = () => {}; export const select = () => {}; export const setViewMode = () => {}; export const toast = () => {}; export const togglePreview = () => {};`
    }
    b.onResolve({ filter: /(?:^|\/)(api|store|i18n)$/ }, args => ({ path: './' + args.path.split('/').pop(), namespace: 'rename-fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'rename-fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }))
  } }]
})
const m = createRequire(import.meta.url)(join(dir, 'leads.cjs'))
rmSync(dir, { recursive: true })

const th = (paneId, name, kind = 'claude', status = 'idle') => ({ paneId, name, kind, status, isShell: !kind, agent: kind ? { name } : null })
const group = (threads, cwd = '/work/shop') => ({ workspace: { workspace_id: 'w1', label: 'Shop' }, cwd, threads, tabs: [] })

test('the lead: picked by hand, else orchestrator/team lead by name, else the first agent', () => {
  const a = th('w1:p1', 'frontend'), b = th('w1:p2', 'orchestrator'), c = th('w1:p3', 'tests'), shell = th('w1:p4', 'zsh', null)
  assert.equal(m.projectLead(group([shell, a, b, c]), {}).paneId, 'w1:p2')
  assert.equal(m.projectLead(group([shell, a, c]), {}).paneId, 'w1:p1')
  assert.equal(m.projectLead(group([a, b, c]), { '/work/shop': 'tests' }).paneId, 'w1:p3')
  // A pick for an agent that is gone falls back to the default.
  assert.equal(m.projectLead(group([a, b]), { '/work/shop': 'tests' }).paneId, 'w1:p2')
  assert.equal(m.projectLead(group([th('w1:p9', 'тимлид')]), {}).paneId, 'w1:p9')
  assert.equal(m.projectLead(group([shell]), {}), null)
  assert.equal(m.projectKey(group([], null)), 'workspace:Shop')
})

test('folding keeps the lead first, waiting agents and the open one in sight', () => {
  const lead = th('w1:p1', 'orchestrator', 'claude', 'working'), a = th('w1:p2', 'api', 'codex', 'working')
  const waiting = th('w1:p3', 'tests', 'claude', 'blocked'), done = th('w1:p4', 'docs', 'claude', 'done'), shell = th('w1:p5', 'zsh', null)
  const { shown, hidden } = m.splitByLead(group([a, waiting, lead, done, shell]), {}, (x) => x.paneId === 'w1:p4')
  assert.deepEqual(shown.map((x) => x.name), ['orchestrator', 'tests', 'docs'])
  assert.deepEqual(hidden.map((x) => x.name), ['api', 'zsh'])
  // Nothing folds without agents.
  assert.deepEqual(m.splitByLead(group([shell]), {}).hidden, [])
})

test('lead settings are validated like the rest and survive a reload', () => {
  assert.doesNotThrow(() => m.validateSettingsPatch({ leadOnly: true, projectLeads: { '/work/shop': 'orchestrator' } }, true))
  for (const bad of [{ leadOnly: 'yes' }, { projectLeads: { '/a': '' } }, { projectLeads: { '/a': 5 } }, { projectLeads: [] }, { projectLeads: { __proto__: null, constructor: 'x' } }]) {
    assert.throws(() => m.validateSettingsPatch(bad, true), { code: 'invalid_args' }, JSON.stringify(bad))
  }
  assert.deepEqual(m.validStoredSettings({ leadOnly: true, projectLeads: { '/a': 'lead' } }), { leadOnly: true, projectLeads: { '/a': 'lead' } })
  assert.deepEqual(m.validStoredSettings({ leadOnly: 1, projectLeads: 'x' }), {})
})

function renameFixture(t, leads, call = async () => ({})) {
  const previous = globalThis.renameFixture
  t.after(() => { if (previous === undefined) delete globalThis.renameFixture; else globalThis.renameFixture = previous })
  const selected = { ...th('w1:p1', 'chosen'), workspaceId: 'w1' }, other = { ...th('w1:p2', 'orchestrator'), workspaceId: 'w1' }
  const fixture = { state: { settings: { projectLeads: { ...leads } } }, groups: [group([other, selected])], writes: [], calls: [],
    call: async (...args) => { fixture.calls.push(args); return call(...args) } }
  globalThis.renameFixture = fixture
  return { fixture, selected, other }
}

test('renaming the chosen lead updates only its project after a successful rename', async t => {
  const { fixture, selected, other } = renameFixture(t, { '/work/shop': 'chosen', '/other': 'chosen' })
  m.renameAgent(selected); await fixture.state.dialog.onSubmit('renamed')
  assert.deepEqual(fixture.calls, [['agent.rename', { target: selected.paneId, name: 'renamed' }]])
  assert.deepEqual(fixture.writes, [{ projectLeads: { '/work/shop': 'renamed', '/other': 'chosen' } }])
  const renamed = { ...selected, name: 'renamed', agent: { name: 'renamed' } }
  assert.equal(m.projectLead(group([other, renamed]), fixture.state.settings.projectLeads).paneId, selected.paneId)
})

test('renaming another agent preserves the explicit lead; clearing its name removes the stale pick', async t => {
  const { fixture, selected, other } = renameFixture(t, { '/work/shop': 'chosen', '/other': 'chosen' })
  m.renameAgent(other); await fixture.state.dialog.onSubmit('new-orchestrator'); assert.deepEqual(fixture.writes, [])
  m.renameAgent(selected); await fixture.state.dialog.onSubmit('')
  assert.deepEqual(fixture.writes, [{ projectLeads: { '/other': 'chosen' } }])
  assert.deepEqual(fixture.calls.at(-1), ['agent.rename', { target: selected.paneId, name: null }])
})

test('a failed rename does not change projectLeads', async t => {
  const { fixture, selected } = renameFixture(t, { '/work/shop': 'chosen' }, async () => { throw new Error('name taken') })
  m.renameAgent(selected)
  await assert.rejects(fixture.state.dialog.onSubmit('renamed'), /name taken/)
  assert.deepEqual(fixture.writes, []); assert.deepEqual(fixture.state.settings.projectLeads, { '/work/shop': 'chosen' })
})
