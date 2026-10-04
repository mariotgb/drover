import { useSyncExternalStore } from 'react'
import type { DroverApi, InitPayload } from '../../preload/api'
import type { AppSettings, TerminalFrame, TranscriptUpdate } from '@shared/types'
import type { AppearanceSettings } from '@shared/themes'
import { REMOTE_AUTH_ROUTES, REMOTE_METHOD_CHANNELS, REMOTE_WS_PATH, remoteRpcDeadline, type RemoteCall, type RemoteEventChannel, type RemoteManagementApi, type RemotePushApi, type RemoteServerMessage } from '@shared/remote'
import { t } from './i18n'
import { mergeTranscript, type TranscriptState } from './transcript-state'

export type RemoteConnection = 'connecting' | 'connected' | 'offline'
let connection: RemoteConnection = 'connecting'
const connectionListeners = new Set<() => void>()
export const getRemoteConnection = () => connection
export function useRemoteConnection() { return useSyncExternalStore(subscribeRemoteConnection, getRemoteConnection) }
export function subscribeRemoteConnection(fn: () => void) {
  connectionListeners.add(fn)
  return () => { connectionListeners.delete(fn) }
}
function setConnection(next: RemoteConnection) {
  connection = next
  for (const fn of connectionListeners) fn()
}

class RemoteCallError extends Error {
  constructor(public code: string, message: string) { super(message) }
}
const EVENTS: Record<string, RemoteEventChannel> = {
  snapshot: 'herdr:snapshot', connection: 'herdr:connection', termFrames: 'term:frames',
  termClosed: 'term:closed', transcript: 'transcript:update', tasks: 'tasks:changed',
  selectPane: 'app:select-pane', command: 'app:command', windowFocus: 'app:window-focus',
  limits: 'limits:update', remoteStatus: 'remote:status', settings: 'settings:changed'
}

/** Cookie-authenticated, same-origin RPC. Commands are never queued or replayed. */
export function createRemoteApi(): DroverApi & RemoteManagementApi & RemotePushApi {
  document.documentElement.classList.add('drover-remote')
  let generation = 0
  let socket: WebSocket | null = null
  let retry: ReturnType<typeof setTimeout> | undefined
  let attempt = 0
  let sequence = 0
  let opened = false
  let stopped = false
  let selectedPane: string | null = null
  const pending = new Map<string, { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const transcripts = new Set<string>()
  const boards = new Set<string>()
  const terminals = new Set<string>()
  const subscriptionJobs = new Map<string, Promise<unknown>>()
  const transcriptCache = new Map<string, TranscriptState>()
  const deferredTranscripts = new Map<string, TranscriptUpdate[]>()
  const loadingTranscripts = new Map<string, object>()
  const recoveringTranscripts = new Set<string>()
  const stateEvents = new Map<string, { revision: number; value: unknown }>()
  const invalidateTranscript = (key: string) => {
    recoveringTranscripts.add(key)
    const base = transcriptCache.get(key)
    // Keep the visible conversation, but never resume from an incomplete base.
    if (base) transcriptCache.set(key, { ...base, revision: undefined })
  }
  const cacheTranscript = (u: TranscriptUpdate) => {
    let { next } = mergeTranscript(transcriptCache.get(u.paneId), u)
    for (const delta of deferredTranscripts.get(u.paneId) ?? []) next = mergeTranscript(next, delta).next
    deferredTranscripts.delete(u.paneId)
    transcriptCache.set(u.paneId, next)
    return { paneId: u.paneId, reset: true, ...next } satisfies TranscriptUpdate
  }
  const emit = (channel: string, args: unknown[]) => { for (const fn of listeners.get(channel) ?? []) fn(...args) }

  const rpc = (method: string, args: unknown[], timeout = remoteRpcDeadline(method, args)): Promise<unknown> => {
    if (socket?.readyState !== WebSocket.OPEN) return Promise.reject(new RemoteCallError('disconnected', t('No connection')))
    return new Promise((resolve, reject) => {
      const id = `web-${++sequence}`
      const sentSocket = socket
      const timer = setTimeout(() => {
        pending.delete(id)
        if (sentSocket?.readyState === WebSocket.OPEN) try { sentSocket.send(JSON.stringify({ t: 'timeout', id })) } catch { /* Connection lost. */ }
        reject(new RemoteCallError('timeout', t('The server did not respond. Try again.')))
      }, timeout)
      pending.set(id, { method, resolve, reject, timer })
      const message: RemoteCall = { t: 'call', id, method, args }
      try { socket!.send(JSON.stringify(message)) } catch (error) { clearTimeout(timer); pending.delete(id); reject(error) }
    })
  }
  const subscribe = (method: 'transcriptSubscribe' | 'watchTasks', key: string): Promise<unknown> => {
    const jobKey = `${method}:${key}`
    const wanted = method === 'transcriptSubscribe' ? transcripts : boards
    const cached = subscriptionJobs.get(jobKey)
    if (cached) return cached.then(value => {
      const state = method === 'transcriptSubscribe' ? transcriptCache.get(key) : undefined
      return state ? { paneId: key, reset: true, ...state } satisfies TranscriptUpdate : value
    })
    const epoch = generation
    const base = transcriptCache.get(key)
    const cursor = method === 'transcriptSubscribe' && base?.loaded && base.stream && base.revision !== undefined ? { stream: base.stream, revision: base.revision } : undefined
    const loading = {}
    if (method === 'transcriptSubscribe') loadingTranscripts.set(key, loading)
    const job = rpc(method, cursor ? [key, cursor] : [key]).then(value => {
      if (epoch !== generation) throw new RemoteCallError('disconnected', t('No connection'))
      if (method !== 'transcriptSubscribe') return value
      const update = value as TranscriptUpdate
      if (recoveringTranscripts.has(key) && (!update.reset || update.error)) throw new RemoteCallError('snapshot_required', t('The server did not respond. Try again.'))
      const snapshot = cacheTranscript(update)
      recoveringTranscripts.delete(key)
      return snapshot
    }).catch(error => {
      if (epoch === generation && method === 'transcriptSubscribe' && loadingTranscripts.get(key) === loading) invalidateTranscript(key)
      throw error
    }).finally(() => { if (epoch === generation && loadingTranscripts.get(key) === loading) loadingTranscripts.delete(key) })
    subscriptionJobs.set(jobKey, job)
    void job.catch(() => {
      if (subscriptionJobs.get(jobKey) !== job) return
      subscriptionJobs.delete(jobKey)
      // A failed restoration must not leave a permanently silent, wanted subscription.
      setTimeout(() => {
        if (epoch !== generation || !wanted.has(key) || socket?.readyState !== WebSocket.OPEN) return
        void subscribe(method, key).then(value => {
          if (epoch === generation && wanted.has(key)) emit(method === 'transcriptSubscribe' ? 'transcript:update' : 'tasks:changed', [value])
        }).catch(() => undefined)
      }, 1500 + Math.random() * 500)
    })
    return job
  }
  const checkSession = async () => {
    try {
      const res = await fetch(REMOTE_AUTH_ROUTES.session, { credentials: 'same-origin', cache: 'no-store' })
      if (res.status === 401 || (res.ok && !(await res.json()).authenticated)) {
        stopped = true
        location.replace('/login')
      }
    } catch { /* A network outage must not discard the current conversation. */ }
  }
  const restoreState = (epoch: number) => {
    if (epoch !== generation || socket?.readyState !== WebSocket.OPEN) return
    void rpc('init', []).then(payload => {
      if (epoch !== generation) return
      const init = payload as InitPayload
      emit('herdr:connection', [init.connection])
      if (init.snapshot) emit('herdr:snapshot', [init.snapshot])
      if (init.settings) emit('settings:changed', [init.settings])
    }).catch(() => { setTimeout(() => restoreState(epoch), 2000) })
  }
  const connect = () => {
    if (stopped || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return
    clearTimeout(retry)
    setConnection(opened ? 'offline' : 'connecting')
    const epoch = ++generation
    subscriptionJobs.clear()
    deferredTranscripts.clear()
    loadingTranscripts.clear()
    stateEvents.clear()
    const current = socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${REMOTE_WS_PATH}`)
    current.onopen = () => {
      if (epoch !== generation) return
      const restoring = opened
      opened = true
      attempt = 0
      setConnection('connected')
      if (restoring) restoreState(epoch)
      for (const pane of transcripts) void subscribe('transcriptSubscribe', pane).then((u) => { if (epoch === generation && transcripts.has(pane)) emit('transcript:update', [u]) }).catch(() => undefined)
      for (const cwd of boards) void subscribe('watchTasks', cwd).then((b) => { if (b && epoch === generation && boards.has(cwd)) emit('tasks:changed', [b]) }).catch(() => undefined)
      if (restoring) void rpc('setSelectedPane', [selectedPane]).catch(() => undefined)
    }
    current.onmessage = (event) => {
      if (epoch !== generation || current.readyState !== WebSocket.OPEN) return
      try {
        const message = JSON.parse(event.data) as RemoteServerMessage
        if (message.t === 'result') {
          const call = pending.get(message.id)
          if (!call) return
          clearTimeout(call.timer)
          pending.delete(message.id)
          if (message.ok) {
            let value = message.value
            if (call.method === 'init' && message.stateRevision !== undefined) {
              value = { ...(value as InitPayload) }
              for (const [channel, field] of [['herdr:snapshot', 'snapshot'], ['herdr:connection', 'connection'], ['settings:changed', 'settings']] as const) {
                const newer = stateEvents.get(channel)
                if (newer && newer.revision > message.stateRevision) (value as Record<string, unknown>)[field] = newer.value
              }
            }
            call.resolve(value)
          }
          else call.reject(new RemoteCallError(message.error.code, message.error.message))
        } else if (message.t === 'event') {
          if (['herdr:snapshot', 'herdr:connection', 'settings:changed'].includes(message.channel) && message.stateRevision !== undefined) stateEvents.set(message.channel, { revision: message.stateRevision, value: message.args[0] })
          if (message.channel === 'transcript:update') {
            const u = message.args[0] as TranscriptUpdate
            const base = transcriptCache.get(u.paneId)
            if (loadingTranscripts.has(u.paneId) || recoveringTranscripts.has(u.paneId) || (!u.reset && (!base || (u.stream && base.stream && u.stream !== base.stream)))) {
              if (!transcripts.has(u.paneId)) return
              const deltas = deferredTranscripts.get(u.paneId) ?? []
              deltas.push(u)
              deferredTranscripts.set(u.paneId, deltas)
              // Recover a fresh snapshot rather than discard history under overload.
              if (deltas.length > 256) current.close(1013, 'Transcript snapshot required')
              return
            }
            const buffered = deferredTranscripts.has(u.paneId)
            const snapshot = cacheTranscript(u)
            if (buffered) { emit(message.channel, [snapshot]); return }
          }
          if (message.channel === 'term:frames') {
            const [id, frames] = message.args as [string, (Omit<TerminalFrame, 'data'> & { data: number[] })[]]
            emit(message.channel, [id, frames.map((frame) => ({ ...frame, data: new Uint8Array(frame.data) }))])
          } else emit(message.channel, message.args)
        }
      } catch { /* Ignore malformed frames; the next server snapshot can recover. */ }
    }
    current.onclose = () => {
      if (epoch !== generation) return
      // A reconnect cannot reuse a cursor whose in-flight restoration was lost.
      for (const key of loadingTranscripts.keys()) invalidateTranscript(key)
      for (const key of deferredTranscripts.keys()) invalidateTranscript(key)
      subscriptionJobs.clear()
      setConnection('offline')
      for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new RemoteCallError('disconnected', t('Connection lost. Check the result before sending again.'))) }
      pending.clear()
      for (const id of terminals) emit('term:closed', [id, t('No connection')])
      terminals.clear()
      void checkSession()
      if (!stopped) retry = setTimeout(connect, Math.min(15_000, 500 * 2 ** attempt++) + Math.random() * 300)
    }
  }
  window.addEventListener('online', connect)
  window.addEventListener('pageshow', connect)
  connect()

  const on = new Proxy({}, { get: (_, name: string) => (fn: (...args: unknown[]) => void) => {
    const channel = EVENTS[name]
    if (!listeners.has(channel)) listeners.set(channel, new Set())
    listeners.get(channel)!.add(fn)
    return () => { listeners.get(channel)?.delete(fn) }
  } })
  const voidMethods = new Set(['unwatchTasks', 'transcriptUnsubscribe', 'setSelectedPane', 'termInput', 'termInputBytes', 'termResize', 'termScroll', 'termClose'])
  const resultMethods = new Set(['request', 'sendPrompt', 'createAgent', 'setAgentModel', 'termOpen', 'ensureBoard', 'addTask', 'updateTask', 'removeTask'])
  return new Proxy({ on }, { get: (target, name: string) => {
    if (name === 'on') return target.on
    if (name === 'pathForFile') return () => ''
    if (name === 'then') return undefined
    return async (...args: unknown[]) => {
      if (!(name in REMOTE_METHOD_CHANNELS)) throw new RemoteCallError('not_available_remotely', t('This action is available on your Mac.'))
      if (name === 'init' && socket?.readyState !== WebSocket.OPEN) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { off(); reject(new RemoteCallError('disconnected', t('No connection'))) }, 60_000)
          const off = subscribeRemoteConnection(() => { if (connection === 'connected') { clearTimeout(timer); off(); resolve() } })
        })
      }
      if (name === 'transcriptSubscribe') transcripts.add(args[0] as string)
      if (name === 'transcriptUnsubscribe') { transcripts.delete(args[0] as string); deferredTranscripts.delete(args[0] as string); subscriptionJobs.delete(`transcriptSubscribe:${args[0]}`) }
      if (name === 'watchTasks') boards.add(args[0] as string)
      if (name === 'unwatchTasks') { boards.delete(args[0] as string); subscriptionJobs.delete(`watchTasks:${args[0]}`) }
      if (name === 'setSelectedPane') selectedPane = args[0] as string | null
      if (name === 'termOpen') terminals.add(args[0] as string)
      if (name === 'termClose') terminals.delete(args[0] as string)
      if (name === 'setSettings') {
        const patch = args[0] as Partial<AppSettings>
        if (patch.appearance) {
          // The UI sends a complete appearance snapshot. Custom themes are
          // desktop-owned; the Mac merges the editable fields into its copy.
          const appearance: Partial<AppearanceSettings> = { ...patch.appearance }
          delete appearance.customThemes
          args = [{ ...patch, appearance }]
        }
      }
      try {
        if (name === 'transcriptSubscribe' || name === 'watchTasks') return await subscribe(name, args[0] as string)
        // The backend deadline excludes transport time. Leave room for VPN RTT/jitter.
        return await rpc(name, args)
      }
      catch (error) {
        if (voidMethods.has(name)) return
        if (name === 'transcriptSubscribe') return { paneId: args[0] as string, meta: null, items: [], reset: false, error: error instanceof RemoteCallError ? error.code : 'disconnected' } satisfies TranscriptUpdate
        if (resultMethods.has(name)) return { ok: false, code: error instanceof RemoteCallError ? error.code : 'disconnected', error: (error as Error).message }
        throw error
      }
    }
  } }) as unknown as DroverApi & RemoteManagementApi & RemotePushApi
}
