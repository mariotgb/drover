import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './_bundle.mjs'

const m = await load()

// Screens as the real agents draw them (Claude Code 2.1, Codex 0.159).
const CODEX_MODELS = `
› Ask Codex to do anything
  Select Model and Effort
› 1. GPT-6.1-Sol (current)  Latest workhorse model for coding and everyday work.
  2. GPT-6-Astra            Frontier intelligence for the most demanding work.
  8. GPT-5.5                Legacy coding model.
  enter select · esc back`.split('\n')
const CODEX_EFFORTS = `
  Select Reasoning Level for GPT-6.1-Sol
› 1. Low (default)    Fast responses with lighter reasoning
  2. Medium           Balances speed and reasoning depth for everyday tasks
  5. More reasoning…  Max and Ultra consume usage limits faster
  enter default · s session · esc back`.split('\n')
const CLAUDE_MODELS = `
❯ /model sonnet
  ⎿  Set model to Sonnet 5.5 and saved as your default for new sessions
   Select model
   Switch between Claude models. Your pick becomes the default for new sessions.
     1.  Default (recommended)  Opus 5.5 · Best for everyday, complex tasks
     2.  Opus 5.5               For complex work and everyday tasks
     3.  Fable 5.1              For your toughest challenges
   ❯ 4.  Sonnet 5.5 ✔           Most efficient for simpler tasks
     5.  Haiku 4.5              Fastest for quick answers
   ↓ 10. Opus 4.7               Best for everyday, complex tasks
   ◉ xHigh effort ←/→ to adjust
   Enter to set as default · s to use this session only · Esc to cancel`.split('\n')

test('menus are parsed from the agents’ screens', () => {
  assert.deepEqual(m.parseMenu(CODEX_MODELS, /Select Model and Effort/), [
    { number: 1, label: 'GPT-6.1-Sol', selected: true },
    { number: 2, label: 'GPT-6-Astra', selected: false },
    { number: 8, label: 'GPT-5.5', selected: false }
  ])
  assert.deepEqual(m.parseMenu(CODEX_EFFORTS, /Select Reasoning Level/).map((i) => i.label), ['Low', 'Medium', 'More reasoning…'])
  const claude = m.parseMenu(CLAUDE_MODELS, /^\s*Select model\s*$/)
  assert.deepEqual(claude.map((i) => i.label), ['Default', 'Opus 5.5', 'Fable 5.1', 'Sonnet 5.5', 'Haiku 4.5', 'Opus 4.7'])
  assert.equal(claude.find((i) => i.selected).label, 'Sonnet 5.5')
  assert.equal(m.parseMenu(['nothing here'], /Select model/), null)
  assert.equal(m.claudeEffortOnScreen(CLAUDE_MODELS), 'xhigh')
  assert.equal(m.claudeEffortOnScreen(['   ● High effort ←/→ to adjust']), 'high')
  assert.equal(m.claudeEffortOnScreen(['   ◉ Extra high effort ←/→ to adjust']), 'xhigh')
  assert.equal(m.claudeEffortOnScreen(['  ◉ xhigh · /effort']), null)
  const at = (id) => m.claudeMenuTarget(claude, id)?.number
  assert.deepEqual([at('default'), at('opus'), at('fable'), at('sonnet'), at('haiku'), at('claude-opus-4-7'), at('opus[1m]')], [1, 2, 3, 4, 5, 10, 2])
})

test('launch flags, names and the Codex model cache', () => {
  assert.deepEqual(m.modelArgs('claude', { model: 'opus', effort: 'high' }), ['--model', 'opus', '--effort', 'high'])
  assert.deepEqual(m.modelArgs('codex', { model: 'gpt-6-astra', effort: 'xhigh' }), ['-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=xhigh'])
  assert.deepEqual(m.modelArgs('codex', { model: null, effort: '' }), [])
  assert.deepEqual(m.modelArgs('gemini', { model: 'x' }), [])
  assert.equal(m.prettyModel('claude-sonnet-5-5'), 'Sonnet 5.5')
  assert.equal(m.prettyModel('claude-haiku-4-5-20251001'), 'Haiku 4.5')
  assert.equal(m.prettyModel('gpt-6.1-sol'), 'GPT-6.1-Sol')
  const models = m.codexModelsFrom({ models: [
    { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', default_reasoning_level: 'medium',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'ultra' }] },
    { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide' }
  ] })
  assert.deepEqual(models, [{ id: 'gpt-6-astra', label: 'GPT-6-Astra', description: undefined, efforts: ['low', 'medium', 'ultra'], defaultEffort: 'medium' }])
  assert.deepEqual(m.codexModelsFrom(null), [])
})

/** A stand-in for herdr that renders an agent's screen and feeds it keystrokes. */
function pane(tui, status = 'idle') {
  return {
    request: async (method, params) => {
      if (method === 'agent.get') return { agent: { agent_status: status } }
      if (method === 'pane.read') return { read: { text: tui.render().join('\n') } }
      if (method === 'pane.send_text') tui.text(params.text)
      if (method === 'pane.send_keys') for (const k of params.keys) tui.key(k)
      return {}
    }
  }
}

function codexTui() {
  const models = [['GPT-6.1-Sol', 'gpt-6.1-sol', 'low'], ['GPT-6-Astra', 'gpt-6-astra', 'medium'], ['GPT-5.5', 'gpt-5.5', 'medium']]
  const levels = ['Low', 'Medium', 'High', 'Extra high', 'More reasoning…']
  const ids = ['low', 'medium', 'high', 'xhigh']
  const tui = { state: 'prompt', input: '', cursor: 0, model: 0, history: ['  >_ OpenAI Codex (v0.159.3)'], savedDefault: false }
  const row = (i, label, extra = '') => `${i === tui.cursor ? '›' : ' '} ${i + 1}. ${label}${extra}  description`
  tui.render = () => {
    if (tui.state === 'models') return [...tui.history, '  Select Model and Effort', ...models.map((x, i) => row(i, x[0], i === 0 ? ' (current)' : '')), '  enter select · esc back']
    if (tui.state === 'levels') return [...tui.history, `  Select Reasoning Level for ${models[tui.model][0]}`, ...levels.map((l, i) => row(i, l, ids[i] === models[tui.model][2] ? ' (default)' : '')), '  enter default · s session · esc back']
    if (tui.state === 'advanced') return [...tui.history, '  Advanced Reasoning', row(0, 'Max'), row(1, 'Ultra'), '  enter default · s session · esc back']
    return [...tui.history, '› Ask Codex to do anything']
  }
  const apply = (effort) => {
    tui.history.push(`• Model changed to ${models[tui.model][1]} ${effort} for this session only`)
    tui.state = 'prompt'
  }
  const openLevels = (i) => Object.assign(tui, { model: i, state: 'levels', cursor: ids.indexOf(models[i][2]) })
  tui.text = (t) => {
    if (tui.state === 'prompt') tui.input += t
    else if (tui.state === 'models' && /^\d$/.test(t)) openLevels(Number(t) - 1)
    else if (t === 's' && tui.state === 'levels' && tui.cursor < 4) apply(ids[tui.cursor])
    else if (t === 's' && tui.state === 'advanced') apply(['max', 'ultra'][tui.cursor])
  }
  tui.key = (k) => {
    const n = { models: models.length, levels: levels.length, advanced: 2 }[tui.state] ?? 1
    if (k === 'down') tui.cursor = (tui.cursor + 1) % n
    else if (k === 'up') tui.cursor = (tui.cursor - 1 + n) % n
    else if (k === 'escape') tui.state = 'prompt'
    else if (k === 'enter') {
      if (tui.state === 'prompt' && tui.input === '/model') Object.assign(tui, { state: 'models', cursor: 0, input: '' })
      else if (tui.state === 'models') openLevels(tui.cursor)
      else if (tui.state === 'levels' && tui.cursor === 4) Object.assign(tui, { state: 'advanced', cursor: 0 })
      else if (tui.state !== 'prompt') Object.assign(tui, { savedDefault: true, state: 'prompt' })
    }
  }
  return tui
}

function claudeTui({ history = [], deaf = false } = {}) {
  const models = ['Default (recommended)', 'Opus 5.5', 'Fable 5.1', 'Sonnet 5.5', 'Haiku 4.5', 'Opus 4.7']
  const levels = ['Low', 'Medium', 'High', 'xHigh', 'Max']
  const tui = { state: 'prompt', input: '', cursor: 3, current: 3, effort: 3, history: [...history], savedDefault: false }
  tui.render = () => {
    if (tui.state !== 'models') return [...tui.history, '❯ ', '  ⏵⏵ auto mode on']
    return [
      ...tui.history,
      '   Select model',
      '   Switch between Claude models. Your pick becomes the default for new sessions.',
      ...models.map((label, i) => `   ${i === tui.cursor ? '❯' : ' '} ${i + 1}.  ${label}${i === tui.current ? ' ✔' : ''}   description`),
      ...(models[tui.cursor].startsWith('Haiku') ? [] : [`   ● ${levels[tui.effort]} effort ←/→ to adjust`]),
      '   Enter to set as default · s to use this session only · Esc to cancel'
    ]
  }
  tui.text = (t) => {
    if (tui.state === 'prompt') tui.input += t
    else if (t === 's' && !deaf) {
      const effort = models[tui.cursor].startsWith('Haiku') ? '' : ` with ${levels[tui.effort].toLowerCase()} effort`
      tui.history.push(`  ⎿  Set model to ${models[tui.cursor]} for this session only${effort}`)
      Object.assign(tui, { current: tui.cursor, state: 'prompt' })
    }
  }
  tui.key = (k) => {
    if (k === 'enter' && tui.state === 'prompt' && tui.input === '/model') Object.assign(tui, { state: 'models', input: '', cursor: tui.current })
    else if (tui.state !== 'models') return
    else if (k === 'down') tui.cursor = Math.min(models.length - 1, tui.cursor + 1)
    else if (k === 'up') tui.cursor = Math.max(0, tui.cursor - 1)
    else if (k === 'right') tui.effort = Math.min(levels.length - 1, tui.effort + 1)
    else if (k === 'left') tui.effort = Math.max(0, tui.effort - 1)
    else if (k === 'enter') Object.assign(tui, { savedDefault: true, state: 'prompt' })
    else if (k === 'escape') tui.state = 'prompt'
  }
  return tui
}

const catalog = { claude: [], codex: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra', efforts: [] }, { id: 'gpt-5.5', label: 'GPT-5.5', efforts: [] }] }

test('Codex: model and reasoning level for this session only', async () => {
  const tui = codexTui()
  const r = await m.switchAgentModel(pane(tui), 'w1:p1', 'codex', { model: 'gpt-6-astra', effort: 'high' }, catalog)
  assert.equal(r.ok, true, r.error)
  assert.equal(r.message, 'Model changed to gpt-6-astra high for this session only')
  assert.equal(tui.savedDefault, false)
})

test('Codex: Max is picked from the advanced submenu, effort alone keeps the model', async () => {
  const tui = codexTui()
  const r = await m.switchAgentModel(pane(tui), 'w1:p1', 'codex', { model: 'gpt-5.5', effort: 'ultra' }, catalog)
  assert.equal(r.message, 'Model changed to gpt-5.5 ultra for this session only')
  const r2 = await m.switchAgentModel(pane(tui), 'w1:p1', 'codex', { effort: 'xhigh' }, catalog)
  assert.equal(r2.message, 'Model changed to gpt-6.1-sol xhigh for this session only')
  assert.equal(tui.savedDefault, false)
})

test('Claude Code: model and effort for this session only', async () => {
  const tui = claudeTui()
  const r = await m.switchAgentModel(pane(tui), 'w1:p2', 'claude', { model: 'opus', effort: 'low' }, catalog)
  assert.equal(r.ok, true, r.error)
  assert.equal(r.message, 'Set model to Opus 5.5 for this session only with low effort')
  assert.equal(tui.savedDefault, false)
})

test('Claude Code: an old confirmation on screen is not mistaken for a new one', async () => {
  const stale = '  ⎿  Set model to Sonnet 5.5 for this session only'
  const ok = await m.switchAgentModel(pane(claudeTui({ history: [stale] })), 'w1:p2', 'claude', { model: 'haiku' }, catalog)
  assert.equal(ok.message, 'Set model to Haiku 4.5 for this session only')
  const tui = claudeTui({ history: [stale], deaf: true })
  const bad = await m.switchAgentModel(pane(tui), 'w1:p2', 'claude', { model: 'sonnet' }, catalog)
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'model_menu_failed')
  assert.equal(tui.state, 'prompt') // the menu was closed again
})

test('a working or blocked agent is not interrupted', async () => {
  const r = await m.switchAgentModel(pane(codexTui(), 'working'), 'w1:p1', 'codex', { model: 'gpt-5.5' }, catalog)
  assert.deepEqual([r.ok, r.code], [false, 'agent_busy'])
  const b = await m.switchAgentModel(pane(claudeTui(), 'blocked'), 'w1:p2', 'claude', { model: 'opus' }, catalog)
  assert.deepEqual([b.ok, b.code], [false, 'agent_blocked'])
})
