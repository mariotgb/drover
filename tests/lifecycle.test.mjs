import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const bundle = mkdtempSync(join(tmpdir(), 'drover-lifecycle-test-'))
await build({ stdin: { contents: `export * from './src/main/lifecycle'; export * from './src/main/codexIntegration'`, resolveDir: resolve('.'), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', outfile: join(bundle, 'test.cjs'), alias: { '@shared': resolve('src/shared') }, logLevel: 'silent' })
const m = createRequire(import.meta.url)(join(bundle, 'test.cjs'))
rmSync(bundle, { recursive: true, force: true })

test('dirty marker survives abrupt termination, next start detects it, clean quit clears detection', t => {
  const dir = mkdtempSync(join(tmpdir(), 'drover-lifecycle-case-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const first = new m.LifecycleJournal(dir, '0.7.2', 123)
  assert.equal(first.previousCrash, null)
  const next = new m.LifecycleJournal(dir, '0.7.2', 456)
  assert.equal(next.previousCrash.pid, 123)
  next.finish(0, 'user-quit-keep-herdr')
  const clean = new m.LifecycleJournal(dir, '0.7.2', 789)
  assert.equal(clean.previousCrash, null)
  const events = readFileSync(join(dir, 'logs/lifecycle.log'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(events.find(e => e.event === 'previous-abnormal-exit').previous.pid, 123)
  assert.ok(events.some(e => e.event === 'normal-exit' && e.reason === 'user-quit-keep-herdr'))
})

test('fatal exit cannot stop herdr or be reported clean by Electron quit event', t => {
  const dir = mkdtempSync(join(tmpdir(), 'drover-lifecycle-case-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const journal = new m.LifecycleJournal(dir, '0.7.2', 123)
  journal.abnormal('SIGTERM')
  assert.equal(journal.canStopServer, false)
  journal.finish(0, 'app.quit')
  assert.equal(new m.LifecycleJournal(dir, '0.7.2', 456).previousCrash.reason, 'SIGTERM')
  assert.equal(m.mayStopServer(false, 'isolated', 'isolated', true), false)
  assert.equal(m.mayStopServer(true, null, 'isolated', true), false)
  assert.equal(m.mayStopServer(true, 'old-session', 'new-session', true), false)
  assert.equal(m.mayStopServer(true, 'isolated', 'isolated', false), false)
  assert.equal(m.mayStopServer(true, 'isolated', 'isolated', true), true)
})

test('Codex diagnosis parses integration status and ignores non-Codex or pre-reinstall errors', () => {
  assert.deepEqual(m.parseCodexIntegration('claude: current (v10)\ncodex: current (v8) (/tmp/script)'), { installed: true, outdated: false, integrationVersion: 8 })
  assert.equal(m.parseCodexIntegration('codex: not installed (/tmp/script)').installed, false)
  assert.equal(m.parseCodexIntegration('codex: outdated (v5)').outdated, true)
  const record = (date, source, outcome) => `${date} INFO outcome="${outcome}" request_id="herdr:${source}:123" method="pane.report_agent_session"`
  const log = [record('2026-10-01T00:00:00Z', 'codex', 'error'), record('2026-10-03T00:00:00Z', 'codex', 'error'),
    record('2026-10-03T00:00:00Z', 'claude', 'error'), record('2026-10-03T00:00:00Z', 'codex', 'ok')].join('\n')
  assert.equal(m.codexReportErrors(log), 2)
  assert.equal(m.codexReportErrors(log, Date.parse('2026-10-02T00:00:00Z')), 1)
})
