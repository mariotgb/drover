import type { DroverApi } from '../../preload/api'
import type { AppSettings, ConnectionState, HerdrSnapshot } from '@shared/types'
import { t } from './i18n'

interface SessionState { settings: AppSettings; connection: ConnectionState; snapshot: HerdrSnapshot | null; selectedPaneId?: string | null }
interface SessionStore {
  getState(): SessionState
  setState(patch: Partial<SessionState>): void
  subscribe(fn: (state: SessionState) => void): () => void
}
const generations = new WeakMap<SessionStore, number>()

/** Called only after the user confirms leaving the current session. Never creates a boss. */
export async function switchBossSession(session: string, bridge: Pick<DroverApi, 'setSettings' | 'init' | 'bossRoster'>, store: SessionStore, timeoutMs = 30_000) {
  const initial = store.getState()
  const previousSnapshot = initial.snapshot
  const generation = (generations.get(store) ?? 0) + 1
  generations.set(store, generation)
  let cancelled: Error | null = null
  let wake: ((state: SessionState) => void) | null = null
  let rejectCancellation: (error: Error) => void = () => {}
  const cancellation = new Promise<never>((_, reject) => { rejectCancellation = reject })
  const cancel = () => {
    if (cancelled) return
    cancelled = new Error(t('Session switch was cancelled.'))
    rejectCancellation(cancelled)
  }
  const current = () => {
    if (generations.get(store) !== generation) cancel()
    if (cancelled) throw cancelled
  }
  // Subscribe before the first IPC await. The expected owner echo is allowed;
  // a newer choice/settings event for another session cancels this transaction.
  const off = store.subscribe(state => {
    if (generations.get(store) !== generation ||
        (state.settings !== initial.settings && state.settings.session !== session) ||
        (state.connection.session !== initial.connection.session && state.connection.session !== session)) cancel()
    wake?.(state)
  })
  const deadline = Date.now() + timeoutMs
  const connected = (state: SessionState) => state.connection.status === 'connected' && state.connection.session === session
  const active = async <T,>(pending: Promise<T>): Promise<T> => {
    current()
    const value = await Promise.race([pending, cancellation])
    current()
    return value
  }
  const waitFor = async (ready: (state: SessionState) => boolean) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await active(new Promise<void>((resolve, reject) => {
        wake = state => { if (ready(state)) resolve() }
        timer = setTimeout(() => reject(new Error(t('Could not connect to herdr session {session}.', { session }))), Math.max(0, deadline - Date.now()))
        wake(store.getState())
      }))
    } finally { clearTimeout(timer); wake = null }
  }
  try {
    const settings = await active(bridge.setSettings({ session }))
    // A settings echo (or a newer edit in the owner session) may precede the
    // response. Preserve it instead of applying the older full settings object.
    if (store.getState().settings === initial.settings) store.setState({ settings })
    await waitFor(connected)
    let init = await active(bridge.init())
    // A connected ping can precede the first snapshot. Wait for that session's data.
    if (!init.snapshot) {
      await waitFor(state => connected(state) && !!state.snapshot && state.snapshot !== previousSnapshot)
      init = await active(bridge.init())
    }
    if (store.getState().settings.session !== session || init.settings.session !== session || init.connection.session !== session || init.connection.status !== 'connected' || !init.snapshot) {
      throw new Error(t('Could not connect to herdr session {session}.', { session }))
    }
    store.setState({ connection: init.connection, snapshot: init.snapshot, selectedPaneId: null })
    const roster = await active(bridge.bossRoster())
    if (roster.session !== session || roster.needsSessionSwitch || store.getState().connection.session !== session || store.getState().settings.session !== session) {
      throw new Error(t('The boss session changed. Refresh before opening it.'))
    }
    return roster
  } finally { off() }
}
