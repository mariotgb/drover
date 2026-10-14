import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { HerdrApiError, type AgentQuestion, type AnswerAgentQuestionRequest, type HerdrSnapshot, type PaneInfo, type SendPromptResult } from '@shared/types'
import type { HerdrService, StatusChange } from './herdr/service'

interface Choice { id: string; label: string; keys: string[] }
interface Dialog { kind: AgentQuestion['kind']; question: string; choices: Choice[]; fingerprint: string }
export interface RestoreTarget { paneId: string; kind: string; sessionId: string }
interface Context { client: HerdrService['client']; generation: number; session: string }
interface Observation {
  identity: string; revision: number; changedAt: number; checkedAt: number; verifiedRevision?: number
  dialog?: Dialog; question?: AgentQuestion
}
interface RestoreWatch extends RestoreTarget { startedAt: number; state: 'starting' | 'failed'; terminalId?: string; seenAgent?: boolean; error?: { code: string; message: string } }
const RESTORE_TIMEOUT_MS = 5 * 60_000
const restoreMatches = (pane: PaneInfo, restore: RestoreWatch) => (!restore.terminalId || restore.terminalId === pane.terminal_id) && pane.agent === restore.kind && (!pane.agent_session?.value || pane.agent_session.value === restore.sessionId)
const restoreReady = (pane: PaneInfo, restore: RestoreWatch) => restoreMatches(pane, restore) && ((pane as PaneInfo & { interactive_ready?: boolean }).interactive_ready === true || ['working', 'idle', 'done', 'blocked'].includes(pane.agent_status))
const identity = (pane: PaneInfo) => JSON.stringify([pane.terminal_id, pane.agent, pane.agent_session?.value])

/** Visible menus only. Ordinary numbered prose/code must not become actionable. */
export function blockingDialog(text: string, agent: string): Dialog | null {
  const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')
  const lines = clean.split('\n').map(line => line.trim()).filter(Boolean).slice(-48)
  const tail = lines.join('\n')
  const codex = agent === 'codex' && /background server has incompatible feature settings|(?:trust|allow|enable)[\s\S]{0,100}hooks|hooks[\s\S]{0,100}(?:trust|execute|run)|would you like to run (?:the )?(?:following )?command|approve.{0,30}(?:command|changes)|do you trust (?:the|this|these)/i.test(tail)
  const claude = agent === 'claude' && /trust (?:this|the) (?:folder|directory|project)|(?:allow|approve|permission).{0,45}(?:tool|command|access|execute)|(?:resume|continue).{0,45}(?:session|conversation)|do you want to proceed|bypass permissions|yes, i trust/i.test(tail)
  const controls = /(?:press|hit)\s+(?:enter|return)|enter (?:to|your|a)|(?:use|with).{0,20}(?:arrow|↑|↓)|(?:select|choose).{0,25}(?:option|choice)|esc (?:to|for)|\[y\/n\]|\(y\/n\)/i.test(tail)
  const numbered = lines.map((line, index) => ({ index, match: line.match(/^[›❯>●○\s]*([1-9])[.)]\s+(.+)$/u) })).filter(item => item.match)
  if (!codex && !claude && (!controls || numbered.length < 2)) return null
  if (!controls && numbered.length < 2) return null
  // A menu must occupy the bottom of the visible pane, with only its footer below.
  const last = numbered.at(-1)?.index ?? lines.length - 1
  if (lines.length - last > 5) return null
  const confirm = /(?:press|hit)\s+(?:enter|return)|enter (?:to|your|a)/i.test(tail)
  const choices: Choice[] = numbered.map(({ match }) => ({ id: match![1], label: match![2].slice(0, 500), keys: [match![1]] }))
  if (new Set(choices.map(c => c.id)).size !== choices.length) return null
  if (!choices.length && /\[y\/n\]|\(y\/n\)|\[y\/N\]/i.test(tail)) choices.push({ id: 'y', label: 'Yes (y)', keys: ['y'] }, { id: 'n', label: 'No (n)', keys: ['n'] })
  if (!choices.length && confirm) choices.push({ id: 'enter', label: 'Enter', keys: ['enter'] })
  if (/esc (?:to|for)|escape (?:to|for)/i.test(tail)) choices.push({ id: 'esc', label: 'Esc', keys: ['esc'] })
  const first = numbered[0]?.index ?? 0
  const question = (lines.slice(Math.max(0, first - 8), first).join('\n') || (numbered.length ? lines.slice(0, -1).join('\n') : tail)).slice(-2000)
  if (!question) return null
  const kind = codex ? 'codex' : claude ? 'claude' : 'generic'
  const fingerprint = createHash('sha256').update(JSON.stringify([kind, question, choices])).digest('hex')
  return { kind, question, choices, fingerprint }
}

/** Poll only stable pane revisions. Keep answers bound to the visible dialog,
 * session and occupant; detection itself never writes terminal input. */
export class AgentQuestions extends EventEmitter<{ changed: []; attention: [StatusChange] }> {
  private observations = new Map<string, Observation>()
  private restores = new Map<string, RestoreWatch>()
  private answering = new Set<string>()
  private context: Context | null = null
  private timer: NodeJS.Timeout | null = null
  private polling = false
  private latest: HerdrSnapshot | null = null
  constructor(private service: HerdrService, private now = Date.now, private stableMs = 5000, private retryMs = 15000) { super() }
  private ctx(): Context { return { client: this.service.client, generation: this.service.connectionGeneration, session: this.service.sessionName } }
  private current(ctx: Context): boolean { const next = this.ctx(); return next.client === ctx.client && next.generation === ctx.generation && next.session === ctx.session }
  private syncContext(): Context {
    const ctx = this.ctx()
    if (!this.context || !this.current(this.context)) { this.context = ctx; this.observations.clear(); this.restores.clear(); this.latest = null }
    return ctx
  }
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.poll().catch(() => {}) }, 2000)
    this.timer.unref()
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null }
  beginRestore(targets: RestoreTarget[]): void {
    this.syncContext()
    for (const target of targets) this.restores.set(target.paneId, { ...target, startedAt: this.now(), state: 'starting' })
    this.emit('changed')
  }
  hasQuestion(paneId: string): boolean { return !!this.snapshot()?.panes.find(p => p.pane_id === paneId)?.agent_question }
  snapshot(): HerdrSnapshot | null { return this.decorate(this.service.snapshot ?? this.latest) }
  decorate(snapshot: HerdrSnapshot | null): HerdrSnapshot | null {
    if (!snapshot || this.context && !this.current(this.context)) return snapshot
    const decorate = <T extends PaneInfo>(pane: T): T => {
      const observed = this.observations.get(pane.pane_id)
      const question = observed?.identity === identity(pane) && observed.verifiedRevision === pane.revision ? observed.question : undefined
      let restore = this.restores.get(pane.pane_id)
      if (restore && restoreReady(pane, restore)) { this.restores.delete(pane.pane_id); restore = undefined }
      const watching = restore && (!restore.terminalId || restore.terminalId === pane.terminal_id) && (!pane.agent || pane.agent === restore.kind && (!pane.agent_session?.value || pane.agent_session.value === restore.sessionId))
      return { ...pane, ...(question ? { agent_question: question, agent_status: 'blocked' as const } : {}),
        ...(watching && restore ? { restore_state: restore.state, agent: pane.agent || restore.kind, agent_status: question ? 'blocked' as const : 'unknown' as const,
          ...(restore.state === 'failed' ? { restore_error: restore.error } : {}) } : {}) }
    }
    const panes = snapshot.panes.map(decorate), agents = snapshot.agents.map(decorate)
    for (const pane of panes) if (pane.restore_state && pane.agent && !agents.some(a => a.pane_id === pane.pane_id)) agents.push({ ...pane, agent: pane.agent, name: pane.label || null })
    return { ...snapshot, panes, agents }
  }
  async poll(): Promise<void> {
    if (this.polling || !this.service.client) return
    this.polling = true
    const ctx = this.syncContext()
    try {
      let snapshot = this.service.snapshot
      if (this.restores.size) {
        snapshot = (await ctx.client!.request<{ snapshot: HerdrSnapshot }>('session.snapshot', {}, 3000)).snapshot
      }
      if (!snapshot || !this.current(ctx)) return
      this.latest = snapshot
      let changed = false
      for (const id of this.observations.keys()) if (!snapshot.agents.some(a => a.pane_id === id) && !this.restores.has(id)) { this.observations.delete(id); changed = true }
      const panes = snapshot.panes.filter(p => p.agent || this.restores.has(p.pane_id))
      for (const pane of panes) {
        if (!this.current(ctx)) return
        const agent = snapshot.agents.find(a => a.pane_id === pane.pane_id)
        // Native Herdr restore can precede Drover attaching to its server.
        if (!this.restores.has(pane.pane_id) && agent?.agent_session?.kind === 'id' && (agent.launch_pending || agent.interactive_ready === false) && agent.agent_status === 'unknown') {
          this.restores.set(pane.pane_id, { paneId: pane.pane_id, kind: agent.agent, sessionId: agent.agent_session.value, startedAt: this.now(), state: 'starting' })
          changed = true
        }
        const who = identity(agent ?? pane), time = this.now()
        let observation = this.observations.get(pane.pane_id)
        if (!observation || observation.identity !== who || observation.revision !== pane.revision) {
          changed ||= !!observation?.question
          observation = { ...(observation?.identity === who ? observation : {}), identity: who, revision: pane.revision, changedAt: time, checkedAt: -Infinity }
          this.observations.set(pane.pane_id, observation)
        }
        let restore = this.restores.get(pane.pane_id)
        if (restore && restoreReady(agent ?? pane, restore)) { this.restores.delete(pane.pane_id); restore = undefined; changed = true }
        if (restore && (restore.terminalId && restore.terminalId !== pane.terminal_id || pane.agent && (pane.agent !== restore.kind || pane.agent_session?.value && pane.agent_session.value !== restore.sessionId))) {
          this.restores.delete(pane.pane_id); changed = true
        } else if (restore) {
          restore.terminalId = pane.terminal_id
          if (pane.agent === restore.kind) restore.seenAgent = true
          if (restore.state !== 'failed' && !pane.agent && (restore.seenAgent || time - restore.startedAt >= RESTORE_TIMEOUT_MS)) {
            restore.state = 'failed'
            restore.error = { code: restore.seenAgent ? 'restore_exited' : 'restore_timeout', message: restore.seenAgent ? 'The restored agent exited before becoming ready.' : 'The restored agent did not appear within 5 minutes.' }
            changed = true
            this.emit('attention', { pane: this.decorate({ ...snapshot, panes: [pane], agents: [] })!.panes[0], from: 'unknown', to: 'blocked', name: agent?.name ?? pane.label ?? null })
          }
        }
        // Restores are checked immediately; other agents only once stationary.
        if (time - observation.changedAt >= (restore ? 0 : this.stableMs) && time - observation.checkedAt >= (restore?.state === 'starting' ? 2000 : this.retryMs)) {
          observation.checkedAt = time
          try {
            const { read } = await ctx.client!.request<{ read: { text: string; revision?: number } }>('pane.read', { pane_id: pane.pane_id, source: 'visible', format: 'text' }, 3000)
            if (!this.current(ctx)) return
            if (read.revision !== undefined && read.revision !== pane.revision) {
              continue
            }
            const dialog = blockingDialog(read.text, pane.agent || restore?.kind || '')
            const dialogChanged = dialog?.fingerprint !== observation.dialog?.fingerprint
            const revisionChanged = observation.verifiedRevision !== pane.revision
            observation.verifiedRevision = pane.revision
            if (dialogChanged || dialog && revisionChanged) {
              // Each displayed ID belongs to exactly one verified revision,
              // even when a later screen contains the same menu text.
              observation.dialog = dialog ?? undefined
              observation.question = dialog ? { id: randomUUID(), kind: dialog.kind, question: dialog.question, choices: dialog.choices.map(({ id, label }) => ({ id, label })), detectedAt: time } : undefined
              changed = true
              if (dialog && dialogChanged) this.emit('attention', { pane: this.decorate({ ...snapshot, panes: [agent ?? pane], agents: [] })!.panes[0], from: 'unknown', to: 'blocked', name: agent?.name ?? null })
            }
            if (restore && this.restores.has(pane.pane_id)) {
              if (!dialog && agent && !agent.launch_pending && (agent.interactive_ready === true || agent.agent_status === 'working')) {
                this.restores.delete(pane.pane_id); changed = true
              }
            }
          } catch { /* Keep pending restores and retry bounded read failures. */ }
        }

      }
      // Deleted restored panes cannot retain a pending banner.
      for (const id of this.restores.keys()) if (!snapshot.panes.some(p => p.pane_id === id)) {
        const pane = this.service.snapshot?.panes.find(p => p.pane_id === id)
        if (pane) this.emit('attention', { pane: { ...pane, restore_state: 'failed', restore_error: { code: 'restore_exited', message: 'The restored pane was closed before the agent became ready.' } }, from: 'unknown', to: 'blocked', name: pane.label ?? null })
        this.restores.delete(id); changed = true
      }
      if (changed && this.current(ctx)) this.emit('changed')
    } finally { this.polling = false }
  }
  async answer(req: AnswerAgentQuestionRequest): Promise<SendPromptResult> {
    if (!req || typeof req.paneId !== 'string' || typeof req.questionId !== 'string' || typeof req.choiceId !== 'string') return { ok: false, code: 'invalid_args' }
    const ctx = this.syncContext(), observation = this.observations.get(req.paneId)
    if (!observation?.question || !observation.dialog) return { ok: false, code: 'question_gone' }
    if (observation.question.id !== req.questionId) return { ok: false, code: 'question_changed' }
    const choice = observation.dialog.choices.find(c => c.id === req.choiceId)
    if (!choice) return { ok: false, code: 'invalid_args' }
    if (this.answering.has(req.paneId)) return { ok: false, code: 'agent_busy' }
    this.answering.add(req.paneId)
    try {
      const expectedDialog = observation.dialog, expectedRevision = observation.verifiedRevision, expectedIdentity = observation.identity
      const assertQuestion = () => {
        const current = this.observations.get(req.paneId)
        if (!this.current(ctx) || expectedRevision === undefined || current !== observation || current.question?.id !== req.questionId ||
            current.dialog !== expectedDialog || current.revision !== expectedRevision || current.verifiedRevision !== expectedRevision) {
          throw new HerdrApiError('question_changed', 'The visible question changed. Review it again.')
        }
      }
      const verifyScreen = async (kind: string) => {
        const { read } = await ctx.client!.request<{ read: { text: string; revision: number } }>('pane.read', { pane_id: req.paneId, source: 'visible', format: 'text' }, 3000)
        assertQuestion()
        if (read.revision !== expectedRevision || blockingDialog(read.text, kind)?.fingerprint !== expectedDialog.fingerprint) {
          throw new HerdrApiError('question_changed', 'The visible question changed. Review it again.')
        }
      }
      const { snapshot } = await ctx.client!.request<{ snapshot: HerdrSnapshot }>('session.snapshot', {}, 3000)
      const pane = snapshot.agents.find(a => a.pane_id === req.paneId)
      if (!pane || !this.current(ctx) || identity(pane) !== expectedIdentity) throw new HerdrApiError('occupant_changed', 'The pane occupant changed.')
      assertQuestion()
      if (pane.revision !== expectedRevision) throw new HerdrApiError('question_changed', 'The visible question changed. Review it again.')
      await verifyScreen(pane.agent)
      const { agent: latest } = await ctx.client!.request<{ agent: PaneInfo }>('agent.get', { target: req.paneId }, 3000)
      if (!this.current(ctx) || identity(latest) !== expectedIdentity) throw new HerdrApiError('occupant_changed', 'The pane occupant changed.')
      if (latest.revision !== expectedRevision) throw new HerdrApiError('question_changed', 'The visible question changed. Review it again.')
      // Re-read after agent.get so a screen change during either request
      // cannot authorize a choice from the previously displayed dialog.
      await verifyScreen(pane.agent)
      assertQuestion()
      // The browser supplies only an opaque choice ID; keys come from the
      // verified menu. Never accept arbitrary terminal input through this RPC.
      await ctx.client!.request('agent.send_keys', { target: req.paneId, keys: choice.keys }, 3000)
      if (!this.current(ctx)) return { ok: false, code: 'occupant_changed' }
      observation.dialog = undefined; observation.question = undefined; observation.changedAt = this.now(); observation.checkedAt = this.now()
      this.emit('changed'); this.service.scheduleRefresh()
      return { ok: true }
    } catch (error) {
      return { ok: false, code: error instanceof HerdrApiError ? error.code : 'error', error: error instanceof Error ? error.message : String(error) }
    } finally { this.answering.delete(req.paneId) }
  }
}
