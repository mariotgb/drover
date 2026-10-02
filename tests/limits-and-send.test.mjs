import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from './_bundle.mjs'

const m = await load()

test('codex limits from a token_count record', () => {
  const lim = m.codexLimitsFromLine({
    timestamp: '2026-09-30T20:00:00Z',
    type: 'event_msg',
    payload: { type: 'token_count', rate_limits: {
      primary: { used_percent: 56, window_minutes: 10080, resets_at: 1791141677 },
      secondary: { used_percent: 20, window_minutes: 300, resets_in_seconds: 600 },
      plan_type: 'prolite', rate_limit_reached_type: null
    } }
  })
  assert.equal(lim.provider, 'codex')
  assert.equal(lim.plan, 'Pro Lite')
  assert.deepEqual(lim.windows.map((w) => [w.label, w.usedPercent]), [['5-hour', 20], ['Weekly', 56]])
  assert.equal(lim.windows[1].resetsAt, 1791141677000)
  assert.equal(lim.windows[0].resetsAt, Date.parse('2026-09-30T20:00:00Z') + 600000)
  assert.equal(m.codexLimitsFromLine({ type: 'event_msg', payload: { type: 'token_count', rate_limits: null } }), null)
})

function fakeService() {
  const calls = []
  return {
    calls,
    request: async (method, params) => {
      calls.push([method, params])
      return {}
    }
  }
}

test('sendPrompt pastes each screenshot path, then submits the text', async () => {
  const svc = fakeService()
  const r = await m.sendPrompt(svc, { paneId: 'w1:p1', target: 'w1:p1', agentKind: 'claude', text: 'What is on it?', imagePaths: ['/a.png', '/b.png'], isShell: false })
  assert.equal(r.ok, true)
  assert.deepEqual(svc.calls.map((c) => c[0]), ['pane.send_text', 'pane.send_text', 'agent.prompt'])
  assert.equal(svc.calls[0][1].text, '\x1b[200~/a.png\x1b[201~')
  assert.equal(svc.calls[1][1].text, '\x1b[200~/b.png\x1b[201~')
  assert.equal(svc.calls[2][1].text, ' What is on it?')
})

test('sendPrompt for agents without image paste puts paths into the text', async () => {
  const svc = fakeService()
  await m.sendPrompt(svc, { paneId: 'w1:p1', target: 'w1:p1', agentKind: 'gemini', text: 'Look', imagePaths: ['/a.png'], isShell: false })
  assert.deepEqual(svc.calls.map((c) => c[0]), ['agent.prompt'])
  assert.equal(svc.calls[0][1].text, '/a.png\n\nLook')
})

test('sendPrompt runs shell commands with Enter', async () => {
  const svc = fakeService()
  await m.sendPrompt(svc, { paneId: 'w1:p3', target: 'w1:p3', agentKind: null, text: 'ls', imagePaths: [], isShell: true })
  assert.deepEqual(svc.calls, [['pane.send_input', { pane_id: 'w1:p3', text: 'ls', keys: ['enter'] }]])
})

test('sendPrompt reports a blocked agent clearly', async () => {
  const svc = {
    request: async (method) => {
      if (method === 'agent.prompt') throw new m.HerdrApiError('agent_blocked', 'agent is blocked')
      return {}
    }
  }
  const r = await m.sendPrompt(svc, { paneId: 'w1:p1', target: 'w1:p1', agentKind: 'codex', text: 'hi', imagePaths: [], isShell: false })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'agent_blocked')
  assert.match(r.error, /waiting for an answer/)
})

function tempPaths() {
  const root = mkdtempSync(join(tmpdir(), 'drover-sl-'))
  return { claudeDir: join(root, 'claude'), dataDir: join(root, 'data') }
}

test('claude limits merge the freshest window across sessions', async () => {
  const p = tempPaths()
  const dir = join(p.dataDir, 'claude-status')
  mkdirSync(dir, { recursive: true })
  const reset5 = Math.floor(Date.now() / 1000) + 3600
  const resetW = Math.floor(Date.now() / 1000) + 5 * 86400
  // An idle session still holds an older (lower) reading of the same window.
  writeFileSync(join(dir, 'old.json'), JSON.stringify({ rate_limits: { five_hour: { used_percentage: 30, resets_at: reset5 }, seven_day: { used_percentage: 5, resets_at: resetW } } }))
  writeFileSync(join(dir, 'new.json'), JSON.stringify({ rate_limits: { five_hour: { used_percentage: 42.4, resets_at: reset5 }, seven_day: { used_percentage: 6, resets_at: resetW } } }))
  writeFileSync(join(dir, 'api-key-session.json'), JSON.stringify({ session_id: 'x' }))
  const lim = await m.readClaudeStatusLimits(p, 'Max 5x')
  assert.deepEqual(lim.windows.map((w) => [w.label, w.usedPercent]), [['5-hour', 42.4], ['Weekly', 6]])
  assert.equal(lim.windows[0].resetsAt, reset5 * 1000)
  assert.equal(lim.plan, 'Max 5x')
  assert.equal(await m.readClaudeStatusLimits(tempPaths()), null)
})

test('status line install keeps settings, chains the old command, uninstall restores', async () => {
  const p = tempPaths()
  mkdirSync(p.claudeDir, { recursive: true })
  const original = { model: 'opus', hooks: { Stop: [] }, statusLine: { type: 'command', command: 'echo mine' } }
  writeFileSync(join(p.claudeDir, 'settings.json'), JSON.stringify(original, null, 2))

  await m.installStatusline(p)
  const after = JSON.parse(readFileSync(join(p.claudeDir, 'settings.json'), 'utf8'))
  assert.equal(after.model, 'opus')
  assert.deepEqual(after.hooks, { Stop: [] })
  assert.match(after.statusLine.command, /claude-statusline\.sh/)
  assert.ok(existsSync(join(p.claudeDir, 'settings.json.drover-backup')))
  const script = join(p.dataDir, 'claude-statusline.sh')
  assert.ok(statSync(script).mode & 0o100, 'script is executable')
  const st = await m.statuslineState(p)
  assert.equal(st.installed, true)

  // The previous status line still renders, and the snapshot is saved.
  const out = execFileSync('/bin/sh', [script], { input: JSON.stringify({ session_id: 'abc-1', rate_limits: { five_hour: { used_percentage: 12, resets_at: 1 } } }) }).toString()
  assert.equal(out.trim(), 'mine')
  assert.ok(existsSync(join(p.dataDir, 'claude-status', 'abc-1.json')))

  await m.uninstallStatusline(p)
  const restored = JSON.parse(readFileSync(join(p.claudeDir, 'settings.json'), 'utf8'))
  assert.deepEqual(restored, original)
  assert.ok(!existsSync(script))
  assert.equal((await m.statuslineState(p)).installed, false)
})

test('status line script prints the limits Claude Code passes in', async () => {
  const p = tempPaths()
  await m.installStatusline(p)
  const settings = JSON.parse(readFileSync(join(p.claudeDir, 'settings.json'), 'utf8'))
  assert.deepEqual(Object.keys(settings), ['statusLine'])
  const script = join(p.dataDir, 'claude-statusline.sh')
  const input = JSON.stringify({
    session_id: '2da65fa8-1500-43bd-90f0-bceefdf1af55',
    model: { display_name: 'Opus' },
    rate_limits: { five_hour: { used_percentage: 42.6, resets_at: 1790000000 }, seven_day: { resets_at: 1790500000, used_percentage: 6 } }
  })
  const out = execFileSync('/bin/sh', [script], { input }).toString()
  assert.equal(out, '5h 42% · wk 6%\n')
  const saved = readFileSync(join(p.dataDir, 'claude-status', '2da65fa8-1500-43bd-90f0-bceefdf1af55.json'), 'utf8')
  assert.equal(saved, input)
  // No limits (API key users): empty status line, no crash.
  assert.equal(execFileSync('/bin/sh', [script], { input: '{"session_id":"k"}' }).toString(), '\n')
  await m.uninstallStatusline(p)
  assert.deepEqual(JSON.parse(readFileSync(join(p.claudeDir, 'settings.json'), 'utf8')), {})
})

/** A herdr stand-in whose agent goes through the given agent.get states. */
function startingAgent(states, { promptErrors = [] } = {}) {
  const calls = []
  let i = 0
  return {
    calls,
    snapshot: { agents: [], panes: [{ pane_id: 'w1:p9' }] },
    request: async (method, params) => {
      calls.push([method, params])
      if (method === 'tab.create') return { root_pane: { pane_id: 'w1:p9' } }
      if (method === 'agent.get') return { agent: states[Math.min(i++, states.length - 1)] }
      if (method === 'agent.prompt' && promptErrors.length) throw new m.HerdrApiError(promptErrors.shift(), 'nope')
      return {}
    }
  }
}
const req = { workspaceId: 'w1', folder: null, kind: 'claude', name: 'qa', placement: 'tab', args: [], prompt: 'Your role: QA' }
const pending = { agent_status: 'unknown', launch_pending: true }
const ready = { agent: 'claude', agent_status: 'idle', interactive_ready: true }

test('createAgent sends the first message only once the agent is interactive', async () => {
  const svc = startingAgent([pending, { ...pending, agent: 'claude', agent_status: 'idle' }, ready])
  const r = await m.createAgent(svc, req)
  assert.deepEqual(r, { ok: true, paneId: 'w1:p9' })
  const names = svc.calls.map((c) => c[0])
  assert.deepEqual(names, ['tab.create', 'agent.start', 'agent.get', 'agent.get', 'agent.get', 'agent.prompt'])
  const prompt = svc.calls.at(-1)[1]
  assert.equal(prompt.text, 'Your role: QA')
  assert.deepEqual(prompt.wait.until, ['working', 'blocked'])
})

test('createAgent delivers the first message after a startup dialog', async () => {
  const dialog = { agent: 'claude', agent_status: 'blocked', launch_pending: true }
  const svc = startingAgent([dialog, dialog, ready])
  const r = await m.createAgent(svc, req)
  assert.equal(r.ok, true)
  assert.equal(r.needsAttention, true)
  await new Promise((res) => setTimeout(res, 50))
  assert.deepEqual(svc.calls.slice(-3).map((c) => c[0]), ['agent.wait', 'agent.get', 'agent.prompt'])
})

test('createAgent retries the first message while herdr says not ready', async () => {
  const svc = startingAgent([ready], { promptErrors: ['agent_not_ready'] })
  const r = await m.createAgent(svc, req)
  assert.deepEqual(r, { ok: true, paneId: 'w1:p9' })
  assert.equal(svc.calls.filter((c) => c[0] === 'agent.prompt').length, 2)
})

test('createAgent reports an agent that exits during startup', async () => {
  const svc = startingAgent([{ agent_status: 'idle' }])
  const r = await m.createAgent(svc, req)
  assert.equal(r.code, 'agent_start_failed')
  assert.equal(svc.calls.some((c) => c[0] === 'agent.prompt'), false)
})

test('quitting stops herdr only when asked to, and asks while agents work', () => {
  const idle = [{ agent: 'claude', agent_status: 'idle' }, { agent: null, agent_status: 'unknown' }]
  assert.equal(m.quitPlan(false, [{ agent: 'codex', agent_status: 'working' }]), 'keep')
  assert.equal(m.quitPlan(true, idle), 'stop')
  assert.equal(m.quitPlan(true, undefined), 'stop')
  assert.equal(m.quitPlan(true, [...idle, { agent: 'codex', agent_status: 'working' }]), 'ask')
  assert.equal(m.quitPlan(true, [{ agent: 'claude', agent_status: 'blocked' }]), 'ask')
})
