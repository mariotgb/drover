import { useSyncExternalStore } from 'react'
import type { DroverApi, InitPayload } from '../../preload/api'
import type { TerminalFrame, TranscriptUpdate } from '@shared/types'
import { REMOTE_AUTH_ROUTES, REMOTE_METHOD_CHANNELS, REMOTE_WS_PATH, type RemoteCall, type RemoteEventChannel, type RemoteManagementApi, type RemotePushApi, type RemoteServerMessage } from '@shared/remote'
import { t } from './i18n'

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
  limits: 'limits:update', remoteStatus: 'remote:status'
}

/** Cookie-authenticated, same-origin RPC. Commands are never queued or replayed. */
export function createRemoteApi(): DroverApi & RemoteManagementApi & RemotePushApi {
  let socket: WebSocket | null = null
  let retry: ReturnType<typeof setTimeout> | undefined
  let attempt = 0
  let sequence = 0
  let opened = false
  let stopped = false
  let selectedPane: string | null = null
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const transcripts = new Set<string>()
  const boards = new Set<string>()
  const terminals = new Set<string>()
  const emit = (channel: string, args: unknown[]) => { for (const fn of listeners.get(channel) ?? []) fn(...args) }

  const rpc = (method: string, args: unknown[], timeout = 30_000): Promise<unknown> => {
    if (socket?.readyState !== WebSocket.OPEN) return Promise.reject(new RemoteCallError('disconnected', t('No connection')))
    return new Promise((resolve, reject) => {
      const id = `web-${++sequence}`
      const timer = setTimeout(() => { pending.delete(id); reject(new RemoteCallError('timeout', t('The server did not respond. Try again.'))) }, timeout)
      pending.set(id, { resolve, reject, timer })
      const message: RemoteCall = { t: 'call', id, method, args }
      try { socket!.send(JSON.stringify(message)) } catch (error) { clearTimeout(timer); pending.delete(id); reject(error) }
    })
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
  const connect = () => {
    if (stopped || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return
    clearTimeout(retry)
    setConnection(opened ? 'offline' : 'connecting')
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${REMOTE_WS_PATH}`)
    socket.onopen = () => {
      const restoring = opened
      opened = true
      attempt = 0
      setConnection('connected')
      if (restoring) {
        void rpc('init', []).then((payload) => {
          const init = payload as InitPayload
          emit('herdr:connection', [init.connection])
          if (init.snapshot) emit('herdr:snapshot', [init.snapshot])
        }).catch(() => undefined)
        for (const pane of transcripts) void rpc('transcriptSubscribe', [pane]).then((u) => emit('transcript:update', [u])).catch(() => undefined)
        for (const cwd of boards) void rpc('watchTasks', [cwd]).then((b) => { if (b) emit('tasks:changed', [b]) }).catch(() => undefined)
        void rpc('setSelectedPane', [selectedPane]).catch(() => undefined)
      }
    }
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as RemoteServerMessage
        if (message.t === 'result') {
          const call = pending.get(message.id)
          if (!call) return
          clearTimeout(call.timer)
          pending.delete(message.id)
          if (message.ok) call.resolve(message.value)
          else call.reject(new RemoteCallError(message.error.code, message.error.message))
        } else if (message.t === 'event') {
          if (message.channel === 'term:frames') {
            const [id, frames] = message.args as [string, (Omit<TerminalFrame, 'data'> & { data: number[] })[]]
            emit(message.channel, [id, frames.map((frame) => ({ ...frame, data: new Uint8Array(frame.data) }))])
          } else emit(message.channel, message.args)
        }
      } catch { /* Ignore malformed frames; the next server snapshot can recover. */ }
    }
    socket.onclose = () => {
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
          const timer = setTimeout(() => { off(); reject(new RemoteCallError('disconnected', t('No connection'))) }, 15_000)
          const off = subscribeRemoteConnection(() => { if (connection === 'connected') { clearTimeout(timer); off(); resolve() } })
        })
      }
      if (name === 'transcriptSubscribe') transcripts.add(args[0] as string)
      if (name === 'transcriptUnsubscribe') transcripts.delete(args[0] as string)
      if (name === 'watchTasks') boards.add(args[0] as string)
      if (name === 'unwatchTasks') boards.delete(args[0] as string)
      if (name === 'setSelectedPane') selectedPane = args[0] as string | null
      if (name === 'termOpen') terminals.add(args[0] as string)
      if (name === 'termClose') terminals.delete(args[0] as string)
      try { return await rpc(name, args, name === 'request' && typeof args[2] === 'number' ? args[2] : undefined) }
      catch (error) {
        if (voidMethods.has(name)) return
        if (name === 'transcriptSubscribe') return { paneId: args[0] as string, meta: null, items: [], reset: true, error: 'disconnected' } satisfies TranscriptUpdate
        if (resultMethods.has(name)) return { ok: false, code: error instanceof RemoteCallError ? error.code : 'disconnected', error: (error as Error).message }
        throw error
      }
    }
  } }) as unknown as DroverApi & RemoteManagementApi & RemotePushApi
}
