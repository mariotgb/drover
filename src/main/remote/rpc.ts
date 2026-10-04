import { REMOTE_METHOD_CHANNELS, type RemoteCall, type RemoteResult } from '@shared/remote'
import { RemoteFailure } from './security'
import { validateRpcArgs } from './validation'

export interface RpcContext { remote?: RemoteRpcConnection; existingSubscription?: boolean }
// Existing IPC handlers use typed arguments; the boundary validates envelopes.
export type RpcHandler = (context: RpcContext, ...args: any[]) => unknown // eslint-disable-line @typescript-eslint/no-explicit-any
export class RpcHandlers {
  private table = new Map<string, RpcHandler>()
  register(channel: string, handler: RpcHandler): void {
    if (this.table.has(channel)) throw new Error(`Duplicate handler: ${channel}`)
    this.table.set(channel, handler)
  }
  invoke(channel: string, context: RpcContext, args: unknown[]): unknown {
    const handler = this.table.get(channel)
    if (!handler) throw new RemoteFailure('not_available_remotely', 'Method not available remotely')
    return handler(context, ...args)
  }
}
export class RemoteRpcConnection {
  terminals = new Map<string, string>()
  terminalTargets = new Map<string, string>()
  transcripts = new Set<string>()
  tasks = new Set<string>()
  closed = false
  constructor(public id: string, public readonly deviceId?: string) {}
}

function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 200) throw new RemoteFailure('invalid_args', 'Invalid identifier')
}
const optionalArgs: Partial<Record<string, number>> = { request: 2, termScroll: 3, addTask: 2, deletePushSubscription: 0, transcriptSubscribe: 1 }
export async function dispatchRemoteRpc(handlers: RpcHandlers, connection: RemoteRpcConnection, message: unknown): Promise<RemoteResult> {
  const call = message as Partial<RemoteCall> | null
  const id = typeof call?.id === 'string' ? call.id.slice(0, 128) : ''
  let rollback: (() => void) | undefined
  try {
    if (!call || typeof call !== 'object' || Array.isArray(call) || Object.keys(call).some(k => !['t', 'id', 'method', 'args'].includes(k)) || call.t !== 'call' || !id || call.id !== id || typeof call.method !== 'string' ||
        !Array.isArray(call.args) || call.args.length > 16) throw new RemoteFailure('invalid_call', 'Invalid RPC call')
    if (!Object.hasOwn(REMOTE_METHOD_CHANNELS, call.method)) throw new RemoteFailure('not_available_remotely', 'Method not available remotely')
    if (connection.closed) throw new RemoteFailure('unauthorized', 'Connection closed', 401)
    const method = call.method as keyof typeof REMOTE_METHOD_CHANNELS
    const args = [...call.args]
    validateRpcArgs(method, args)
    // JSON arrays encode omitted optional arguments as null. Restore the native
    // API's undefined/default semantics only after validating the wire value.
    const optionalIndex = optionalArgs[method]
    if (optionalIndex !== undefined && args[optionalIndex] === null) args[optionalIndex] = undefined
    if (method === 'request' && args[0] === 'pane.send_keys' && ![...connection.terminalTargets.values()].includes((args[1] as { pane_id: string }).pane_id)) throw new RemoteFailure('not_subscribed', 'Terminal not subscribed by this connection')
    if (method.startsWith('term')) {
      identifier(args[0])
      const clientId = args[0]
      if (method === 'termOpen') {
        if (connection.terminals.has(clientId)) throw new RemoteFailure('already_subscribed', 'Already subscribed')
        identifier(args[1])
        if (!args.slice(2, 4).every((n) => typeof n === 'number' && Number.isFinite(n)) || args.length !== 4) {
          throw new RemoteFailure('invalid_args', 'Expected terminal size')
        }
        if (!connection.terminals.has(clientId) && connection.terminals.size >= 32) throw new RemoteFailure('too_many_terminals', 'Too many terminal subscriptions')
        connection.terminals.set(clientId, `remote:${connection.id}:${clientId}`)
        rollback = () => {
          const internal = connection.terminals.get(clientId)
          if (internal) { handlers.invoke('term:close', {}, [internal]); connection.terminals.delete(clientId) }
        }
      }
      const internalId = connection.terminals.get(clientId)
      if (!internalId) throw new RemoteFailure('not_subscribed', 'Terminal not subscribed by this connection')
      args[0] = internalId
    }
    const subscription = method.startsWith('transcript') ? connection.transcripts : method === 'watchTasks' || method === 'unwatchTasks' ? connection.tasks : null
    let existingSubscription = false
    if (subscription) {
      identifier(args[0])
      const subscribing = method === 'transcriptSubscribe' || method === 'watchTasks'
      existingSubscription = subscribing && subscription.has(args[0])
      if (!subscribing && !subscription.has(args[0])) return { t: 'result', id, ok: true, value: null }
      if (subscribing && !existingSubscription) {
        const key = args[0]
        subscription.add(key)
        rollback = () => {
          if (subscription.delete(key)) handlers.invoke(method === 'watchTasks' ? 'tasks:unwatch' : 'transcript:unsubscribe', {}, [key])
        }
      }
      else if (!subscribing) subscription.delete(args[0])
    }
    const value = await handlers.invoke(REMOTE_METHOD_CHANNELS[method], { remote: connection, existingSubscription }, args)
    if (method === 'termClose') { connection.terminals.delete(call.args[0] as string); connection.terminalTargets.delete(call.args[0] as string) }
    if (method === 'termOpen') {
      if (connection.closed) { handlers.invoke('term:close', {}, [args[0]]); throw new RemoteFailure('unauthorized', 'Connection closed', 401) }
      if (!(value && typeof value === 'object' && 'ok' in value && !value.ok)) connection.terminalTargets.set(call.args[0] as string, call.args[1] as string)
    }
    if (method === 'termOpen' && value && typeof value === 'object' && 'ok' in value && !value.ok) {
      connection.terminals.delete(call.args[0] as string)
    }
    return { t: 'result', id, ok: true, value: value ?? null }
  } catch (error) {
    try { rollback?.() } catch { /* retain the original RPC failure */ }
    return { t: 'result', id, ok: false, error: {
      code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'error',
      message: error instanceof Error ? error.message : 'RPC failed'
    } }
  }
}

export function releaseRemoteRpc(handlers: RpcHandlers, connection: RemoteRpcConnection): void {
  connection.closed = true
  for (const [channel, ids] of [
    ['term:close', connection.terminals.values()], ['transcript:unsubscribe', connection.transcripts.values()], ['tasks:unwatch', connection.tasks.values()]
  ] as const) {
    for (const id of ids) { try { handlers.invoke(channel, {}, [id]) } catch { /* application is shutting down */ } }
  }
  connection.terminals.clear()
  connection.terminalTargets.clear()
  connection.transcripts.clear()
  connection.tasks.clear()
}
