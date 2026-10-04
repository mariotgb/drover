/** Independent reads must not wait for slow RPCs. Stateful operations retain
 * their order within the resource (and commands/terminal writes stay ordered).
 */
export class RemoteRpcQueue {
  private lanes = new Map<string, Promise<unknown>>()
  run<T>(message: unknown, execute: () => Promise<T>): Promise<T> {
    const call = message as { method?: unknown; args?: unknown[] } | null
    const method = typeof call?.method === 'string' ? call.method : ''
    const key = Array.isArray(call?.args) && typeof call.args[0] === 'string' ? call.args[0] : ''
    const reads = ['init', 'sessions', 'herdrVersion', 'agentKinds', 'limits', 'refreshLimits', 'previewServers', 'discoverRoles', 'modelCatalog', 'remoteStatus', 'pushPublicKey', 'pushStatus']
    if (reads.includes(method)) return execute()
    const lane = method.startsWith('transcript') ? `transcript:${key}`
      : ['watchTasks', 'unwatchTasks', 'ensureBoard', 'addTask', 'updateTask', 'removeTask'].includes(method) ? `tasks:${key}`
      : method === 'setSelectedPane' ? 'selection' : 'commands'
    const result = (this.lanes.get(lane) ?? Promise.resolve()).catch(() => undefined).then(execute)
    this.lanes.set(lane, result)
    void result.finally(() => { if (this.lanes.get(lane) === result) this.lanes.delete(lane) }).catch(() => undefined)
    return result
  }
}
