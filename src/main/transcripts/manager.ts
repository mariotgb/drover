import { randomUUID } from 'node:crypto'
import { OFFICE_LIMITS } from '@shared/office'
import type { HerdrSnapshot, PaneInfo, TranscriptCursor, TranscriptMeta, TranscriptUpdate } from '@shared/types'
import type { HerdrService } from '../herdr/service'
import { ItemStore } from './store'
import { TranscriptWorkers } from './workerClient'
import {
  findClaudeTranscript,
  findCodexRollout,
  guessClaudeTranscript,
  guessCodexRollout,
  processStartTime
} from './locate'
import type { TranscriptParser } from './store'
import { TranscriptRevisions } from './revisions'

type Kind = 'claude' | 'codex'

interface Sub {
  paneId: string
  refs: number
  officeRefs: number
  kind: Kind | null
  sessionId: string | null
  exactId: string | null
  path: string | null
  located: 'exact' | 'heuristic'
  parser: TranscriptParser | null
  tailer: { stop(): void; sync(): Promise<void> } | null
  officeParser: TranscriptParser | null
  officeTailer: { stop(): void; sync(): Promise<void> } | null
  retry: NodeJS.Timeout | null
  teardown: NodeJS.Timeout | null
  loading: Promise<void> | null
  generation: number
  revision: number
  history: TranscriptRevisions
  again: boolean
  error?: string
  processStart?: number | null
}

const SUPPORTED: Kind[] = ['claude', 'codex']

export class TranscriptManager {
  private subs = new Map<string, Sub>()
  private stream = randomUUID()
  private revision = 0
  private workers: TranscriptWorkers
  private lookupCount = 0
  private lookupWaiters: Array<() => void> = []

  constructor(
    private service: HerdrService,
    private send: (update: TranscriptUpdate) => void,
    private observeOffice: (update: TranscriptUpdate) => void = () => {},
    workerPath?: string
  ) { this.workers = new TranscriptWorkers(workerPath) }

  private pane(paneId: string): PaneInfo | undefined {
    return this.service.snapshot?.panes.find((p) => p.pane_id === paneId)
  }

  async subscribe(paneId: string, retain = true, cursor?: TranscriptCursor, office = false): Promise<TranscriptUpdate> {
    let sub = this.subs.get(paneId)
    if (sub) {
      if (retain) { if (office) sub.officeRefs++; else sub.refs++ }
      if (!office && sub.teardown) { clearTimeout(sub.teardown); sub.teardown = null }
      await sub.loading
      if (office ? !sub.officeTailer : !sub.tailer) await this.locate(sub)
      else await (office ? sub.officeTailer : sub.tailer)?.sync()
      return office ? this.full(sub, true) : sub.history.resume(this.full(sub), cursor)
    }
    sub = {
      paneId,
      refs: office ? 0 : 1,
      officeRefs: office ? 1 : 0,
      kind: null,
      sessionId: null,
      exactId: this.pane(paneId)?.agent_session?.value ?? null,
      path: null,
      located: 'exact',
      parser: null,
      tailer: null,
      officeParser: null,
      officeTailer: null,
      retry: null,
      teardown: null,
      loading: null,
      generation: 0,
      revision: ++this.revision,
      history: new TranscriptRevisions(),
      again: false
    }
    this.subs.set(paneId, sub)
    await this.locate(sub)
    return this.full(sub, office)
  }

  subscribeOffice(paneId: string): Promise<TranscriptUpdate> { return this.subscribe(paneId, true, undefined, true) }

  unsubscribeOffice(paneId: string) {
    const sub = this.subs.get(paneId)
    if (!sub) return
    sub.officeRefs = Math.max(0, sub.officeRefs - 1)
    if (!sub.officeRefs) { sub.officeTailer?.stop(); sub.officeTailer = null; sub.officeParser = null }
    if (!sub.officeRefs && !sub.refs) this.drop(sub)
  }

  unsubscribe(paneId: string) {
    const sub = this.subs.get(paneId)
    if (!sub) return
    sub.refs = Math.max(0, sub.refs - 1)
    if (sub.refs > 0 || sub.teardown) return
    // Keep recently viewed transcripts warm so switching threads is instant.
    sub.teardown = setTimeout(() => {
      sub.teardown = null
      if (sub.refs) return
      sub.tailer?.stop(); sub.tailer = null; sub.parser = null; sub.history.clear()
      if (!sub.officeRefs) this.drop(sub)
    }, 90_000)
    sub.teardown.unref?.()
  }

  private drop(sub: Sub) {
    sub.tailer?.stop()
    sub.officeTailer?.stop()
    if (sub.retry) clearTimeout(sub.retry)
    if (sub.teardown) clearTimeout(sub.teardown)
    this.subs.delete(sub.paneId)
  }

  dispose() {
    for (const sub of [...this.subs.values()]) this.drop(sub)
    this.workers.dispose()
  }

  /** Called on every herdr snapshot: follow /clear, /new, agent restarts. */
  onSnapshot(snapshot: HerdrSnapshot) {
    for (const sub of this.subs.values()) {
      const pane = snapshot.panes.find((p) => p.pane_id === sub.paneId)
      const kind = normalizeKind(pane?.agent)
      const exactId = pane?.agent_session?.value ?? null
      const changedKind = kind !== sub.kind
      const changedSession = exactId !== sub.exactId
      if (changedKind || changedSession) {
        this.reset(sub)
        sub.exactId = exactId
        void this.locate(sub)
      }
    }
  }

  private reset(sub: Sub) {
    sub.generation++
    sub.revision = ++this.revision
    sub.history.clear()
    sub.tailer?.stop()
    sub.tailer = null
    sub.officeTailer?.stop(); sub.officeTailer = null; sub.officeParser = null
    sub.parser = null
    sub.path = null
    sub.sessionId = null
    sub.error = undefined
    sub.processStart = undefined
  }

  private meta(sub: Sub, office = false): TranscriptMeta | null {
    const parser = office ? sub.officeParser : sub.parser
    if (!parser || !sub.path || !sub.kind) return null
    const m = parser.meta
    return {
      agent: sub.kind,
      sessionId: sub.sessionId ?? m.sessionId ?? '',
      path: sub.path,
      title: m.title,
      model: m.model,
      effort: m.effort,
      cwd: m.cwd,
      contextTokens: m.contextTokens,
      contextWindow: m.contextWindow,
      rateLimitPercent: m.rateLimitPercent,
      located: sub.located,
      ...(office ? { coverage: 'tail' as const } : {})
    }
  }

  private full(sub: Sub, office = false): TranscriptUpdate {
    const parser = office ? sub.officeParser : sub.parser
    return {
      paneId: sub.paneId,
      stream: this.stream,
      revision: sub.revision,
      reset: true,
      meta: this.meta(sub, office),
      items: parser ? parser.store.items.slice() : [],
      error: sub.error
    }
  }

  private publish(sub: Sub, update: TranscriptUpdate, office = false) {
    if (!office) sub.history.record(update)
    if (this.subs.get(sub.paneId) !== sub) return
    if (office && sub.officeRefs > 0) this.observeOffice(update)
    if (!office && sub.refs > 0) this.send(update)
  }

  private claimedIds(except: string): Set<string> {
    const ids = new Set<string>()
    for (const p of this.service.snapshot?.panes ?? []) {
      if (p.pane_id !== except && p.agent_session?.value) ids.add(p.agent_session.value)
    }
    for (const s of this.subs.values()) {
      if (s.paneId !== except && s.sessionId) ids.add(s.sessionId)
    }
    return ids
  }

  private locate(sub: Sub): Promise<void> {
    if (this.subs.get(sub.paneId) !== sub) return Promise.resolve()
    if (sub.loading) { sub.again = true; return sub.loading }
    const load = this.locateOnce(sub).finally(async () => {
      sub.loading = null
      if (sub.again) { sub.again = false; await this.locate(sub) }
    })
    sub.loading = load
    return load
  }

  private async locateOnce(sub: Sub): Promise<void> {
    if (this.lookupCount >= OFFICE_LIMITS.lookupConcurrency) await new Promise<void>(resolve => this.lookupWaiters.push(resolve))
    else this.lookupCount++
    try {
      if (this.subs.get(sub.paneId) === sub) await this.locateLimited(sub)
    } finally {
      const next = this.lookupWaiters.shift()
      if (next) next()
      else this.lookupCount--
    }
  }

  private async locateLimited(sub: Sub): Promise<void> {
    const generation = sub.generation
    if (sub.retry) {
      clearTimeout(sub.retry)
      sub.retry = null
    }
    const pane = this.pane(sub.paneId)
    const kind = normalizeKind(pane?.agent)
    sub.kind = kind
    if (!pane) {
      sub.error = 'pane-closed'
      this.publish(sub, this.full(sub)); if (sub.officeRefs) this.publish(sub, this.full(sub, true), true)
      return
    }
    if (!kind) {
      sub.error = pane.agent ? 'unsupported-agent' : 'no-agent'
      this.publish(sub, this.full(sub)); if (sub.officeRefs) this.publish(sub, this.full(sub, true), true)
      return
    }
    const env = this.service.env
    const exactId = pane.agent_session?.value ?? null
    sub.sessionId = exactId
    sub.exactId = exactId
    let path: string | null = null
    let sessionId: string | null = null
    let located: 'exact' | 'heuristic' = 'exact'
    if (exactId) {
      path = kind === 'claude' ? await findClaudeTranscript(env, exactId, pane.cwd) : await findCodexRollout(env, exactId)
      sessionId = exactId
    }
    if (!path && !exactId) {
      const start = await this.agentStart(sub)
      if (start) {
        const cwds = [...new Set([pane.foreground_cwd, pane.cwd].filter((c): c is string => !!c))]
        const claimed = this.claimedIds(sub.paneId)
        const guess =
          kind === 'claude'
            ? await guessClaudeTranscript(env, cwds, start, claimed)
            : await guessCodexRollout(env, cwds, start, claimed)
        if (guess) {
          path = guess.path
          sessionId = guess.sessionId
          located = 'heuristic'
        }
      }
    }
    if (this.subs.get(sub.paneId) !== sub || generation !== sub.generation) return
    if (!path) {
      sub.error = 'not-found'
      sub.revision = ++this.revision
      this.publish(sub, this.full(sub)); if (sub.officeRefs) this.publish(sub, this.full(sub, true), true)
      this.scheduleRetry(sub)
      return
    }
    if (this.subs.get(sub.paneId) !== sub || generation !== sub.generation) return
    sub.path = path
    sub.sessionId = sessionId
    sub.located = located
    sub.error = undefined
    const starts: Promise<void>[] = []
    for (const office of [true, false]) {
      if (office ? !sub.officeRefs || sub.officeTailer : !sub.refs || sub.tailer) continue
      const parser: TranscriptParser = { store: new ItemStore(), meta: {}, feed: () => {} }
      if (office) sub.officeParser = parser
      else sub.parser = parser
      const current = () => this.subs.get(sub.paneId) === sub && generation === sub.generation && (office ? sub.officeParser : sub.parser) === parser
      const stream = this.workers.open(path, kind, office, batch => {
        if (!current()) return
        if (batch.reset) parser.store = new ItemStore()
        parser.meta = batch.meta
        for (const item of batch.items) parser.store.upsert(item)
        if (office) parser.store.trim(512)
        if (!batch.initial) {
          sub.revision = ++this.revision
          this.publish(sub, { paneId: sub.paneId, stream: this.stream, revision: sub.revision,
            reset: office ? batch.baseline : batch.reset, meta: this.meta(sub, office), items: batch.items }, office)
        }
        parser.store.clearChanges()
      }, (error, fatal) => {
        if (!current()) return
        sub.error = error
        if (fatal) {
          if (office) { sub.officeTailer = null; sub.officeParser = null }
          else { sub.tailer = null; sub.parser = null; sub.history.clear() }
          sub.revision = ++this.revision
          this.scheduleRetry(sub)
        }
        this.publish(sub, this.full(sub, office), office)
      })
      if (office) sub.officeTailer = stream
      else sub.tailer = stream
      starts.push(stream.loaded.then(() => {
        if (!current()) return
        sub.revision = ++this.revision
        this.publish(sub, this.full(sub, office), office)
      }))
    }
    await Promise.all(starts)
  }

  private async agentStart(sub: Sub): Promise<number | null> {
    if (sub.processStart !== undefined) return sub.processStart
    try {
      const res = await this.service.request<{ process_info?: { foreground_processes?: { pid: number }[] } }>(
        'pane.process_info',
        { pane_id: sub.paneId },
        5000
      )
      const pids = (res.process_info?.foreground_processes ?? []).map((p) => p.pid).filter(Boolean)
      let earliest: number | null = null
      for (const pid of pids) {
        const t = await processStartTime(pid)
        if (t !== null && (earliest === null || t < earliest)) earliest = t
      }
      sub.processStart = earliest
      return earliest
    } catch {
      return null
    }
  }

  private scheduleRetry(sub: Sub) {
    if (sub.retry || !this.subs.has(sub.paneId)) return
    sub.retry = setTimeout(() => {
      sub.retry = null
      if (this.subs.has(sub.paneId) && (!sub.path || (sub.refs > 0 && !sub.tailer) || (sub.officeRefs > 0 && !sub.officeTailer))) void this.locate(sub)
    }, 2500)
  }
}

function normalizeKind(agent: string | null | undefined): Kind | null {
  if (!agent) return null
  const k = agent.toLowerCase()
  return (SUPPORTED as string[]).includes(k) ? (k as Kind) : null
}
