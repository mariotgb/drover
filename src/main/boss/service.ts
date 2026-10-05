import { createHash, randomUUID } from 'node:crypto'
import { join, resolve, sep } from 'node:path'
import { agentKindDef } from '@shared/agents'
import type { AgentInfo, HerdrSnapshot } from '@shared/types'
import type { AgentLaunch } from '@shared/agentRestart'
import { modelArgs, type ModelChoice } from '@shared/models'
import { projectLeadRoster, type BossAssignment, type BossBroadcastRequest, type BossDelivery, type BossLead, type BossOpenRequest, type BossOpenResult, type BossRoster, type BossSettings } from '@shared/boss'
import type { HerdrService } from '../herdr/service'
import { HerdrClient } from '../herdr/client'
import { defaultSocketPath } from '../herdr/cli'
import { createAgent, sendPrompt } from '../actions'
import { ensureBoard } from '../tasks'
import { BossSettingsStore, writeBossJson, type BossBinding } from './store'
import { which } from '../env'
import { provisionHq } from './hq'
import { BossLocalServer } from './local'
import { formatBossAssignment, parseBossReply } from './protocol'
import { access, readFile, readdir, unlink } from 'node:fs/promises'

interface BossRuntime {
  instructions?: string
  version?: string
  executable?: string
  kindInstalled?: (kind: string) => boolean
  replyAccepted?: (fromPaneId: string, toPaneId: string, receiptId: string, ts: number) => void
  restoreAllowed?: () => boolean
  snapshotForSession?: (session: string) => Promise<HerdrSnapshot | null>
}

interface Pending {
  delivery: BossDelivery
  text: string
  session: string
  identity: string
  expires: number
  from?: BossLead
  bossIdentity?: string
}
const identity = (agent: AgentInfo) => JSON.stringify([agent.terminal_id, agent.agent_session, agent.agent, agent.name])
const RECEIPT_LIMIT = 10_000

/** Native resume arguments, matching herdr's agent_resume plans. */
export function bossResumeArgs(kind: string, value: string): string[] {
  if (kind === 'codex') return ['resume', value]
  if (['copilot', 'omp'].includes(kind)) return [`--resume=${value}`]
  if (['pi', 'opencode', 'kilo', 'kimi'].includes(kind)) return ['--session', value]
  if (kind === 'mastracode') return ['--thread', value]
  if (kind === 'agy') return ['--conversation', value]
  if (kind === 'letta') return value.startsWith('default:') ? ['--conversation', 'default', '--agent', value.slice(8)] : ['--conversation', value]
  return ['claude', 'devin', 'droid', 'hermes', 'qodercli', 'qwen', 'cursor', 'grok'].includes(kind) ? ['--resume', value] : []
}

/** Threat model: agents share one OS user, so files, socket tokens and inherited
 * environment are not security boundaries against deliberate tampering. Normal
 * helper calls must come from the bound live pane/incarnation. Only a prompt
 * delivered by this main process can close an expectation; JSON on disk and
 * transcript notifications never establish provenance. The recent receipt index
 * is bounded; older accepted IDs remain immutable tombstones in a private archive.
 */
export class BossService {
  private ready: Promise<void>
  private writes: Promise<void> = Promise.resolve()
  private lastRoster = ''
  private pending: Pending[] = []
  private draining = false
  private opening: Promise<BossOpenResult> | null = null
  private broadcasts: Promise<void> = Promise.resolve()
  private inFlight = new Set<string>()
  private timer: NodeJS.Timeout
  private folders = new Set<string>()
  private disposed = false
  private setup = new Set<string>()
  private local: BossLocalServer
  private assignments = new Map<string, BossAssignment[]>()
  private acceptedReceipts = new Map<string, Set<string>>()
  private ledgerWrites: Promise<void> = Promise.resolve()
  private scanning = false
  private restoreAfter = 0
  private ownerSnapshot: HerdrSnapshot | null = null
  private ownerRead: Promise<void> | null = null
  constructor(private service: HerdrService, private store: BossSettingsStore,
    private leads: () => Record<string, string>, private deliveryChanged: (delivery: BossDelivery) => void,
    private accepted: (paneId: string, text: string, fromPaneId?: string) => void,
    private runtime: BossRuntime = {}) {
    this.folders.add(store.get().hqFolder)
    this.ready = store.load().then(() => {
      this.folders.add(store.get().hqFolder)
      const binding = store.globalBinding()
      if (binding) this.folders.add(binding.folder)
    })
    this.local = new BossLocalServer(request => this.helperRequest(request))
    this.timer = setInterval(() => {
      void this.drain()
      void this.scanReplies().catch(error => console.warn('[boss] reply scan failed:', String(error)))
      void this.restore().catch(error => console.warn('[boss] restore failed:', String(error)))
    }, 1000)
    this.timer.unref()
  }
  async settings(): Promise<BossSettings> { await this.ready; return { ...this.store.get(), hqFolder: this.store.globalBinding()?.folder ?? this.store.get().hqFolder } }
  async setSettings(patch: Partial<BossSettings>): Promise<BossSettings> {
    await this.ready
    const binding = this.store.globalBinding()
    if (binding && patch.hqFolder && resolve(patch.hqFolder) !== binding.folder) throw new Error('The Main boss is already bound to its headquarters')
    // Serialize settings changes alongside roster writes, preserving their order.
    let next!: BossSettings
    const operation = this.writes.then(async () => { next = await this.store.set(patch); this.folders.add(next.hqFolder); this.lastRoster = '' })
    this.writes = operation.catch(() => undefined)
    await operation
    await this.refresh()
    void this.drain()
    return next
  }
  private current(): BossRoster {
    const settings = this.store.get()
    const binding = this.store.globalBinding()
    const foreign = !!binding && binding.session !== this.service.sessionName
    const snapshot = foreign ? this.ownerSnapshot : this.service.snapshot
    const folder = binding?.folder ?? settings.hqFolder
    const agent = snapshot?.agents.find(a => binding ? a.pane_id === binding.paneId && a.agent === binding.kind : this.isBoss(a.pane_id))
    return { session: binding?.session ?? this.service.sessionName, hqFolder: folder, ...(foreign ? { needsSessionSwitch: true } : {}),
      boss: agent ? { paneId: agent.pane_id, name: agent.name!, kind: agent.agent, status: agent.agent_status } : null,
      projects: projectLeadRoster(snapshot, this.leads(), settings.excludedProjects, folder)
        .filter(p => !p.cwd || !this.isHqFolder(p.cwd)) }
  }
  async roster(): Promise<BossRoster> { await this.refresh(); return this.current() }
  async refresh(): Promise<void> {
    await this.ready
    await this.captureBinding()
    await this.readOwnerSnapshot()
    const roster = this.current()
    const content = JSON.stringify(roster)
    const operation = this.writes.then(async () => {
      if (content === this.lastRoster) return
      await this.prepare(roster.hqFolder, roster.boss?.kind ?? null)
      await writeBossJson(join(roster.hqFolder, 'roster.json'), roster)
      this.lastRoster = content
    })
    this.writes = operation.catch(() => undefined)
    await operation
    await this.scanReplies()
  }
  onChange(): void {
    void this.refresh().then(() => this.restore()).catch(error => console.warn('[boss] roster refresh failed:', String(error)))
    void this.drain()
  }
  isHqFolder(folder: string): boolean {
    const normalized = resolve(folder)
    return [...this.folders].some(hq => normalized === hq || normalized.startsWith(hq + sep))
  }
  private hqWorkspaces(): Set<string> {
    return new Set((this.service.snapshot?.panes ?? []).filter(p => p.cwd && this.isHqFolder(p.cwd)).map(p => p.workspace_id))
  }
  isHqPane(paneId: string): boolean {
    const pane = this.service.snapshot?.panes.find(p => p.pane_id === paneId)
    return !!pane && this.hqWorkspaces().has(pane.workspace_id)
  }
  isBoss(paneId: string): boolean {
    const pane = this.service.snapshot?.panes.find(p => p.pane_id === paneId)
    if (this.store.globalBinding() && this.store.globalBinding()!.session !== this.service.sessionName) return false
    const binding = this.store.binding(this.service.sessionName)
    if (binding) return paneId === binding.paneId && !!pane && !!this.service.snapshot?.agents.some(a => a.pane_id === paneId && a.agent === binding.kind)
    return !!pane && this.service.snapshot!.panes.some(p => p.workspace_id === pane.workspace_id && p.cwd === this.store.get().hqFolder) &&
      !!this.service.snapshot?.agents.some(a => a.pane_id === paneId && /^drover-boss(?:-\d+)?$/.test(a.name ?? ''))
  }
  async open(req: BossOpenRequest): Promise<BossOpenResult> {
    await this.ready
    const definition = req && typeof req.kind === 'string' ? agentKindDef(req.kind) : undefined
    if (!req || !definition || definition.kind !== req.kind || typeof req.prompt !== 'string' || !req.prompt.trim() || req.prompt.length > 256 * 1024 ||
        (req.args !== undefined && (!Array.isArray(req.args) || req.args.length > 100 || req.args.some(a => typeof a !== 'string' || a.includes('\0') || a.length > 8192)))) throw new Error('Invalid boss request')
    const owner = this.store.globalBinding()
    if (owner && owner.session !== this.service.sessionName) return { ok: false, existing: true,
      needsSessionSwitch: true, session: owner.session, folder: owner.folder, paneId: owner.paneId, workspaceId: owner.workspaceId,
      error: `The Main boss belongs to session ${owner.session}. Confirm switching to that session to open it.` }
    if (this.opening) return this.opening
    await this.captureBinding()
    const existing = this.current().boss
    if (existing) return { ok: true, folder: this.current().hqFolder, paneId: existing.paneId, existing: true }
    const binding = this.store.binding(this.service.sessionName)
    if (binding) return this.startBound(binding)
    const installed = this.runtime.kindInstalled ? this.runtime.kindInstalled(req.kind) : definition.binaries.some(binary => which(binary, this.service.env ?? process.env))
    if (!installed) throw new Error(`Agent is not installed: ${req.kind}`)
    if (this.opening) return this.opening
    this.opening = this.openHq(req).finally(() => { this.opening = null })
    return this.opening
  }
  private async openHq(req: BossOpenRequest): Promise<BossOpenResult> {
    const session = this.service.sessionName
    if (req.folder !== undefined) await this.setSettings({ hqFolder: req.folder })
    await this.refresh()
    const folder = this.store.get().hqFolder
    await ensureBoard(folder)
    await this.prepare(folder, req.kind)
    const snapshot = this.service.snapshot
    const panes = (snapshot?.panes ?? []).filter(p => p.cwd === folder)
    const existing = snapshot?.agents.find(a => panes.some(p => p.workspace_id === a.workspace_id) && /^drover-boss(?:-\d+)?$/.test(a.name ?? ''))
    if (existing) {
      await this.captureBinding()
      return { ok: true, folder, paneId: existing.pane_id, workspaceId: existing.workspace_id, existing: true }
    }
    const shell = panes.find(p => !p.agent && !snapshot?.agents.some(a => a.pane_id === p.pane_id))
    const workspaceId = panes[0]?.workspace_id ?? null
    if (this.disposed || session !== this.service.sessionName) return { ok: false, folder, error: 'The HQ session has changed' }
    // Reserve and persist the location before launching: a crash or a startup
    // dialog cannot make the next click allocate another boss pane.
    const location = await createAgent(this.service, { kind: null, name: 'drover-boss', folder, workspaceId,
      args: [],
      workspaceLabel: 'Штаб', tabLabel: 'Главный босс', placement: shell ? 'existing' : 'tab',
      splitTarget: shell?.pane_id })
    if (!location.ok || !location.paneId) return { ...location, folder }
    if (session !== this.service.sessionName) return { ok: false, folder, error: 'The HQ session has changed' }
    await this.service.refresh?.()
    const pane = this.service.snapshot?.panes.find(p => p.pane_id === location.paneId)
    if (!pane) return { ok: false, folder, error: 'HQ pane has not appeared in the session snapshot' }
    const binding: BossBinding = { session, folder, paneId: pane.pane_id,
      workspaceId: pane.workspace_id, kind: req.kind, name: 'drover-boss', args: req.args ?? [], prompt: req.prompt }
    await this.persistBinding(binding)
    return this.launchBound(binding)
  }

  private async persistBinding(binding: BossBinding): Promise<void> {
    const operation = this.writes.then(() => this.store.bind(binding))
    this.writes = operation.catch(() => undefined)
    await operation
    this.folders.add(binding.folder)
  }
  private async changeBinding(session: string, paneId: string, kind: string,
    change: (latest: BossBinding | null) => BossBinding | null): Promise<void> {
    const operation = this.writes.then(async () => {
      const latest = this.store.globalBinding()
      if (latest && (latest.session !== session || latest.paneId !== paneId || latest.kind !== kind)) return
      const next = change(latest)
      if (!next || JSON.stringify(next) === JSON.stringify(latest)) return
      await this.store.bind(next)
      this.folders.add(next.folder)
    })
    this.writes = operation.catch(() => undefined)
    await operation
  }
  async recordChoice(paneId: string, kind: string, choice: ModelChoice): Promise<void> {
    const session = this.service.sessionName
    await this.ready
    await this.changeBinding(session, paneId, kind, binding => {
      if (!binding) return null
      const model = choice.model?.trim()
      const effort = choice.effort?.trim()
      const args: string[] = []
      for (let i = 0; i < binding.args.length; i++) {
        const flag = binding.args[i]
        // Model menus send null for the field they did not change. Preserve its
        // actual launch option so a later resume uses the same model and effort.
        if ((model && ['-m', '--model'].includes(flag)) || (effort && flag === '--effort')) { i++; continue }
        if (effort && (flag === '-c' || flag === '--config') && binding.args[i + 1]?.startsWith('model_reasoning_effort=')) { i++; continue }
        if ((model && /^--model=/.test(flag)) || (effort && /^--effort=/.test(flag))) continue
        args.push(flag)
      }
      return { ...binding, args: [...args, ...modelArgs(kind, choice)] }
    })
  }
  async recordRestart(paneId: string, launch: AgentLaunch): Promise<void> {
    const session = this.service.sessionName
    await this.ready
    const args: string[] = []
    for (let i = 0; i < launch.args.length; i++) {
      const arg = launch.args[i]
      if ((launch.kind === 'codex' && ['resume', 'fork'].includes(arg)) ||
          (launch.kind === 'claude' && ['--resume', '-r', '--session-id'].includes(arg))) { i++; continue }
      if (launch.kind === 'claude' && /^--(?:resume|session-id)=/.test(arg)) continue
      args.push(arg)
    }
    await this.changeBinding(session, paneId, launch.kind, binding => binding ? { ...binding, args, agentSession: launch.sessionId ? {
      agent: launch.kind, kind: 'id', value: launch.sessionId, source: 'drover:restart'
    } : undefined } : null)
  }
  private async captureBinding(): Promise<void> {
    const session = this.service.sessionName
    if (this.store.globalBinding() && this.store.globalBinding()!.session !== session) return
    const binding = this.store.binding(session)
    const agent = this.service.snapshot?.agents.find(a => binding ? a.pane_id === binding.paneId : this.isBoss(a.pane_id))
    if (!agent || (binding && agent.agent !== binding.kind)) return
    const next: BossBinding = binding ? { ...binding, name: agent.name || binding.name, agentSession: agent.agent_session ?? binding.agentSession } : {
      session, folder: this.store.get().hqFolder, workspaceId: agent.workspace_id, paneId: agent.pane_id,
      name: agent.name || 'drover-boss', kind: agent.agent, args: [], prompt: 'Read the HQ instructions and wait for the user.', agentSession: agent.agent_session
    }
    // Snapshot observations must merge after earlier writes, preserving the
    // actual restart/model options and a newer native session reported meanwhile.
    await this.changeBinding(session, agent.pane_id, agent.agent, latest => latest ? {
      ...latest, name: agent.name || latest.name,
      agentSession: JSON.stringify(latest.agentSession) === JSON.stringify(binding?.agentSession)
        ? agent.agent_session ?? latest.agentSession : latest.agentSession
    } : next)
  }
  private startBound(binding: BossBinding): Promise<BossOpenResult> {
    if (this.opening) return this.opening
    this.opening = this.launchBound(binding).finally(() => { this.opening = null })
    return this.opening
  }
  private async launchBound(binding: BossBinding): Promise<BossOpenResult> {
    if (this.disposed || binding.session !== this.service.sessionName) return { ok: false, folder: binding.folder, error: 'The HQ session has changed' }
    const snapshot = this.service.snapshot
    const client = this.service.client, generation = this.service.connectionGeneration
    const pane = snapshot?.panes.find(p => p.pane_id === binding.paneId && p.workspace_id === binding.workspaceId && p.cwd === binding.folder)
    if (!pane) return { ok: false, folder: binding.folder, paneId: binding.paneId, error: 'The existing HQ pane is unavailable; reconnect to its session' }
    const occupant = snapshot?.agents.find(a => a.pane_id === binding.paneId)
    if (occupant || pane.agent) return { ok: !!occupant && occupant.agent === binding.kind, folder: binding.folder, paneId: binding.paneId,
      workspaceId: binding.workspaceId, existing: true, ...(occupant?.agent === binding.kind ? {} : { error: 'The HQ pane is occupied' }) }
    await ensureBoard(binding.folder)
    await this.prepare(binding.folder, binding.kind)
    if (this.disposed || binding.session !== this.service.sessionName || client !== this.service.client || generation !== this.service.connectionGeneration) return { ok: false, folder: binding.folder, error: 'The HQ connection has changed' }
    const ref = binding.agentSession
    const resume = ref?.agent === binding.kind && ref.value ? bossResumeArgs(binding.kind, ref.value) : []
    const result = await createAgent(this.service, { kind: binding.kind, name: binding.name, folder: binding.folder,
      workspaceId: binding.workspaceId, placement: 'existing', splitTarget: binding.paneId,
      args: [...binding.args, ...resume], prompt: resume.length ? undefined : binding.prompt })
    if (binding.session !== this.service.sessionName || client !== this.service.client || generation !== this.service.connectionGeneration) {
      return { ok: false, folder: binding.folder, paneId: binding.paneId, code: 'session_changed', error: 'The HQ connection has changed' }
    }
    if (!result.ok) return { ...result, folder: binding.folder, workspaceId: binding.workspaceId, existing: true }
    await this.service.refresh?.()
    await this.refresh()
    return { ...result, folder: binding.folder, workspaceId: binding.workspaceId, existing: true }
  }
  private async restore(): Promise<void> {
    await this.ready
    if (this.disposed || this.opening || this.runtime.restoreAllowed?.() === false ||
        this.service.connection?.status !== 'connected' || !this.service.snapshot || Date.now() < this.restoreAfter) return
    const binding = this.store.binding(this.service.sessionName)
    if (!binding || this.current().boss) return
    this.restoreAfter = Date.now() + 30_000
    const result = await this.startBound(binding)
    if (!result.ok) console.warn('[boss] restore failed:', result.error)
  }
  private async readOwnerSnapshot(): Promise<void> {
    const binding = this.store.globalBinding()
    if (!binding || binding.session === this.service.sessionName) { this.ownerSnapshot = null; return }
    if (this.ownerRead) return this.ownerRead
    this.ownerRead = (async () => {
      try {
        this.ownerSnapshot = this.runtime.snapshotForSession ? await this.runtime.snapshotForSession(binding.session) :
          (await new HerdrClient(defaultSocketPath(binding.session, this.service.env ?? {})).request<{ snapshot: HerdrSnapshot }>('session.snapshot', {}, 5000)).snapshot
      } catch { this.ownerSnapshot = null }
    })().finally(() => { this.ownerRead = null })
    return this.ownerRead
  }
  async broadcast(req: BossBroadcastRequest): Promise<BossDelivery[]> {
    if (!req || typeof req.text !== 'string' || !req.text.trim() || req.text.length > 256 * 1024 ||
      (req.projectKeys !== undefined && (!Array.isArray(req.projectKeys) || req.projectKeys.length > 1000 || req.projectKeys.some(k => typeof k !== 'string')))) throw new Error('Invalid broadcast')
    const request = structuredClone(req)
    const operation = this.broadcasts.then(() => this.broadcastNow(request))
    this.broadcasts = operation.then(() => undefined, () => undefined)
    return operation
  }
  private async broadcastNow(req: BossBroadcastRequest, assignment?: BossAssignment): Promise<BossDelivery[]> {
    await this.refresh()
    const roster = this.current()
    if (roster.session !== this.service.sessionName) throw new Error('Switch to the Main boss session before sending assignments')
    const projects = req.projectKeys ? [...new Set(req.projectKeys)].map(key => {
      const project = roster.projects.find(p => p.key === key)
      if (!project) throw new Error(`Unknown project: ${key}`)
      return project
    }) : roster.projects.filter(p => p.enabled)
    const results: BossDelivery[] = []
    for (const project of projects) {
      const delivery: BossDelivery = assignment?.projects.find(p => p.projectKey === project.key) ?? { id: randomUUID(), projectKey: project.key, projectName: project.name, lead: project.lead, status: 'no_lead' }
      if (!project.enabled) delivery.status = 'excluded'
      else if (project.lead) {
        const agent = this.service.snapshot?.agents.find(a => a.pane_id === project.lead!.paneId)
        if (!agent) delivery.status = 'no_lead'
        else {
          const text = assignment ? formatBossAssignment(assignment.id, project.key, assignment.boss.name, req.text, join(roster.hqFolder, 'bin', 'boss')) : req.text
          const pending = { delivery, text, session: roster.session, identity: identity(agent), expires: Date.now() + 20 * 60_000, from: assignment?.boss, bossIdentity: assignment?.bossIdentity }
          if (this.pending.length >= 1000) Object.assign(delivery, { status: 'error', code: 'queue_full' })
          else if (agent.agent_status === 'blocked') delivery.status = 'blocked'
          else if (this.inFlight.has(agent.pane_id) || this.pending.some(p => p.delivery.lead?.paneId === agent.pane_id) || !this.canSend(agent)) {
            delivery.status = 'queued'; this.pending.push(pending)
          } else await this.deliver(pending)
        }
      }
      results.push(structuredClone(delivery))
      if (assignment) await this.updateAssignment(delivery)
    }
    return results
  }
  private canSend(agent: AgentInfo): boolean {
    return ['idle', 'done'].includes(agent.agent_status) && !agent.launch_pending && agent.interactive_ready !== false
  }
  private async prepare(folder: string, kind: string | null): Promise<void> {
    const key = JSON.stringify([folder, kind, this.runtime.version, this.runtime.instructions])
    if (!this.setup.has(key)) {
      await provisionHq(folder, kind, this.runtime.instructions ?? 'Read roster.json and .drover/tasks.json. Wait for the user.', this.runtime.version ?? 'development', this.runtime.executable ?? process.execPath)
      await this.loadAssignments(folder)
      this.setup.add(key)
    }
    await this.local.start(folder, { herdrPath: this.service.herdrPath ?? null, session: this.store.globalBinding()?.session ?? this.service.sessionName })
  }
  private async loadAssignments(folder: string): Promise<void> {
    if (this.assignments.has(folder)) return
    let requests: BossAssignment[] = []
    let acceptedReceiptIds: string[] = []
    try {
      const data = JSON.parse(await readFile(join(folder, '.drover', 'boss-requests.json'), 'utf8'))
      if (data?.version !== 1 || !Array.isArray(data.requests) || data.requests.length > 1100 ||
          data.requests.some((r: BossAssignment) => !r || typeof r.id !== 'string' || !r.boss || !Array.isArray(r.projects))) throw new Error('Invalid HQ request ledger')
      requests = data.requests
      if (data.acceptedReceiptIds !== undefined && (!Array.isArray(data.acceptedReceiptIds) || data.acceptedReceiptIds.length > RECEIPT_LIMIT || data.acceptedReceiptIds.some((id: unknown) => typeof id !== 'string'))) throw new Error('Invalid HQ receipt ledger')
      acceptedReceiptIds = data.acceptedReceiptIds ?? []
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    // Queue text lives only in memory. Never report an undelivered request as
    // delivered or replay it automatically after an application restart.
    for (const request of requests) for (const project of request.projects) if (project.status === 'queued') {
      project.status = 'error'; project.code = 'queue_lost'; project.awaitingReply = false
    }
    this.assignments.set(folder, requests)
    this.acceptedReceipts.set(folder, new Set(acceptedReceiptIds))
    if (requests.length) await this.persistAssignments(folder)
  }
  private async persistAssignments(folder: string): Promise<void> {
    const value = structuredClone({ version: 1, requests: this.assignments.get(folder) ?? [], acceptedReceiptIds: [...(this.acceptedReceipts.get(folder) ?? [])] })
    const operation = this.ledgerWrites.then(() => writeBossJson(join(folder, '.drover', 'boss-requests.json'), value))
    this.ledgerWrites = operation.catch(() => undefined)
    return operation
  }
  private async updateAssignment(delivery: BossDelivery): Promise<void> {
    for (const [folder, requests] of this.assignments) {
      const record = requests.flatMap(r => r.projects).find(p => p.id === delivery.id)
      if (!record) continue
      Object.assign(record, delivery)
      if (delivery.status === 'delivered' && !record.repliedAt) record.awaitingReply = true
      else if (delivery.status !== 'delivered') record.awaitingReply = false
      await this.persistAssignments(folder)
    }
  }
  private async authorizeCaller(request: Record<string, unknown>, expected: BossLead, expectedIdentity: string): Promise<AgentInfo> {
    if (!expectedIdentity || request.paneId !== expected.paneId ||
        (request.session !== undefined && request.session !== this.service.sessionName))
      throw new Error('Unauthorized HQ sender: run the helper from the assigned agent pane in the same session')
    const { agent } = await this.service.request<{ agent: AgentInfo }>('agent.get', { target: expected.paneId }, 5000)
    if (!agent || agent.pane_id !== expected.paneId || agent.name !== expected.name || agent.agent !== expected.kind || identity(agent) !== expectedIdentity)
      throw new Error('Unauthorized HQ sender: the assigned agent incarnation has changed')
    return agent
  }
  private async helperRequest(request: Record<string, unknown>): Promise<unknown> {
    if (request.method === 'roster') return this.roster()
    if (!['send', 'reply'].includes(String(request.method)) || typeof request.project !== 'string' || typeof request.text !== 'string' || !request.text.trim() || request.text.length > 256 * 1024 ||
        (request.id !== undefined && (typeof request.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(request.id)))) throw new Error('Invalid HQ helper request')
    const operation = this.broadcasts.then(async () => {
      await this.refresh()
      const roster = this.current()
      if (!roster.boss) throw new Error('No Main boss is running in HQ')
      if (request.method === 'reply') return this.replyNow(request, roster)
      const boss = this.service.snapshot?.agents.find(a => a.pane_id === roster.boss!.paneId)
      if (!boss) throw new Error('No Main boss is running in HQ')
      const bossIdentity = identity(boss)
      await this.authorizeCaller(request, roster.boss, bossIdentity)
      if (roster.session !== this.service.sessionName || !this.isBoss(boss.pane_id)) throw new Error('The Main boss session has changed')
      const matches = request.project === 'all' ? roster.projects.filter(p => p.enabled) : roster.projects.filter(p => p.key === request.project || p.name === request.project)
      if (request.project !== 'all' && matches.length !== 1) throw new Error('Use a project key or a unique project name')
      const id = typeof request.id === 'string' ? request.id : randomUUID()
      const requestHash = createHash('sha256').update(JSON.stringify([roster.session, matches.map(p => p.key), request.text])).digest('hex')
      const requests = this.assignments.get(roster.hqFolder)!
      const existing = requests.find(r => r.id === id) ?? await this.archivedAssignment(roster.hqFolder, id)
      if (existing) {
        if (existing.requestHash !== requestHash) throw new Error('This assignment ID belongs to a different request')
        return structuredClone(existing)
      }
      await this.rotateAssignments(roster.hqFolder)
      const needsSlot = matches.some(p => p.enabled && p.lead && p.lead.status !== 'blocked')
      if (needsSlot && requests.filter(r => this.activeAssignment(r)).length >= 1000) throw new Error('HQ has 1000 active assignments; collect replies before sending more')
      const assignment: BossAssignment = { id, session: roster.session, createdAt: Date.now(), boss: roster.boss, bossIdentity, requestHash,
        projects: matches.map(p => ({ id: randomUUID(), projectKey: p.key, projectName: p.name, lead: p.lead,
          leadIdentity: this.leadIdentity(p.lead),
          status: 'no_lead', awaitingReply: false })) }
      requests.push(assignment)
      // Persist ID before the first send, so interruption cannot cause a resend.
      await this.persistAssignments(roster.hqFolder)
      await this.broadcastNow({ text: request.text as string, projectKeys: matches.map(p => p.key) }, assignment)
      await this.rotateAssignments(roster.hqFolder)
      return structuredClone(assignment)
    })
    this.broadcasts = operation.then(() => undefined, () => undefined)
    return operation
  }
  private async replyNow(request: Record<string, unknown>, roster: BossRoster): Promise<unknown> {
    const assignment = this.assignments.get(roster.hqFolder)!.find(r => r.id === request.id && r.session === roster.session)
    const project = assignment?.projects.find(p => p.projectKey === request.project && p.status === 'delivered')
    if (!assignment || !project?.lead || !project.leadIdentity) throw new Error('No delivered assignment matches this project, ID and agent incarnation')
    await this.authorizeCaller(request, project.lead, project.leadIdentity)
    const target = await this.authorizeCaller({ paneId: roster.boss!.paneId, session: roster.session }, assignment.boss, assignment.bossIdentity)
    const currentSource = this.service.snapshot?.agents.find(a => a.pane_id === project.lead!.paneId)
    const currentTarget = this.service.snapshot?.agents.find(a => a.pane_id === target.pane_id)
    if (roster.session !== this.service.sessionName || !currentSource || identity(currentSource) !== project.leadIdentity ||
        !currentTarget || identity(currentTarget) !== assignment.bossIdentity || !this.isBoss(target.pane_id)) throw new Error('The sender or Main boss incarnation has changed')
    if (target.agent_status === 'blocked' || target.launch_pending || target.interactive_ready === false) throw new Error('The Main boss is blocked or not ready; ask the user to answer it')
    const ids = this.acceptedReceipts.get(roster.hqFolder)!
    const receiptId = randomUUID()
    if (await this.receiptAccepted(roster.hqFolder, receiptId)) throw new Error('Duplicate reply receipt; no reply was sent')
    const text = `[Ответ ${project.projectKey} · ${assignment.id}] ${request.text}`
    // The transport returns agent_prompted. No helper-supplied receipt is trusted.
    const result = await this.service.request<{ type: string; agent?: AgentInfo }>('agent.prompt', { target: target.pane_id, text }, 20000)
    if (result.type !== 'agent_prompted' || !result.agent || result.agent.pane_id !== target.pane_id || identity(result.agent) !== assignment.bossIdentity)
      throw new Error('herdr did not confirm reply delivery to the assigned boss incarnation; inspect the boss chat before retrying')
    const ts = Date.now()
    ids.add(receiptId)
    project.awaitingReply = false; project.repliedAt = ts; project.lastReplyReceiptId = receiptId
    delete project.replyUnconfirmed
    // Commit dedup and expectation before emitting any office confirmation.
    try {
      if (ids.size > RECEIPT_LIMIT) {
        const oldest = ids.values().next().value!
        await writeBossJson(this.receiptArchivePath(roster.hqFolder, oldest), { id: oldest })
        ids.delete(oldest)
      }
      await this.persistAssignments(roster.hqFolder)
      await writeBossJson(join(roster.hqFolder, '.drover', 'boss-receipts', receiptId + '.json'), {
        version: 1, type: 'boss_reply', confirmation: 'main', id: receiptId, ts, assignmentId: assignment.id,
        projectKey: project.projectKey, session: roster.session, fromPaneId: project.lead.paneId, toPaneId: target.pane_id
      })
    } catch { throw new Error('Reply delivered, but its metadata could not be saved. Do not resend; inspect the boss chat') }
    this.runtime.replyAccepted?.(project.lead.paneId, target.pane_id, receiptId, ts)
    await this.rotateAssignments(roster.hqFolder)
    return { id: assignment.id, receiptId, projectKey: project.projectKey, status: 'delivered', confirmed: true }
  }
  private activeAssignment(request: BossAssignment): boolean {
    return request.projects.some(p => p.status === 'queued' || p.awaitingReply)
  }
  private leadIdentity(lead: BossLead | null): string | undefined {
    const agent = lead && this.service.snapshot?.agents.find(a => a.pane_id === lead.paneId)
    return agent ? identity(agent) : undefined
  }
  private receiptArchivePath(folder: string, id: string): string {
    return join(folder, '.drover', 'boss-receipt-archive', createHash('sha256').update(id).digest('hex') + '.json')
  }
  private async receiptAccepted(folder: string, id: unknown): Promise<boolean> {
    if (typeof id !== 'string' || id.length > 80) return false
    if (this.acceptedReceipts.get(folder)?.has(id)) return true
    return access(this.receiptArchivePath(folder, id)).then(() => true, error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    })
  }
  private archivePath(folder: string, id: string): string {
    return join(folder, '.drover', 'boss-archive', createHash('sha256').update(id).digest('hex') + '.json')
  }
  private async archivedAssignment(folder: string, id: string): Promise<BossAssignment | undefined> {
    try { return JSON.parse(await readFile(this.archivePath(folder, id), 'utf8')) as BossAssignment }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return undefined }
  }
  private async rotateAssignments(folder: string): Promise<void> {
    const requests = this.assignments.get(folder)!
    let expired = false
    for (const request of requests) if (request.createdAt < Date.now() - 30 * 24 * 60 * 60_000) {
      for (const project of request.projects) if (project.awaitingReply || project.status === 'queued') {
        project.awaitingReply = false; project.status = 'error'; project.code = 'reply_expired'; expired = true
        this.pending = this.pending.filter(p => p.delivery.id !== project.id)
      }
    }
    const completed = requests.filter(r => !this.activeAssignment(r)).sort((a, b) => b.createdAt - a.createdAt)
    const stale = completed.filter((r, i) => i >= 100 || r.createdAt < Date.now() - 30 * 24 * 60 * 60_000)
    if (!stale.length) { if (expired) await this.persistAssignments(folder); return }
    // Immutable metadata archive preserves --id idempotency after rotation.
    for (const request of stale) await writeBossJson(this.archivePath(folder, request.id), request)
    const ids = new Set(stale.map(r => r.id))
    requests.splice(0, requests.length, ...requests.filter(r => !ids.has(r.id)))
    await this.persistAssignments(folder)
  }
  private async scanReplies(): Promise<void> {
    if (this.scanning || this.disposed) return
    this.scanning = true
    try {
      await this.ready
      if (this.store.globalBinding() && this.store.globalBinding()!.session !== this.service.sessionName) return
      for (const folder of this.folders) {
        const directory = join(folder, '.drover', 'boss-receipts')
        let files: string[]
        try { files = await readdir(directory) }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
        await this.loadAssignments(folder)
        for (const file of files.filter(f => /^[a-f0-9-]+\.json$/.test(f)).slice(0, 1000)) {
          const path = join(directory, file)
          let value
          try { value = JSON.parse(await readFile(path, 'utf8')) }
          catch { continue }
          // Main already committed these IDs. Files cannot introduce confirmation,
          // even if their JSON pretends to contain a genuine CLI response.
          if (await this.receiptAccepted(folder, value.id)) { await unlink(path); continue }
          const request = this.assignments.get(folder)!.find(r => r.id === value.assignmentId && r.session === value.session)
          const project = request?.projects.find(p => p.projectKey === value.projectKey)
          if (!request || !project?.lead || project.status !== 'delivered' || value.type !== 'boss_reply' || value.version !== 1 ||
              typeof value.id !== 'string' || value.id.length > 80 || !Number.isFinite(value.ts) || value.ts > Date.now() + 1000 || value.ts < request.createdAt ||
              value.fromPaneId !== project.lead.paneId || value.toPaneId !== request.boss.paneId) continue
          if (!project.repliedAt) {
            project.replyUnconfirmed = { receiptId: value.id, receivedAt: value.ts }
            await this.persistAssignments(folder)
          }
          await unlink(path)
        }
      }
    } finally { this.scanning = false }
  }
  /** A transcript/fallback notification is informational, never main delivery. */
  observeConfirmedReply(fromPaneId: string, toPaneId: string, text: string): void {
    const reply = parseBossReply(text)
    if (!reply) return
    for (const [folder, requests] of this.assignments) {
      const request = requests.find(r => r.id === reply.id && r.session === this.service.sessionName)
      const project = request?.projects.find(p => p.projectKey === reply.project && p.status === 'delivered')
      const agent = this.service.snapshot?.agents.find(a => a.pane_id === fromPaneId)
      const target = this.service.snapshot?.agents.find(a => a.pane_id === toPaneId)
      if (!project?.lead || project.repliedAt || project.lead.paneId !== fromPaneId || !agent || !target ||
          identity(agent) !== project.leadIdentity || identity(target) !== request!.bossIdentity) continue
      project.replyUnconfirmed = { receiptId: `transcript:${reply.id}`, receivedAt: Date.now() }
      void this.persistAssignments(folder).catch(error => console.warn('[boss] reply tracking failed:', String(error)))
    }
  }
  private async deliver(item: Pending): Promise<void> {
    const lead = item.delivery.lead!
    this.inFlight.add(lead.paneId)
    try {
      if (this.disposed || (item.from && !this.service.snapshot?.agents.some(a => a.pane_id === item.from!.paneId && identity(a) === item.bossIdentity && this.isBoss(a.pane_id)))) {
        Object.assign(item.delivery, { status: 'error', code: 'boss_changed' }); return
      }
      const { agent } = await this.service.request<{ agent: AgentInfo }>('agent.get', { target: lead.paneId }, 5000)
      if (item.from) {
        await this.authorizeCaller({ paneId: item.from.paneId, session: item.session }, item.from, item.bossIdentity!)
        const boss = this.service.snapshot?.agents.find(a => a.pane_id === item.from!.paneId)
        if (!boss || identity(boss) !== item.bossIdentity || !this.isBoss(boss.pane_id)) {
          Object.assign(item.delivery, { status: 'error', code: 'boss_changed' }); return
        }
      }
      const project = this.current().projects.find(p => p.key === item.delivery.projectKey)
      if (item.session !== this.service.sessionName || project?.lead?.paneId !== lead.paneId) {
        Object.assign(item.delivery, { status: 'error', code: 'agent_changed' }); return
      }
      if (!project.enabled) { item.delivery.status = 'excluded'; return }
      if (!agent || identity(agent) !== item.identity) { Object.assign(item.delivery, { status: 'error', code: 'agent_changed' }); return }
      lead.status = agent.agent_status
      if (agent.agent_status === 'blocked') { item.delivery.status = 'blocked'; return }
      if (!this.canSend(agent)) { item.delivery.status = 'queued'; return }
      const result = await sendPrompt(this.service, { paneId: lead.paneId, target: lead.paneId, agentKind: lead.kind,
        text: item.text, imagePaths: [], isShell: false }, { requireAgent: true,
          onAccepted: () => item.from ? this.accepted(lead.paneId, item.text, item.from.paneId) : this.accepted(lead.paneId, item.text) })
      Object.assign(item.delivery, result.ok ? { status: 'delivered' } : { status: result.code === 'agent_blocked' ? 'blocked' : result.code === 'agent_not_ready' ? 'queued' : 'error', code: result.code, error: result.error })
      if (result.ok) { delete item.delivery.code; delete item.delivery.error }
    } catch (error) { Object.assign(item.delivery, { status: 'error', code: 'error', error: String(error) }) }
    finally {
      this.inFlight.delete(lead.paneId)
      if (item.delivery.status === 'queued' && !this.pending.includes(item)) this.pending.push(item)
    }
  }
  private async drain(): Promise<void> {
    if (this.draining || this.disposed) return
    this.draining = true
    try {
      await this.ready
      const visited = new Set<string>()
      for (const item of [...this.pending]) {
        const lead = item.delivery.lead!
        if (visited.has(lead.paneId) || this.inFlight.has(lead.paneId)) continue
        visited.add(lead.paneId)
        const project = this.current().projects.find(p => p.key === item.delivery.projectKey)
        const agent = this.service.snapshot?.agents.find(a => a.pane_id === lead.paneId)
        if (item.session !== this.service.sessionName || !agent || identity(agent) !== item.identity || project?.lead?.paneId !== lead.paneId)
          Object.assign(item.delivery, { status: 'error', code: 'agent_changed' })
        else if (!project.enabled) item.delivery.status = 'excluded'
        else if (Date.now() > item.expires) Object.assign(item.delivery, { status: 'error', code: 'queue_expired' })
        else if (agent.agent_status === 'blocked') item.delivery.status = 'blocked'
        else if (this.canSend(agent)) await this.deliver(item)
        if (item.delivery.status !== 'queued') {
          this.pending = this.pending.filter(p => p !== item)
          await this.updateAssignment(item.delivery)
          this.deliveryChanged(structuredClone(item.delivery))
        }
      }
    } finally { this.draining = false }
  }
  dispose(): void { this.disposed = true; clearInterval(this.timer); this.pending = []; this.local.dispose() }
}
