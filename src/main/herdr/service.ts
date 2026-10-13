import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { dirname, join } from 'node:path'
import { withRestoreMutex, type RestoreGuard } from '../agentRestore'
import type {
  AgentStatus,
  ConnectionState,
  HerdrSessionInfo,
  HerdrSnapshot,
  PaneInfo
} from '@shared/types'
import { HerdrApiError } from '@shared/types'
import { loginEnv } from '../env'
import { HerdrClient, type SubscriptionHandle } from './client'
import { CodexLaunch } from '../codexLaunch'
import { machineLaunchArgs } from '../machines/launch'
import {
  defaultSocketPath,
  findHerdr,
  herdrVersion,
  listSessions,
  runHerdr,
  sessionArgs,
  startServer,
  type CliResult
} from './cli'

const LIFECYCLE_EVENTS = [
  'workspace.created',
  'workspace.updated',
  'workspace.renamed',
  'workspace.moved',
  'workspace.reordered',
  'workspace.closed',
  'workspace.focused',
  'worktree.created',
  'worktree.opened',
  'worktree.removed',
  'tab.created',
  'tab.closed',
  'tab.focused',
  'tab.renamed',
  'tab.moved',
  'pane.created',
  'pane.closed',
  'pane.updated',
  'pane.focused',
  'pane.moved',
  'pane.exited',
  'pane.agent_detected',
  'layout.updated'
]

export interface StatusChange {
  pane: PaneInfo
  from: AgentStatus | undefined
  to: AgentStatus
  name: string | null
}

type Events = {
  snapshot: [HerdrSnapshot]
  connection: [ConnectionState]
  'status-change': [StatusChange]
}

export class HerdrService extends EventEmitter<Events> {
  env: NodeJS.ProcessEnv = {}
  herdrPath: string | null = null
  client: HerdrClient | null = null
  snapshot: HerdrSnapshot | null = null
  connection: ConnectionState = { status: 'connecting', session: 'default' }

  private session = 'default'
  private lifecycleSub: SubscriptionHandle | null = null
  private statusSub: SubscriptionHandle | null = null
  private statusPaneKey = ''
  private refreshTimer: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private refreshing: { client: HerdrClient; generation: number } | null = null
  private refreshQueued = false
  private lastSnapshotJson = ''
  private generation = 0
  agentRestore?: {
    prepare(session: string, dir: string, version: string | null, guard: RestoreGuard): Promise<void>
    restore(client: HerdrClient, current: () => boolean): Promise<void>
    sessionDir(dir: string | null): void
    observe(snapshot: HerdrSnapshot): void
    launched(params: Record<string, unknown>): Promise<void>
  }
  private sessionDir: string | null = null
  private startedHere = false
  private startedChild: ChildProcess | null = null
  private startDeadline = 0
  private starting: Promise<boolean> | null = null
  readonly codexLaunch = new CodexLaunch(() => this.env)

  constructor(
    private opts: { logDir: string; autoStartServer: () => boolean; isolatedHerdrDir?: string; machineInstructions?: (cwd: string) => Promise<string | null> }
  ) {
    super()
  }

  get sessionName(): string {
    return this.session
  }
  get connectionGeneration(): number { return this.generation }

  private setConnection(patch: Partial<ConnectionState>) {
    this.connection = { ...this.connection, ...patch, session: this.session }
    this.emit('connection', this.connection)
  }

  async start(session: string, refreshEnv = false): Promise<void> {
    this.stop()
    const gen = ++this.generation
    this.session = session || 'default'
    this.startedHere = false
    this.snapshot = null
    this.lastSnapshotJson = ''
    this.setConnection({ status: 'connecting', error: undefined, version: undefined })

    const env = await loginEnv(refreshEnv)
    if (gen !== this.generation) return
    this.env = this.opts.isolatedHerdrDir ? { ...env, HERDR_CONFIG_PATH: this.opts.isolatedHerdrDir } : env
    this.codexLaunch.reset()
    this.herdrPath = findHerdr(this.env)
    if (!this.herdrPath) {
      this.setConnection({ status: 'no-herdr', error: 'herdr binary not found in PATH' })
      return
    }
    let socketPath = defaultSocketPath(this.session, this.env)
    this.sessionDir = null
    try {
      const sessions = await listSessions(this.herdrPath, this.env)
      const found = sessions.find((s) => s.name === this.session)
      if (found?.socket_path) socketPath = found.socket_path
      this.sessionDir = found?.session_dir ?? null
    } catch {
      /* use computed path */
    }
    if (gen !== this.generation) return
    this.agentRestore?.sessionDir(this.sessionDir)
    this.client = new HerdrClient(socketPath)
    this.setConnection({ socketPath, herdrPath: this.herdrPath })
    await this.connect(gen, true)
  }

  stop() {
    this.generation++
    this.startedHere = false
    this.startedChild = null
    this.startDeadline = 0
    this.refreshing = null
    this.refreshQueued = false
    this.lifecycleSub?.close()
    this.statusSub?.close()
    this.lifecycleSub = null
    this.statusSub = null
    this.statusPaneKey = ''
    for (const t of [this.refreshTimer, this.pollTimer, this.reconnectTimer]) if (t) clearTimeout(t)
    this.refreshTimer = this.pollTimer = this.reconnectTimer = null
  }

  private async connect(gen: number, allowAutoStart: boolean): Promise<void> {
    if (!this.client || gen !== this.generation) return
    try {
      const pong = await this.client.request<{ version?: string; pid?: number; server_pid?: number }>('ping', {}, 4000)
      if (gen !== this.generation) return
      this.connection.version = pong?.version
      if (this.startedHere && this.agentRestore && this.startedChild) {
        const client = this.client
        const child = this.startedChild
        const pid = pong.server_pid ?? pong.pid
        // Herdr 0.9.4 pong has no server PID. In that protocol, only a live
        // child spawned by this attempt and a pong in its start window may
        // authorize fallback. An external start in that window remains a race.
        const owned = child.exitCode === null && child.signalCode === null && Date.now() <= this.startDeadline &&
          (pid === undefined || Number.isSafeInteger(pid) && pid === child.pid)
        if (owned) await this.agentRestore.restore(client, () => gen === this.generation && client === this.client && child === this.startedChild && child.exitCode === null && child.signalCode === null)
        if (gen !== this.generation) return
        this.startedHere = false
        this.startedChild = null
      }
      this.setConnection({ status: 'connected', error: undefined, version: pong?.version })
      this.subscribeLifecycle(gen)
      await this.refresh()
      this.schedulePoll(gen)
    } catch (err) {
      if (gen !== this.generation) return
      const code = err instanceof HerdrApiError ? err.code : 'connection_failed'
      if (code === 'server_not_running' || code === 'connection_failed' || code === 'connection_closed') {
        if (allowAutoStart && this.opts.autoStartServer()) {
          await this.startServerAndWait(gen)
          return
        }
        this.setConnection({ status: 'server-stopped', error: (err as Error).message })
      } else {
        this.setConnection({ status: 'disconnected', error: (err as Error).message })
      }
      this.scheduleReconnect(gen)
    }
  }

  async startServerAndWait(gen = this.generation): Promise<boolean> {
    if (this.starting) return this.starting
    const starting = this.startServerAttempt(gen)
    this.starting = starting
    try { return await starting } finally { if (this.starting === starting) this.starting = null }
  }
  private async startServerAttempt(gen: number): Promise<boolean> {
    if (!this.herdrPath || !this.client) return false
    const client = this.client, session = this.session, path = this.herdrPath
    const current = () => gen === this.generation && client === this.client
    const assertStopped = async () => {
      if (!current()) throw new HerdrApiError('session_changed', 'The herdr session changed before startup')
      try { await client.request('ping', {}, 1000) }
      catch (e) { if (e instanceof HerdrApiError && e.code === 'server_not_running') return; throw e }
      throw new HerdrApiError('restore_server_running', 'The herdr server started during restore preparation')
    }
    // This method is also an explicit UI action. An already-running server
    // must never have its persisted session rewritten or be started twice.
    try {
      await client.request('ping', {}, 2000)
      if (gen !== this.generation) return false
      await this.connect(gen, false)
      return this.connection.status === 'connected'
    } catch (error) {
      if (gen !== this.generation || !(error instanceof HerdrApiError) || error.code !== 'server_not_running') return false
    }
    this.setConnection({ status: 'starting-server', error: undefined })
    try {
      const dir = this.sessionDir ?? dirname(client.socketPath)
      await withRestoreMutex(join(dir, 'session.json'), async () => {
        await assertStopped()
        const version = await herdrVersion(path, this.env)
        await assertStopped()
        if (this.sessionDir && this.agentRestore) {
          // Best-effort external-start guard; Herdr owns socket startup/cleanup.
          await this.agentRestore.prepare(session, dir, version, { serialized: true, assertStopped: async () => {
            const latestVersion = await herdrVersion(path, this.env)
            if (latestVersion !== version) throw new HerdrApiError('restore_version_changed', 'The herdr version changed during migration')
            await assertStopped()
          } })
        }
        await assertStopped()
        const child = startServer(path, session, this.env, this.opts.logDir)
        // A failed spawn cannot authorize fallback. Herdr owns stale sockets.
        child.on('error', () => { if (this.startedChild === child) { this.startedChild = null; this.startedHere = false } })
        await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
        if (!current()) return
        this.startedChild = child
        this.startedHere = child.exitCode === null && child.signalCode === null
        this.startDeadline = Date.now() + 15000
      })
    } catch (error) {
      if (!current()) return false
      this.startedHere = false; this.startedChild = null
      this.setConnection({ status: 'server-stopped', error: error instanceof HerdrApiError ? `Could not prepare agent restore (${error.code})` : 'Could not prepare agent restore' })
      return false
    }
    const deadline = this.startDeadline || Date.now() + 15000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 350))
      if (gen !== this.generation) return false
      try {
        await client.request('ping', {}, 2000)
        await this.connect(gen, false)
        return this.connection.status === 'connected'
      } catch {
        /* keep waiting */
      }
    }
    this.setConnection({ status: 'server-stopped', error: 'herdr server did not start in time' })
    this.startedHere = false; this.startedChild = null
    this.scheduleReconnect(gen)
    return false
  }

  private scheduleReconnect(gen: number) {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect(gen, false)
    }, 2500)
  }

  private schedulePoll(gen: number) {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null
      if (gen !== this.generation) return
      await this.refresh()
      if (gen === this.generation && this.connection.status === 'connected') this.schedulePoll(gen)
    }, 4000)
  }

  private subscribeLifecycle(gen: number) {
    if (!this.client) return
    this.lifecycleSub?.close()
    this.lifecycleSub = this.client.subscribe(
      LIFECYCLE_EVENTS.map((type) => ({ type })),
      {
        onEvent: () => this.scheduleRefresh(),
        onClose: () => {
          if (gen !== this.generation) return
          this.lifecycleSub = null
          this.statusSub?.close()
          this.statusSub = null
          this.statusPaneKey = ''
          this.setConnection({ status: 'disconnected', error: 'lost connection to herdr server' })
          this.scheduleReconnect(gen)
        }
      }
    )
  }

  /** Agent status events are pane-scoped, so the subscription follows the pane set. */
  private syncStatusSubscription(snapshot: HerdrSnapshot) {
    if (!this.client) return
    const ids = snapshot.panes.map((p) => p.pane_id).sort()
    const key = ids.join(',')
    if (key === this.statusPaneKey && this.statusSub && !this.statusSub.closed) return
    this.statusSub?.close()
    this.statusSub = null
    this.statusPaneKey = key
    if (!ids.length) return
    const gen = this.generation
    this.statusSub = this.client.subscribe(
      ids.map((pane_id) => ({ type: 'pane.agent_status_changed', pane_id })),
      {
        onEvent: () => this.scheduleRefresh(15),
        onClose: () => {
          if (gen !== this.generation) return
          this.statusPaneKey = ''
        }
      }
    )
  }

  scheduleRefresh(delay = 60) {
    if (this.refreshTimer) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      void this.refresh()
    }, delay)
  }

  async refresh(): Promise<void> {
    if (!this.client || this.startedHere) return
    if (this.refreshing) {
      this.refreshQueued = true
      return
    }
    const operation = { client: this.client, generation: this.generation }
    this.refreshing = operation
    const current = () => this.client === operation.client && this.generation === operation.generation
    try {
      const res = await operation.client.request<{ snapshot: HerdrSnapshot }>('session.snapshot', {}, 8000)
      if (!current()) return
      const snap = res.snapshot
      this.agentRestore?.observe(snap)
      const json = JSON.stringify(snap)
      if (json !== this.lastSnapshotJson) {
        const prev = this.snapshot
        this.lastSnapshotJson = json
        this.snapshot = snap
        this.detectStatusChanges(prev, snap)
        this.emit('snapshot', snap)
      }
      if (this.connection.status !== 'connected') this.setConnection({ status: 'connected', error: undefined })
      this.syncStatusSubscription(snap)
    } catch (err) {
      if (!current()) return
      if (err instanceof HerdrApiError && (err.code === 'server_not_running' || err.code === 'connection_failed')) {
        if (this.connection.status === 'connected') {
          this.setConnection({ status: 'disconnected', error: err.message })
          this.scheduleReconnect(this.generation)
        }
      }
    } finally {
      if (current() && this.refreshing === operation) {
        this.refreshing = null
        if (this.refreshQueued) {
          this.refreshQueued = false
          this.scheduleRefresh(10)
        }
      }
    }
  }

  private detectStatusChanges(prev: HerdrSnapshot | null, next: HerdrSnapshot) {
    if (!prev) return
    const before = new Map(prev.panes.map((p) => [p.pane_id, p.agent_status]))
    const names = new Map(next.agents.map((a) => [a.pane_id, a.name ?? null]))
    for (const pane of next.panes) {
      const from = before.get(pane.pane_id)
      const to = pane.agent_status
      if (from !== to && pane.agent) {
        this.emit('status-change', { pane, from, to, name: names.get(pane.pane_id) ?? null })
      }
    }
  }

  async request<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number
  ): Promise<T> {
    if (!this.client) throw new HerdrApiError('not_connected', 'not connected to herdr')
    const client = this.client, generation = this.generation
    if (method === 'agent.start' && this.opts.machineInstructions) {
      const pane = this.snapshot?.panes.find(p => p.pane_id === params.pane_id)
      const cwd = pane?.foreground_cwd || pane?.cwd
      const pointer = cwd ? await this.opts.machineInstructions(cwd) : null
      if (pointer) params = { ...params, args: machineLaunchArgs(String(params.kind), Array.isArray(params.args) ? params.args as string[] : [], pointer) }
      if (client !== this.client || generation !== this.generation) throw new HerdrApiError('session_changed', 'The herdr session changed before agent launch')
    }
    if (method === 'agent.start' && params.kind === 'codex') {
      params = { ...params, args: await this.codexLaunch.args(Array.isArray(params.args) ? params.args as string[] : []) }
      if (client !== this.client || generation !== this.generation) throw new HerdrApiError('session_changed', 'The herdr session changed before agent launch')
    }
    const result = await client.request<T>(method, params, timeoutMs)
    if (method === 'agent.start' && client === this.client && generation === this.generation) await this.agentRestore?.launched(params)
    if (client === this.client && generation === this.generation && !method.endsWith('.list') && !method.endsWith('.get') && !method.endsWith('.read') && method !== 'session.snapshot') {
      this.scheduleRefresh(30)
    }
    return result
  }

  async listSessions(): Promise<HerdrSessionInfo[]> {
    if (!this.herdrPath) return []
    return listSessions(this.herdrPath, this.env)
  }

  async cli(args: string[], timeoutMs?: number): Promise<CliResult> {
    if (!this.herdrPath) return { code: 127, stdout: '', stderr: 'herdr not found' }
    return runHerdr(this.herdrPath, [...sessionArgs(this.session), ...args], this.env, timeoutMs)
  }

  async version(): Promise<string | null> {
    if (!this.herdrPath) return null
    return herdrVersion(this.herdrPath, this.env)
  }
}
