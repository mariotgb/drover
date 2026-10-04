import { randomUUID } from 'node:crypto'
import type { HerdrSnapshot, PaneInfo, TranscriptCursor, TranscriptMeta, TranscriptUpdate } from '@shared/types'
import type { HerdrService } from '../herdr/service'
import { ClaudeParser } from './claude'
import { CodexParser } from './codex'
import {
  findClaudeTranscript,
  findCodexRollout,
  guessClaudeTranscript,
  guessCodexRollout,
  processStartTime
} from './locate'
import type { TranscriptParser } from './store'
import { FileTailer } from './tail'
import { TranscriptRevisions } from './revisions'

type Kind = 'claude' | 'codex'

interface Sub {
  paneId: string
  refs: number
  kind: Kind | null
  sessionId: string | null
  path: string | null
  located: 'exact' | 'heuristic'
  parser: TranscriptParser | null
  tailer: FileTailer | null
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

  constructor(
    private service: HerdrService,
    private send: (update: TranscriptUpdate) => void
  ) {}

  private pane(paneId: string): PaneInfo | undefined {
    return this.service.snapshot?.panes.find((p) => p.pane_id === paneId)
  }

  async subscribe(paneId: string, retain = true, cursor?: TranscriptCursor): Promise<TranscriptUpdate> {
    let sub = this.subs.get(paneId)
    if (sub) {
      if (retain) sub.refs++
      if (sub.teardown) {
        clearTimeout(sub.teardown)
        sub.teardown = null
      }
      await sub.loading
      return sub.history.resume(this.full(sub), cursor)
    }
    sub = {
      paneId,
      refs: 1,
      kind: null,
      sessionId: null,
      path: null,
      located: 'exact',
      parser: null,
      tailer: null,
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
    return this.full(sub)
  }

  unsubscribe(paneId: string) {
    const sub = this.subs.get(paneId)
    if (!sub) return
    sub.refs = Math.max(0, sub.refs - 1)
    if (sub.refs > 0 || sub.teardown) return
    // Keep recently viewed transcripts warm so switching threads is instant.
    sub.teardown = setTimeout(() => this.drop(sub), 90_000)
  }

  private drop(sub: Sub) {
    sub.tailer?.stop()
    if (sub.retry) clearTimeout(sub.retry)
    if (sub.teardown) clearTimeout(sub.teardown)
    this.subs.delete(sub.paneId)
  }

  dispose() {
    for (const sub of [...this.subs.values()]) this.drop(sub)
  }

  /** Called on every herdr snapshot: follow /clear, /new, agent restarts. */
  onSnapshot(snapshot: HerdrSnapshot) {
    for (const sub of this.subs.values()) {
      const pane = snapshot.panes.find((p) => p.pane_id === sub.paneId)
      const kind = normalizeKind(pane?.agent)
      const exactId = pane?.agent_session?.value ?? null
      const changedKind = kind !== sub.kind
      const changedSession = !!exactId && exactId !== sub.sessionId
      if (changedKind || changedSession) {
        this.reset(sub)
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
    sub.parser = null
    sub.path = null
    sub.sessionId = null
    sub.error = undefined
    sub.processStart = undefined
  }

  private meta(sub: Sub): TranscriptMeta | null {
    if (!sub.parser || !sub.path || !sub.kind) return null
    const m = sub.parser.meta
    return {
      agent: sub.kind,
      sessionId: sub.sessionId ?? m.sessionId ?? '',
      path: sub.path,
      title: m.title,
      model: m.model,
      cwd: m.cwd,
      contextTokens: m.contextTokens,
      contextWindow: m.contextWindow,
      rateLimitPercent: m.rateLimitPercent,
      located: sub.located
    }
  }

  private full(sub: Sub): TranscriptUpdate {
    return {
      paneId: sub.paneId,
      stream: this.stream,
      revision: sub.revision,
      reset: true,
      meta: this.meta(sub),
      items: sub.parser ? sub.parser.store.items.slice() : [],
      error: sub.path ? undefined : sub.error
    }
  }

  private publish(sub: Sub, update: TranscriptUpdate) {
    sub.history.record(update)
    this.send(update)
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
      this.publish(sub, this.full(sub))
      return
    }
    if (!kind) {
      sub.error = pane.agent ? 'unsupported-agent' : 'no-agent'
      this.publish(sub, this.full(sub))
      return
    }
    const env = this.service.env
    const exactId = pane.agent_session?.value ?? null
    sub.sessionId = exactId
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
      this.publish(sub, this.full(sub))
      this.scheduleRetry(sub)
      return
    }
    if (path === sub.path) return
    sub.tailer?.stop()
    sub.path = path
    sub.sessionId = sessionId
    sub.located = located
    sub.error = undefined
    sub.parser = kind === 'claude' ? new ClaudeParser() : new CodexParser()
    const tailer = new FileTailer(
      path,
      (lines, reset) => {
        if (sub.tailer !== tailer) return
        if (reset) sub.parser = kind === 'claude' ? new ClaudeParser() : new CodexParser()
        const parser = sub.parser!
        parser.feed(lines)
        sub.revision = ++this.revision
        if (reset) {
          parser.store.clearChanges()
          this.publish(sub, this.full(sub))
        } else {
          const items = parser.store.takeChanges()
          this.publish(sub, { paneId: sub.paneId, stream: this.stream, revision: sub.revision, reset: false, meta: this.meta(sub), items })
        }
      },
      () => {
        /* transient read errors are retried by the poll */
      }
    )
    sub.tailer = tailer
    await tailer.start()
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
      if (this.subs.has(sub.paneId) && !sub.path) void this.locate(sub)
    }, 2500)
  }
}

function normalizeKind(agent: string | null | undefined): Kind | null {
  if (!agent) return null
  const k = agent.toLowerCase()
  return (SUPPORTED as string[]).includes(k) ? (k as Kind) : null
}
