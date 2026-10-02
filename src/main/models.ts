// Model catalogue for the New agent dialog and switching the model of a
// running agent from the chat.
//
// Both Claude Code and Codex save a model picked with a typed command as the
// default for every new session. Their /model menus also offer "s: use this
// session only", so Drover drives that menu: it reads the pane's screen, moves
// the cursor to the model and reasoning level and confirms with "s". The
// user's defaults (~/.claude/settings.json, ~/.codex/config.toml) stay as
// they are.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CLAUDE_MODELS, prettyModel, type ModelCatalog, type ModelChoice, type ModelOption } from '@shared/models'
import { HerdrApiError } from '@shared/types'
import type { HerdrService } from './herdr/service'
import { codexHome } from './transcripts/locate'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Service = Pick<HerdrService, 'request'>

/** Models from Codex's own cache of its model list (no network). */
export function codexModelsFrom(cache: unknown): ModelOption[] {
  const models = (cache as { models?: unknown[] } | null)?.models
  if (!Array.isArray(models)) return []
  const out: ModelOption[] = []
  for (const m of models as Record<string, unknown>[]) {
    if (typeof m?.slug !== 'string' || m.visibility === 'hide') continue
    const levels = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : []
    out.push({
      id: m.slug,
      label: typeof m.display_name === 'string' && m.display_name ? m.display_name : prettyModel(m.slug),
      description: typeof m.description === 'string' ? m.description : undefined,
      efforts: levels
        .map((l: unknown) => (typeof l === 'string' ? l : (l as { effort?: unknown })?.effort))
        .filter((l): l is string => typeof l === 'string'),
      defaultEffort: typeof m.default_reasoning_level === 'string' ? m.default_reasoning_level : undefined
    })
  }
  return out
}

export async function modelCatalog(env: NodeJS.ProcessEnv): Promise<ModelCatalog> {
  let codex: ModelOption[] = []
  try {
    codex = codexModelsFrom(JSON.parse(await readFile(join(codexHome(env), 'models_cache.json'), 'utf8')))
  } catch {
    /* Codex not installed or never started */
  }
  return { claude: CLAUDE_MODELS, codex }
}

// ---------------------------------------------------------------- menus

export interface MenuItem {
  number: number
  label: string
  selected: boolean
}

/** Rows of the last menu on screen whose title matches; null when there is none. */
export function parseMenu(lines: string[], title: RegExp): MenuItem[] | null {
  let start = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (title.test(lines[i])) {
      start = i
      break
    }
  }
  if (start < 0) return null
  const items: MenuItem[] = []
  for (const line of lines.slice(start + 1)) {
    const m = line.match(/^\s*([›❯>])?\s*(?:[↓↑]\s*)?(\d+)\.\s+(.+)$/)
    if (!m) continue
    const label = m[3]
      .split(/\s{2,}/)[0]
      .replace(/\((current|default|recommended)\)|✔/g, '')
      .trim()
    items.push({ number: Number(m[2]), label, selected: !!m[1] })
  }
  return items
}

const CLAUDE_MENU = /^\s*Select model\s*$/
const CODEX_MODELS = /Select Model and Effort/
const CODEX_EFFORTS = /Select Reasoning Level for/
const CODEX_ADVANCED = /Advanced Reasoning/

const CLAUDE_EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max']
const EFFORT_WORDS: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  'extra high': 'xhigh',
  xhigh: 'xhigh',
  max: 'max',
  auto: 'auto'
}
const CODEX_EFFORT_LABELS: Record<string, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra'
}

/** Reasoning level shown under Claude Code's model list ("◉ xHigh effort ←/→ to adjust"). */
export function claudeEffortOnScreen(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/([A-Za-z]+(?: high)?) effort\b.*(←|adjust)/)
    if (m) return EFFORT_WORDS[m[1].toLowerCase()] ?? null
  }
  return null
}

/** The menu row for a Claude Code alias (opus, sonnet…) or a full model id. */
export function claudeMenuTarget(items: MenuItem[], model: string): MenuItem | undefined {
  const id = model.toLowerCase().replace(/\[1m\]$/, '')
  if (id === 'default') return items.find((i) => /^default\b/i.test(i.label))
  const full = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/)
  if (full) {
    const label = `${full[1]} ${full[2]}${full[3] ? '.' + full[3] : ''}`
    return items.find((i) => i.label.toLowerCase() === label)
  }
  // The newest model of a family comes first.
  return items.find((i) => !/^default\b/i.test(i.label) && i.label.toLowerCase().split(/\s+/)[0] === id)
}

export interface ModelSwitchResult {
  ok: boolean
  /** The agent's confirmation, e.g. "Set model to Sonnet 5.5 for this session only". */
  message?: string
  code?: string
  error?: string
}

class MenuError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message)
  }
}

class Menu {
  constructor(
    private service: Service,
    private paneId: string
  ) {}

  async screen(): Promise<string[]> {
    const r = await this.service.request<{ read: { text: string } }>('pane.read', { pane_id: this.paneId, source: 'visible' }, 5000)
    return (r.read?.text ?? '').split('\n')
  }

  async waitFor<T>(probe: (lines: string[]) => T | null | undefined | false, timeoutMs = 4000): Promise<T | null> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const v = probe(await this.screen())
      if (v) return v
      if (Date.now() >= deadline) return null
      await sleep(120)
    }
  }

  keys(keys: string[]) {
    return this.service.request('pane.send_keys', { pane_id: this.paneId, keys })
  }

  type(text: string) {
    return this.service.request('pane.send_text', { pane_id: this.paneId, text })
  }

  async open(command: string, title: RegExp): Promise<MenuItem[]> {
    await this.type(command)
    await sleep(350)
    await this.keys(['enter'])
    const items = await this.waitFor((lines) => {
      const m = parseMenu(lines, title)
      return m?.length ? m : null
    })
    if (!items) throw new MenuError('model_menu_failed', `${command} did not open its menu`)
    return items
  }

  /** Moves the cursor (lists wrap around, so it always goes the direct way). */
  async moveTo(title: RegExp, isTarget: (i: MenuItem) => boolean): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const items = parseMenu(await this.screen(), title) ?? []
      const cur = items.findIndex((i) => i.selected)
      const target = items.findIndex(isTarget)
      if (target < 0 || cur < 0) break
      if (cur === target) return
      await this.keys(Array(Math.abs(target - cur)).fill(target > cur ? 'down' : 'up'))
      await sleep(150)
    }
    throw new MenuError('model_menu_failed', 'could not reach the menu item')
  }

  /** After confirming: waits for the menus to close and returns the newest confirmation line. */
  async confirmation(titles: RegExp[], line: RegExp): Promise<string | null> {
    return this.waitFor((lines) => {
      if (titles.some((t) => parseMenu(lines, t)?.length)) return null
      const hits = lines.filter((l) => line.test(l))
      return hits.length ? hits[hits.length - 1] : null
    })
  }

  /** Backs out of any menu still open. */
  async close(titles: RegExp[]) {
    for (let i = 0; i < 4; i++) {
      const lines = await this.screen().catch(() => [])
      if (!titles.some((t) => parseMenu(lines, t)?.length)) return
      await this.keys(['escape']).catch(() => undefined)
      await sleep(250)
    }
  }
}

async function switchClaude(menu: Menu, choice: ModelChoice): Promise<string> {
  const items = await menu.open('/model', CLAUDE_MENU)
  let wanted: string | null = null
  if (choice.model) {
    const target = claudeMenuTarget(items, choice.model)
    if (!target) throw new MenuError('model_not_in_menu', `${choice.model} is not in Claude Code's model list`)
    await menu.moveTo(CLAUDE_MENU, (i) => i.number === target.number)
    // "Default" confirms with the model it stands for, so only real names are checked.
    if (!/^default\b/i.test(target.label)) wanted = target.label
  }
  if (choice.effort) {
    const want = CLAUDE_EFFORT_ORDER.indexOf(choice.effort)
    for (let i = 0; i < 8; i++) {
      const cur = claudeEffortOnScreen(await menu.screen())
      // A model without effort levels shows no effort line: nothing to adjust.
      if (!cur || cur === choice.effort || want < 0) break
      const at = CLAUDE_EFFORT_ORDER.indexOf(cur)
      await menu.keys([at < want ? 'right' : 'left'])
      await sleep(150)
    }
  }
  await menu.type('s')
  const done = await menu.confirmation([CLAUDE_MENU], /(Set model to|Kept model as) .*for this session only/)
  // An older confirmation can still be on screen: the newest one must name the model.
  if (!done || (wanted && !done.toLowerCase().includes(wanted.toLowerCase()))) {
    throw new MenuError('model_menu_failed', 'Claude Code did not confirm the model change')
  }
  return done.replace(/^[\s⎿]+/, '').trim()
}

async function switchCodex(menu: Menu, choice: ModelChoice, catalog: ModelOption[]): Promise<string> {
  const items = await menu.open('/model', CODEX_MODELS)
  let target = items.find((i) => i.selected)
  if (choice.model) {
    const label = (catalog.find((m) => m.id === choice.model)?.label ?? prettyModel(choice.model)).toLowerCase()
    target = items.find((i) => i.label.toLowerCase() === label)
  }
  if (!target) throw new MenuError('model_not_in_menu', `${choice.model} is not in Codex's model list`)
  // In the model list a digit picks the row right away; picking only opens
  // the reasoning levels, nothing is applied yet.
  if (target.number <= 9) {
    await menu.type(String(target.number))
  } else {
    await menu.moveTo(CODEX_MODELS, (i) => i.number === target!.number)
    await menu.keys(['enter'])
  }
  const levels = await menu.waitFor((lines) => {
    const m = parseMenu(lines, CODEX_EFFORTS)
    return m?.length ? m : null
  })
  if (!levels) throw new MenuError('model_menu_failed', 'Codex did not show the reasoning levels')
  // Enter would save the choice as the default for new sessions; "s" applies it to this session only.
  if (choice.effort) {
    const label = (CODEX_EFFORT_LABELS[choice.effort] ?? choice.effort).toLowerCase()
    if (levels.some((i) => i.label.toLowerCase() === label)) {
      await menu.moveTo(CODEX_EFFORTS, (i) => i.label.toLowerCase() === label)
    } else if (levels.some((i) => /^more reasoning/i.test(i.label))) {
      // Max and Ultra live in a submenu.
      await menu.moveTo(CODEX_EFFORTS, (i) => /^more reasoning/i.test(i.label))
      await menu.keys(['enter'])
      const advanced = await menu.waitFor((lines) => {
        const m = parseMenu(lines, CODEX_ADVANCED)
        return m?.length ? m : null
      })
      if (!advanced?.some((i) => i.label.toLowerCase() === label)) {
        throw new MenuError('model_not_in_menu', `${choice.effort} is not available for this model`)
      }
      await menu.moveTo(CODEX_ADVANCED, (i) => i.label.toLowerCase() === label)
    } else {
      throw new MenuError('model_not_in_menu', `${choice.effort} is not available for this model`)
    }
  }
  await menu.type('s')
  const done = await menu.confirmation([CODEX_ADVANCED, CODEX_EFFORTS, CODEX_MODELS], /Model changed to .*for this session only/)
  if (!done || (choice.model && !done.includes(choice.model))) {
    throw new MenuError('model_menu_failed', 'Codex did not confirm the model change')
  }
  return done.replace(/^[\s•]+/, '').trim()
}

const busy = new Set<string>()

/** Switches the model of a running Claude Code or Codex agent for its current session only. */
export async function switchAgentModel(
  service: Service,
  paneId: string,
  kind: string,
  choice: ModelChoice,
  catalog: ModelCatalog
): Promise<ModelSwitchResult> {
  if (kind !== 'claude' && kind !== 'codex') return { ok: false, code: 'unsupported', error: 'Only Claude Code and Codex can switch models' }
  if (!choice.model && !choice.effort) return { ok: true }
  if (busy.has(paneId)) return { ok: false, code: 'agent_busy', error: 'A model switch is already running' }
  try {
    const { agent } = await service.request<{ agent: { agent_status?: string } }>('agent.get', { target: paneId }, 5000)
    if (agent?.agent_status === 'blocked') return { ok: false, code: 'agent_blocked', error: 'The agent is waiting for an answer' }
    if (agent?.agent_status === 'working') return { ok: false, code: 'agent_busy', error: 'The agent is working' }
  } catch (e) {
    if (e instanceof HerdrApiError) return { ok: false, code: e.code, error: e.message }
    return { ok: false, code: 'error', error: String(e) }
  }
  busy.add(paneId)
  const menu = new Menu(service, paneId)
  try {
    const message = kind === 'claude' ? await switchClaude(menu, choice) : await switchCodex(menu, choice, catalog.codex)
    return { ok: true, message }
  } catch (e) {
    await menu.close(kind === 'claude' ? [CLAUDE_MENU] : [CODEX_ADVANCED, CODEX_EFFORTS, CODEX_MODELS])
    if (e instanceof MenuError || e instanceof HerdrApiError) return { ok: false, code: e.code, error: e.message }
    return { ok: false, code: 'error', error: (e as Error)?.message ?? String(e) }
  } finally {
    busy.delete(paneId)
  }
}
