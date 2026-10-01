import { EventEmitter } from 'node:events'
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
  private refreshing = false
  private refreshQueued = false
  private lastSnapshotJson = ''
  private generation = 0

  constructor(
    private opts: { logDir: string; autoStartServer: () => boolean }
  ) {
    super()
  }

  get sessionName(): string {
    return this.session
  }

  private setConnection(patch: Partial<ConnectionState>) {
    this.connection = { ...this.connection, ...patch, session: this.session }
    this.emit('connection', this.connection)
  }

  async start(session: string): Promise<void> {
    this.stop()
    const gen = ++this.generation
    this.session = session || 'default'
    this.snapshot = null
    this.lastSnapshotJson = ''
    this.setConnection({ status: 'connecting', error: undefined, version: undefined })

    this.env = await loginEnv()
    if (gen !== this.generation) return
    this.herdrPath = findHerdr(this.env)
    if (!this.herdrPath) {
      this.setConnection({ status: 'no-herdr', error: 'herdr binary not found in PATH' })
      return
    }
    let socketPath = defaultSocketPath(this.session, this.env)
    try {
      const sessions = await listSessions(this.herdrPath, this.env)
      const found = sessions.find((s) => s.name === this.session)
      if (found?.socket_path) socketPath = found.socket_path
    } catch {
      /* use computed path */
    }
    if (gen !== this.generation) return
    this.client = new HerdrClient(socketPath)
    this.setConnection({ socketPath, herdrPath: this.herdrPath })
    await this.connect(gen, true)
  }

  stop() {
    this.generation++
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
      const pong = await this.client.request<{ version?: string }>('ping', {}, 4000)
      if (gen !== this.generation) return
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
    if (!this.herdrPath || !this.client) return false
    this.setConnection({ status: 'starting-server', error: undefined })
    startServer(this.herdrPath, this.session, this.env, this.opts.logDir)
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 350))
      if (gen !== this.generation) return false
      try {
        await this.client.request('ping', {}, 2000)
        await this.connect(gen, false)
        return true
      } catch {
        /* keep waiting */
      }
    }
    this.setConnection({ status: 'server-stopped', error: 'herdr server did not start in time' })
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
    if (!this.client) return
    if (this.refreshing) {
      this.refreshQueued = true
      return
    }
    this.refreshing = true
    try {
      const res = await this.client.request<{ snapshot: HerdrSnapshot }>('session.snapshot', {}, 8000)
      const snap = res.snapshot
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
      if (err instanceof HerdrApiError && (err.code === 'server_not_running' || err.code === 'connection_failed')) {
        if (this.connection.status === 'connected') {
          this.setConnection({ status: 'disconnected', error: err.message })
          this.scheduleReconnect(this.generation)
        }
      }
    } finally {
      this.refreshing = false
      if (this.refreshQueued) {
        this.refreshQueued = false
        this.scheduleRefresh(10)
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
    const result = await this.client.request<T>(method, params, timeoutMs)
    if (!method.endsWith('.list') && !method.endsWith('.get') && !method.endsWith('.read') && method !== 'session.snapshot') {
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
