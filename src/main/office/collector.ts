import { createHash, randomUUID } from 'node:crypto'
import {
  OFFICE_LIMITS as L, type OfficeAgent, type OfficeAnimation, type OfficeEventEnvelope,
  type OfficeLink, type OfficeRole, type OfficeRoleSource,
  type OfficeState, type OfficeUIEvent, type OfficeUpdate, type OfficeDelta
} from '@shared/office'
import type { AppSettings, HerdrSnapshot, RoleTemplate, TaskBoard, TranscriptUpdate } from '@shared/types'
import { AGENT_NAME_RE } from '@shared/agents'
import { analyzeTranscriptTool, diffTaskBoard } from './analyze'
import type { BoardWriteEvidence } from '../tasks'
import { officeProjects } from './projects'
import { boardTaskTitle, journalSummary, statusCounts } from './hud'

export interface OfficeSources {
  session(): string
  snapshot(): HerdrSnapshot | null
  settings(): Pick<AppSettings, 'roles' | 'projectLeads'>
  isBoss?(paneId: string): boolean
  confirmedPrompt?(fromPaneId: string, toPaneId: string, text: string): void
  subscribe(paneId: string): Promise<TranscriptUpdate>
  unsubscribe(paneId: string): void
  watchBoard(cwd: string): Promise<TaskBoard>
  unwatchBoard(cwd: string): void
  roles?(cwd: string): Promise<RoleTemplate[]>
}
interface PaneWatch { baseline: boolean; token: string; seen: Map<string, string>; epoch: number; retained: boolean; limited: boolean; targets: Map<string,string | null> }
interface BoardWatch { board: TaskBoard | null; version: number; department: string; epoch: number }
interface Aggregate { link: Omit<OfficeLink, 'count' | 'weight' | 'lastAt'>; times: Map<number, number> }
const digest = (s: string) => createHash('sha256').update(s).digest('hex')

/** One light observer over the existing transcript tailers and project board refs. */
export class OfficeCollector {
  private state: OfficeState
  private watching = false
  private visible = false
  private connected = true
  private epoch = 0
  private grace: ReturnType<typeof setTimeout> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private dirty = false
  private panes = new Map<string, PaneWatch>()
  private boards = new Map<string, BoardWatch>()
  private aggregates = new Map<string, Aggregate>()
  private attempts = new Map<string, { key: string; ts: number }>()
  private incarnations = new Map<string, { token: string; kind: string }>()
  private projectRoles = new Map<string, RoleTemplate[]>()
  private roleBindings = new Map<string, { token: string; role: OfficeRole }>()
  private recentInput = new Map<string, number[]>()
  private pending: OfficeAnimation[] = []
  private active: number[] = []
  private lastPair = new Map<string, number>()
  private lookupQueue: Array<{ pane: string; watch: PaneWatch }> = []
  private lookups = 0
  private delivered = { agents: new Map<string, string>(), links: new Map<string, string>(), events: new Set<string>(),
    departments: '', seats: '', externalNodes: '', statusCounts: '' }
  private changedEvents = new Set<string>()
  private lastPrune = -Infinity

  constructor(private sources: OfficeSources, private publish: (update: OfficeUpdate) => void,
    private now: () => number = Date.now) {
    this.state = this.empty()
  }
  private empty(): OfficeState {
    return { session: this.sources.session(), generation: randomUUID(), version: 0, departments: [], seats: [], agents: [],
      externalNodes: [{ id: 'user', kind: 'user', name: 'User' },
        { id: 'machine:pc', kind: 'machine', name: 'pc' }, { id: 'machine:homeserver', kind: 'machine', name: 'homeserver' }],
      links: [], recentEvents: [], statusCounts: statusCounts([]) }
  }
  /** Idempotent for the single local renderer. Reopening never replays queued effects. */
  init(): OfficeState {
    if (this.state.session !== this.sources.session()) this.resetSession()
    if (this.grace) clearTimeout(this.grace)
    this.grace = null
    this.pending = []; this.active = []; this.visible = true
    if (!this.watching) {
      this.watching = true
      this.onSnapshot(this.sources.snapshot(), true)
      this.timer = setInterval(() => this.flush(), L.updateMs)
      this.timer.unref?.()
    } else this.onSnapshot(this.sources.snapshot(), true)
    const initial = this.getState()
    this.baseline()
    return initial
  }
  stop(): void {
    this.visible = false; this.pending = []; this.active = []
    if (!this.watching || this.grace) return
    this.grace = setTimeout(() => { this.grace = null; this.release() }, L.graceMs)
    this.grace.unref?.()
  }
  private release(): void {
    this.watching = false; this.epoch++
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const [id, watch] of this.panes) if (watch.retained) this.sources.unsubscribe(id)
    for (const cwd of this.boards.keys()) this.sources.unwatchBoard(cwd)
    this.panes.clear(); this.boards.clear(); this.lookupQueue = []; this.recentInput.clear()
    this.pending = []; this.active = []; this.lastPair.clear()
  }
  resetSession(): void {
    if (this.grace) clearTimeout(this.grace)
    this.grace = null
    this.release()
    this.aggregates.clear(); this.attempts.clear(); this.incarnations.clear(); this.roleBindings.clear(); this.projectRoles.clear()
    this.state = this.empty(); this.dirty = false; this.visible = false
    this.publish({ state: this.getState(), animations: [] })
    this.baseline()
  }
  dispose(): void {
    if (this.grace) clearTimeout(this.grace)
    this.grace = null; this.release()
    this.aggregates.clear(); this.attempts.clear(); this.state = this.empty()
  }
  getState(): OfficeState {
    this.prune()
    this.state.statusCounts = statusCounts(this.state.agents)
    const state = structuredClone(this.state)
    for (const link of state.links) {
      link.weight *= Math.exp(-Math.max(0, this.now() - (link.weightAt ?? link.lastAt)) / L.decayMs)
      link.weightAt = this.now()
    }
    return state
  }
  endpoint(paneId: string): string | null { return this.state.agents.find(a => a.paneId === paneId)?.id ?? null }
  bindRole(paneId: string, template: RoleTemplate): void {
    const pane = this.sources.snapshot()?.panes.find(p => p.pane_id === paneId)
    if (!pane?.agent) return
    let incarnation = this.incarnations.get(paneId)
    if (!incarnation || incarnation.kind !== pane.agent || (pane.agent_session?.value && incarnation.token !== pane.agent_session.value)) {
      incarnation = { token: pane.agent_session?.value || randomUUID(), kind: pane.agent }
      this.incarnations.set(paneId, incarnation)
    }
    if (incarnation) this.roleBindings.set(incarnation.token, { token: incarnation.token, role: roleOf(template) })
    this.onSnapshot(this.sources.snapshot(), true)
  }
  onConnection(connected: boolean): void {
    this.connected = connected
    if (!this.watching) return
    if (!connected) {
      for (const agent of this.state.agents) agent.status = 'disconnect'
      this.dirty = true
    } else this.onSnapshot(this.sources.snapshot(), true)
  }
  onSnapshot(snapshot: HerdrSnapshot | null, baseline = false): void {
    if (!this.watching || !snapshot) return
    if (this.state.session !== this.sources.session()) { this.resetSession(); return }
    const now = this.now()
    const projects = officeProjects(snapshot, this.state.session)
    this.state.departments = projects.map(p => p.department)
    const previous = new Map(this.state.agents.map(a => [a.id, a]))
    const agents: OfficeAgent[] = []
    const live = new Set(snapshot.panes.map(p => p.pane_id))
    for (const seat of this.state.seats) if (seat.paneId && !live.has(seat.paneId)) {
      seat.paneId = null; seat.agentId = null; seat.terminal = false
    }
    for (const id of this.incarnations.keys()) if (!live.has(id)) { this.incarnations.delete(id) }
    const neededBoards = new Map<string, string>()
    const statuses: OfficeEventEnvelope[] = []
    for (const { department, root } of projects) {
      if (root) neededBoards.set(root, department.id)
      const panes = snapshot.panes.filter(p => department.workspaceIds.includes(p.workspace_id)).sort((a,b) => a.pane_id.localeCompare(b.pane_id))
      for (const pane of panes) {
        const cwd = root
        let seat = this.state.seats.find(s => s.paneId === pane.pane_id && s.departmentId === department.id)
        for (const moved of this.state.seats) if (moved.paneId === pane.pane_id && moved.departmentId !== department.id) {
          moved.paneId = null; moved.agentId = null; moved.terminal = false
        }
        if (!seat) {
          seat = this.state.seats.find(s => s.departmentId === department.id && s.paneId === null)
          if (!seat) {
            const index = Math.max(-1, ...this.state.seats.filter(s => s.departmentId === department.id).map(s=>s.index)) + 1
            seat = { id: `${department.id}:seat:${index}`, departmentId: department.id, index, paneId: null, agentId: null, terminal: false }
            this.state.seats.push(seat)
          }
        }
        seat.paneId = pane.pane_id; seat.terminal = !pane.agent
        if (!pane.agent) { seat.agentId = null; this.incarnations.delete(pane.pane_id); continue }
        const kind = pane.agent.toLowerCase()
        let inc = this.incarnations.get(pane.pane_id)
        const exact = pane.agent_session?.value
        if (!inc || inc.kind !== kind || (exact && inc.token !== exact)) {
          inc = { token: exact || randomUUID(), kind }; this.incarnations.set(pane.pane_id, inc)
        }
        const incarnation = digest(inc.token)
        const id = `${this.state.session}:agent:${kind}:${incarnation}`
        const old = previous.get(id)
        const candidate = snapshot.agents.find(a=>a.pane_id === pane.pane_id)?.name || pane.label
        const name = candidate && AGENT_NAME_RE.test(candidate) ? candidate : kind
        const [role, roleSource] = this.role(inc.token, name, cwd || '')
        const same = old?.id === id
        const statusChanged = same && old.status !== pane.agent_status && old.status !== 'disconnect'
        const agent: OfficeAgent = { id, paneId: pane.pane_id, incarnation, kind, name, role, roleSource,
          ...(this.sources.isBoss?.(pane.pane_id) ? { isBoss: true } : {}),
          departmentId: department.id, seatId: seat.id, status: this.connected ? pane.agent_status : 'disconnect',
          lastStatusAt: same && old.status === pane.agent_status ? old.lastStatusAt : now,
          lastEventAt: old?.lastEventAt ?? null, lastTask: null,
          transcriptCoverage: same ? old.transcriptCoverage : exact && ['claude','codex'].includes(kind) ? 'loading' : 'unavailable' }
        agents.push(agent); seat.agentId = id
        if (this.connected && !baseline && statusChanged) statuses.push({ id: digest(`${id}:status:${now}:${pane.agent_status}`),
          from: id, to: null, kind: 'agent_status', ts: now, summary: '', source: 'herdr',
          status: pane.agent_status, sourceRef: id, observedAt: now, confidence: 'observed' })
      }
    }
    this.state.agents = agents
    for (const event of statuses) this.accept(event)
    const departments = new Set(this.state.departments.map(d => d.id))
    this.state.seats = this.state.seats.filter(s => departments.has(s.departmentId))
    const needed = new Set(agents.filter(a=> ['claude','codex'].includes(a.kind)).map(a=>a.paneId))
    for (const [pane, watch] of this.panes) {
      const a = agents.find(a=>a.paneId === pane)
      if (!needed.has(pane) || a?.id !== watch.token) { if (watch.retained) this.sources.unsubscribe(pane); this.panes.delete(pane) }
    }
    for (const pane of needed) if (!this.panes.has(pane)) {
      const watch = { baseline: false, token: this.endpoint(pane)!, seen: new Map<string,string>(), epoch: this.epoch, retained: false, limited: false, targets: new Map<string,string | null>() }
      this.panes.set(pane, watch); this.lookupQueue.push({ pane, watch })
    }
    this.pump()
    for (const cwd of this.boards.keys()) if (!neededBoards.has(cwd)) { this.sources.unwatchBoard(cwd); this.boards.delete(cwd) }
    for (const [cwd, department] of neededBoards) {
      const existing = this.boards.get(cwd)
      if (existing) { existing.department = department; continue }
      const watch: BoardWatch = { board: null, version: 0, department, epoch: this.epoch }
      this.boards.set(cwd, watch)
      void this.sources.watchBoard(cwd).then(board => {
        if (this.boards.get(cwd) === watch && watch.epoch === this.epoch && !watch.board && !board.error) {
          watch.board = structuredClone(board); this.refreshTasks(); this.dirty = true
        }
      }).catch(()=>undefined)
      if (this.sources.roles && !this.projectRoles.has(cwd)) {
        const epoch = this.epoch
        void this.sources.roles(cwd).then(roles => {
          if (epoch !== this.epoch) return
          this.projectRoles.set(cwd, roles); this.onSnapshot(this.sources.snapshot(), true)
        }).catch(()=>undefined)
      }
    }
    this.refreshTasks()
    this.dirty = true
  }
  private pump(): void {
    while (this.lookups < L.lookupConcurrency && this.lookupQueue.length) {
      const {pane, watch} = this.lookupQueue.shift()!
      if (this.panes.get(pane) !== watch || watch.epoch !== this.epoch) continue
      this.lookups++; watch.retained = true
      void this.sources.subscribe(pane).then(u => {
        if (this.panes.get(pane) !== watch || watch.epoch !== this.epoch) return
        if (!watch.baseline || u.error === 'office-history-limit') this.onTranscript({ ...u, reset: true })
      }).catch(()=>undefined).finally(()=> { this.lookups--; this.pump() })
    }
  }
  private role(token: string, name: string, cwd: string): [OfficeRole,OfficeRoleSource] {
    const bound = this.roleBindings.get(token)
    if (bound?.token === token) return [bound.role,'binding']
    const settings = this.sources.settings()
    if (settings.projectLeads[cwd] === name) return ['lead','projectLead']
    const matches = [...(this.projectRoles.get(cwd) || []), ...settings.roles].filter(r=>r.name === name)
    if (matches.length === 1) return [roleOf(matches[0]),'template']
    const inferred = roleName(name)
    return [inferred, inferred === 'general' ? 'default' : 'name']
  }
  onTranscript(update: TranscriptUpdate): void {
    const watch = this.panes.get(update.paneId)
    const agent = this.state.agents.find(a=>a.paneId === update.paneId)
    if (!watch || !agent || watch.token !== agent.id || !this.watching) return
    if (update.error === 'office-history-limit') watch.limited = true
    agent.transcriptCoverage = watch.limited ? 'history_limit' : update.meta?.coverage === 'tail' ? 'tail' : update.meta?.located || 'unavailable'
    this.dirty = true
    if (watch.limited) return
    const pane = this.sources.snapshot()?.panes.find(p=>p.pane_id === update.paneId)
    if (!update.meta || update.meta.located !== 'exact' || !pane?.agent_session?.value ||
      update.meta.sessionId !== pane.agent_session.value || update.meta.sessionId !== this.incarnations.get(update.paneId)?.token) return
    if (!this.connected || update.reset || !watch.baseline) {
      for (const item of update.items) watch.seen.set(item.id, 'baseline')
      watch.baseline = true
      return
    }
    for (const item of update.items) {
      if (watch.seen.get(item.id) === 'baseline') continue
      if (item.kind === 'user') {
        if (watch.seen.has(item.id)) continue
        watch.seen.set(item.id, 'observed')
        const key = JSON.stringify([agent.id,digest(item.text.trim())])
        const queue = (this.recentInput.get(key) || []).filter(expires=>expires >= this.now())
        if (queue.length) {
          queue.shift()
          if (queue.length) this.recentInput.set(key,queue)
          else this.recentInput.delete(key)
          continue
        }
        this.recentInput.delete(key)
        this.accept({ id: digest(`${agent.id}:${item.id}`), from: null, to: agent.id, kind: 'input_observed',
          ts: item.ts ?? this.now(), summary: '', source: 'transcript', sourceRef: item.id,
          observedAt: this.now(), confidence: 'observed' })
      } else if (item.kind === 'tool') {
        // Analyzer never promotes done/error alone to delivery evidence.
        const candidates = analyzeTranscriptTool(item, this.analysisContext(agent.id))
        for (const c of candidates) {
          const key = `${item.id}:${c.commandIndex}`
          if (!watch.targets.has(key)) watch.targets.set(key,c.to)
          // A result for an old name/pane occupant cannot move to its replacement.
          if (watch.targets.get(key) !== c.to) continue
          const prev = watch.seen.get(key)
          if (prev === 'confirmed' || prev === c.confidence) continue
          watch.seen.set(key, c.confidence)
          this.accept({ ...c, id: digest(`${agent.id}:${key}`), source: 'transcript', sourceRef: key, observedAt: this.now() })
        }
      }
    }
  }
  private analysisContext(from: string | null) {
    return { session: this.state.session, from, observedAt: this.now(), sshAliases: ['pc','homeserver'],
      onConfirmedPrompt: (targetPaneId: string, text: string) => {
        const sender = this.state.agents.find(a => a.id === from)
        if (sender) this.sources.confirmedPrompt?.(sender.paneId, targetPaneId, text)
      },
      resolveAgent: (session: string, target: string) => {
        if (session !== this.state.session) return null
        const matches = this.state.agents.filter(a=>a.paneId === target || a.name === target)
        return matches.length === 1 ? {id: matches[0].id, paneId: matches[0].paneId, name: matches[0].name} : null
      }, resolveMachine: (alias: string) => ['pc','homeserver'].includes(alias) ? `machine:${alias}` : null }
  }
  onBoard(board: TaskBoard, write?: BoardWriteEvidence): void {
    const watch = this.boards.get(board.cwd)
    if (!watch || !this.watching || board.error) return
    if (!this.connected || !watch.board) { watch.board = structuredClone(board); this.refreshTasks(); this.dirty = true; return }
    const previous = watch.board
    // Ignore since/title/notes noise; version only accepted semantic diffs.
    const signature = (b: TaskBoard) => JSON.stringify([b.exists,b.tasks.map(t=>[t.id,t.assignee,t.status])])
    if (signature(previous) === signature(board)) { watch.board = structuredClone(board); this.refreshTasks(); this.dirty = true; return }
    watch.board = structuredClone(board); watch.version++
    this.refreshTasks()
    const candidates = diffTaskBoard(previous, board, { ...this.analysisContext(null), departmentId: watch.department,
      resolveAgent: (session, target) => {
        if (session !== this.state.session) return null
        const matches = this.state.agents.filter(a => a.departmentId === watch.department && (a.name === target || a.paneId === target))
        return matches.length === 1 ? matches[0] : null
      } })
    for (const [i,c] of candidates.entries()) {
      const task = board.tasks.find(t=>t.id === c.taskId)
      const user = write?.taskId === c.taskId && task && (
        (c.kind === 'task_created' && write.created) ||
        (c.kind === 'task_assigned' && write.assignee !== undefined && (task.assignee || '') === write.assignee) ||
        (c.kind === 'task_status' && write.status !== undefined && task.status === write.status))
      this.accept({ ...c, from: user ? 'user' : c.from, id: digest(`${this.state.generation}:${board.cwd}:${watch.version}:${i}`),
      source: 'board', sourceRef: digest(`${board.cwd}:${watch.version}:${i}`), observedAt: this.now() })
    }
  }
  private refreshTasks(): void {
    for (const agent of this.state.agents) {
      const board = [...this.boards.values()].find(w => w.department === agent.departmentId)?.board
      const tasks = (board?.tasks || []).filter(t => t.assignee === agent.name)
      // Equal names in one project cannot establish which agent owns a task.
      const unique = this.state.agents.filter(a => a.departmentId === agent.departmentId && a.name === agent.name).length === 1
      const latest = tasks.reduce<typeof tasks[number] | null>((last, task) =>
        !last || (task.since ?? 0) >= (last.since ?? 0) ? task : last, null)
      agent.lastTask = unique && latest ? boardTaskTitle(latest.title) : null
    }
  }
  /** Call only after a specific agent.prompt acceptance. No shell/fallback/startup calls. */
  userPrompt(agent: string | null, text: string): void {
    if (!this.watching || !agent || !this.state.agents.some(a=>a.id === agent)) return
    const key = JSON.stringify([agent,digest(text.replace(/\r\n/g,'\n').trim())])
    const queue = this.recentInput.get(key) || []
    queue.push(this.now()+30_000)
    this.recentInput.set(key,queue)
    this.accept({ id: randomUUID(), from: 'user', to: agent, kind: 'user_prompt', ts: this.now(), summary: '',
      source: 'ui', sourceRef: 'agent:send', observedAt: this.now(), confidence: 'confirmed' })
  }
  /** A specific acceptance by the local HQ helper, backed by agent.prompt. */
  agentPrompt(from: string | null, to: string | null, text?: string, receiptId: string = randomUUID(), ts = this.now()): void {
    if (!this.watching || !from || !to || !this.state.agents.some(a => a.id === from) || !this.state.agents.some(a => a.id === to)) return
    if (text) {
      const key = JSON.stringify([to, digest(text.replace(/\r\n/g,'\n').trim())])
      const queue = this.recentInput.get(key) || []
      queue.push(this.now() + 30_000); this.recentInput.set(key, queue)
    }
    this.accept({ id: receiptId, from, to, kind: 'prompt', ts, summary: '', source: 'ui',
      sourceRef: 'boss-helper', observedAt: this.now(), confidence: 'confirmed' })
  }
  private accept(envelope: OfficeEventEnvelope): void {
    if (!Number.isFinite(envelope.ts) || envelope.ts < this.now()-L.historyMs || envelope.ts > this.now()+1000) return
    const event: OfficeUIEvent = { id: envelope.id, from: envelope.from, to: envelope.to, kind: envelope.kind,
      ts: Math.min(envelope.ts,this.now()), summary: journalSummary(envelope, this.state),
      ...(envelope.kind === 'agent_status' && envelope.status ? { status: envelope.status } : {}) }
    const index = this.state.recentEvents.findIndex(e=>e.id === event.id)
    if (index >= 0) {
      if (this.state.recentEvents[index].kind === event.kind) return
      this.state.recentEvents[index] = event
    } else this.state.recentEvents.push(event)
    this.changedEvents.add(event.id)
    for (const agent of this.state.agents) if (agent.id === event.from || agent.id === event.to) {
      agent.lastEventAt = Math.max(agent.lastEventAt ?? 0, event.ts)
    }
    if (event.kind === 'prompt') {
      const attempt = this.attempts.get(event.id)
      if (attempt) {
        const agg = this.aggregates.get(attempt.key)
        const count = agg?.times.get(attempt.ts) || 0
        if (count > 1) agg!.times.set(attempt.ts,count-1)
        else agg?.times.delete(attempt.ts)
        this.attempts.delete(event.id)
      }
    }
    if (this.state.recentEvents.length > L.maxEvents) this.state.recentEvents.splice(0,this.state.recentEvents.length-L.maxEvents)
    if (event.from && event.to && (envelope.confidence === 'confirmed' || event.kind === 'ssh_attempt' || event.kind === 'prompt_attempt') && event.kind !== 'agent_status' && event.kind !== 'input_observed') {
      const key = JSON.stringify([event.from,event.to,event.kind])
      let agg = this.aggregates.get(key)
      if (!agg) {
        const style = event.kind === 'prompt_attempt' ? 'attempt' : event.from === 'user' ? 'user' : event.to.startsWith('machine:') ? 'machine' : event.from.includes(':department:') ? 'board' : 'agent'
        agg = {link:{id:digest(key),from:event.from,to:event.to,kind:event.kind,style},times:new Map()}
        this.aggregates.set(key,agg)
      }
      agg.times.set(event.ts,(agg.times.get(event.ts)||0)+1)
      if (event.kind === 'prompt_attempt') this.attempts.set(event.id,{key,ts:event.ts})
    }
    if (this.visible && event.from && event.to && envelope.confidence === 'confirmed' && ['prompt','user_prompt'].includes(event.kind)) {
      const pending = this.pending.find(p=>p.from === event.from && p.to === event.to)
      if (pending) pending.count++
      else if (this.pending.length < L.maxAnimationQueue) this.pending.push({id:event.id,from:event.from,to:event.to,
        kind:event.kind as 'prompt'|'user_prompt',count:1,ts:this.now()})
    }
    this.dirty = true
  }
  private prune(): void {
    const now = this.now()
    this.lastPrune = now
    this.state.recentEvents = this.state.recentEvents.filter(e=>e.ts >= now-L.historyMs)
    const links: OfficeLink[] = []
    for (const [key,agg] of this.aggregates) {
      let count=0, weight=0, lastAt=0
      for (const [ts,n] of agg.times) {
        if (ts < now-L.historyMs) { agg.times.delete(ts); continue }
        count+=n; lastAt=Math.max(lastAt,ts)
      }
      for (const [ts,n] of agg.times) weight += n*Math.exp(-(lastAt-ts)/L.decayMs)
      if (!count) this.aggregates.delete(key)
      else links.push({...agg.link,count,weight: agg.link.style === 'attempt' ? 0 : weight,lastAt,weightAt:lastAt})
    }
    this.state.links = links
    for (const [id,attempt] of this.attempts) if (attempt.ts < now-L.historyMs) this.attempts.delete(id)
    for (const [key,queue] of this.recentInput) {
      const live = queue.filter(expires=>expires >= now)
      if (live.length) this.recentInput.set(key,live)
      else this.recentInput.delete(key)
    }
    for (const [key,ts] of this.lastPair) if (ts < now-L.historyMs) this.lastPair.delete(key)
  }
  private baseline(): void {
    this.delivered.agents = new Map(this.state.agents.map(a => [a.id, JSON.stringify(a)]))
    this.delivered.links = new Map(this.state.links.map(l => [l.id, JSON.stringify(l)]))
    this.delivered.events = new Set(this.state.recentEvents.map(e => e.id))
    this.delivered.departments = JSON.stringify(this.state.departments)
    this.delivered.seats = JSON.stringify(this.state.seats)
    this.delivered.externalNodes = JSON.stringify(this.state.externalNodes)
    this.delivered.statusCounts = JSON.stringify(this.state.statusCounts)
    this.changedEvents.clear()
  }
  private delta(): OfficeDelta | null {
    const changed = <T extends { id: string }>(rows: T[], before: Map<string, string>) => {
      const next = new Map<string, string>(), updates: T[] = []
      for (const row of rows) { const signature = JSON.stringify(row); next.set(row.id, signature); if (before.get(row.id) !== signature) updates.push(row) }
      const removed = [...before.keys()].filter(id => !next.has(id))
      return { updates, removed, next }
    }
    this.state.statusCounts = statusCounts(this.state.agents)
    const agents = changed(this.state.agents, this.delivered.agents), links = changed(this.state.links, this.delivered.links)
    const eventIds = new Set(this.state.recentEvents.map(e => e.id))
    const delta: OfficeDelta = { session: this.state.session, generation: this.state.generation,
      baseVersion: this.state.version ?? 0, version: (this.state.version ?? 0) + 1,
      agents: agents.updates, removedAgents: agents.removed, links: links.updates, removedLinks: links.removed,
      events: this.state.recentEvents.filter(e => !this.delivered.events.has(e.id) || this.changedEvents.has(e.id)),
      removedEvents: [...this.delivered.events].filter(id => !eventIds.has(id)) }
    for (const key of ['departments', 'seats', 'externalNodes', 'statusCounts'] as const) {
      const signature = JSON.stringify(this.state[key])
      if (signature !== this.delivered[key]) Object.assign(delta, { [key]: this.state[key] })
      this.delivered[key] = signature
    }
    this.delivered.agents = agents.next; this.delivered.links = links.next; this.delivered.events = eventIds; this.changedEvents.clear()
    if (!delta.agents.length && !delta.removedAgents.length && !delta.links.length && !delta.removedLinks.length &&
        !delta.events.length && !delta.removedEvents.length && !delta.departments && !delta.seats && !delta.externalNodes && !delta.statusCounts) return null
    this.state.version = delta.version
    return delta
  }
  /** Public for deterministic synthetic verification; production uses the 100ms timer. */
  flush(): void {
    if (!this.watching) return
    const now = this.now()
    const maintenance = now - this.lastPrune >= 1000
    if (this.dirty || maintenance) this.prune()
    this.active = this.active.filter(ts=>ts > now-L.pairAnimationMs)
    this.pending = this.pending.filter(p=>p.ts >= now-L.animationTtlMs)
    const animations: OfficeAnimation[] = []
    if (this.visible) for (const p of [...this.pending]) {
      const pair = JSON.stringify([p.from,p.to])
      if (this.active.length >= L.maxAnimations) break
      if ((this.lastPair.get(pair) ?? -Infinity) > now-L.pairAnimationMs) continue
      animations.push({...p}); this.lastPair.set(pair,now); this.active.push(now)
      this.pending.splice(this.pending.indexOf(p),1)
    }
    if (this.visible && (this.dirty || maintenance || animations.length)) {
      const delta = this.delta()
      if (delta) this.publish({ delta: structuredClone(delta), animations })
      else if (animations.length) this.publish({ delta: { session: this.state.session, generation: this.state.generation,
        baseVersion: this.state.version ?? 0, version: (this.state.version ?? 0) + 1,
        agents: [], removedAgents: [], links: [], removedLinks: [], events: [], removedEvents: [] }, animations })
      if (!delta && animations.length) this.state.version = (this.state.version ?? 0) + 1
    }
    this.dirty = false
  }
}
function roleName(name: string): OfficeRole {
  if (/orchestrat|lead|boss|coordinator/i.test(name)) return 'lead'
  if (/review/i.test(name)) return 'reviewer'
  if (/devops|infra/i.test(name)) return 'devops'
  if (/frontend|front-end/i.test(name)) return 'frontend'
  if (/backend|back-end/i.test(name)) return 'backend'
  if (/docs|document/i.test(name)) return 'docs'
  if (/design|artist/i.test(name)) return 'designer'
  return 'general'
}
function roleOf(template: RoleTemplate): OfficeRole { return template.orchestrator ? 'lead' : roleName(template.name) }
