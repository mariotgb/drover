import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const bundle = mkdtempSync(join(tmpdir(), 'drover-integration-test-'))
await build({ stdin: { contents: `export * from './src/main/codexIntegration'; export * from './src/renderer/src/codex-warning'`, resolveDir: resolve('.'), loader: 'ts' }, bundle: true,
  platform: 'node', format: 'cjs', outfile: join(bundle, 'test.cjs'), alias: { '@shared': resolve('src/shared') }, logLevel: 'silent' })
const m = createRequire(import.meta.url)(join(bundle, 'test.cjs'))
rmSync(bundle, { recursive: true, force: true })
const time = Date.parse('2026-10-05T17:00:00Z')
const startup = date => `${new Date(date).toISOString()} INFO event="app.startup" outcome="started"`
const error = (date, id, pane = '') => `${new Date(date).toISOString()} INFO outcome="error" method="pane.report_agent_session" request_id="herdr:codex:${id}"${pane ? ` pane_id="${pane}"` : ''}`
const agent = (pane = 'w1:p1', extra = {}) => ({ agent: 'codex', pane_id: pane, terminal_id: 'term:' + pane, name: pane, agent_session: null, ...extra })

test('session report diagnostics use the last server startup, daemon restart, and live pane attribution', () => {
  const log = [startup(time - 100000), error(time - 50000, 'old'), startup(time), error(time + 1, 'live', 'w1:p1'),
    error(time + 2, 'closed', 'w1:p2'), error(time + 3, 'unattributed')].join('\n')
  assert.equal(m.herdrStartedAt(log), time)
  assert.deepEqual(m.codexReportFailures(log, 0, new Set(['w1:p1'])), ['herdr:codex:live', 'herdr:codex:unattributed'])
  assert.deepEqual(m.codexReportFailures(log, time + 2, new Set(['w1:p1'])), ['herdr:codex:unattributed'])
  assert.deepEqual(m.codexReportFailures(log, 0, new Set()), [])
  assert.deepEqual(m.codexReportFailures(error(time, 'history'), 0, new Set(['w1:p1'])), [])
  const attributed = [startup(time), `${new Date(time + 1).toISOString()} INFO method="pane.report_agent_session" request_id="herdr:codex:paired" pane_id="w1:p2"`, error(time + 2, 'paired')].join('\n')
  assert.deepEqual(m.codexReportFailures(attributed, 0, new Set(['w1:p1'])), [])
})

test('all live Codex agents get 60 seconds to report a session, and replacements, exits and session switches reset age', () => {
  const tracker = new m.CodexSessionTracker(), snapshot = { agents: [agent(), agent('external:p1'), agent('claude:p1', { agent: 'claude' })] }
  assert.deepEqual(tracker.missing(snapshot, 'test', time), [])
  assert.deepEqual(tracker.missing(snapshot, 'test', time + 59999), [])
  assert.equal(tracker.missing(snapshot, 'test', time + 60000).length, 2)
  snapshot.agents[0].agent_session = { value: 'late' }
  assert.equal(tracker.missing(snapshot, 'test', time + 61000).length, 1)
  snapshot.agents[1].terminal_id = 'replacement'
  assert.deepEqual(tracker.missing(snapshot, 'test', time + 62000), [])
  assert.equal(tracker.missing(snapshot, 'test', time + 122000).length, 1)
  tracker.missing({ agents: [] }, 'test', time + 123000)
  assert.deepEqual(tracker.missing(snapshot, 'test', time + 124000), [])
  assert.deepEqual(tracker.missing(snapshot, 'other-session', time + 200000), [])
})

test('clean daemon clears historical warning, current errors warn, and dismissal keys change for new concrete causes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'drover-integration-case-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const logDir = join(root, 'herdr'); mkdirSync(logDir)
  const logFile = join(logDir, 'herdr-server.log')
  const service = { herdrPath: 'test', env: { XDG_CONFIG_HOME: root, CODEX_HOME: root }, sessionName: 'default',
    connection: { version: '0.9.1', socketPath: 'current.sock' }, snapshot: { agents: [agent()], panes: [agent()] },
    cli: async () => ({ code: 0, stdout: 'codex: current (v8)', stderr: '' }), codexLaunch: { supportsNoDaemon: async () => true } }
  const daemon = { lastStartedAt: time + 10, info: async () => ({ running: true, identity: '123:' + new Date(time + 10).toISOString(), paneId: null, socketPath: null }) }
  const integration = new m.CodexIntegration(service, daemon)
  writeFileSync(logFile, [startup(time), ...Array.from({length:66}, (_,i) => error(time + 1, i))].join('\n'))
  assert.equal((await integration.status()).status, 'ok')
  writeFileSync(logFile, [startup(time), error(time + 11, 'current')].join('\n'))
  const warning = await integration.status()
  assert.equal(warning.reportErrors, 1)
  const dismissed = m.codexWarningKey(warning)
  assert.equal(m.codexWarningKey(await integration.status()), dismissed)
  writeFileSync(logFile, [startup(time), error(time + 12, 'new-current')].join('\n'))
  assert.notEqual(m.codexWarningKey(await integration.status()), dismissed, 'new errors with the same count reshow the warning')
  daemon.lastStartedAt = time + 20
  assert.equal(m.codexWarningKey(await integration.status()), null)
  daemon.info = async () => ({ running: true, identity: '456', paneId: 'closed:p1', socketPath: 'old.sock' })
  const stale = await integration.status()
  assert.equal(stale.staleDaemonContext, true)
  assert.notEqual(m.codexWarningKey(stale), dismissed)
  writeFileSync(logFile, startup(time + 30))
  daemon.info = async () => ({ running: true, identity: '456', paneId: null, socketPath: null })
  assert.equal((await integration.status()).status, 'ok')
})

test('missing-agent identities reshow a dismissed warning even when the count stays constant', () => {
  const one = { status: 'warning', warningKey: JSON.stringify(['missing', 'w1:p1:old']) }
  const replacement = { ...one, warningKey: JSON.stringify(['missing', 'w1:p1:new']) }
  assert.equal(m.codexWarningKey({...one}), m.codexWarningKey(one))
  assert.notEqual(m.codexWarningKey(replacement), m.codexWarningKey(one))
  assert.equal(m.codexWarningKey({ ...one, status: 'ok' }), null)
})
