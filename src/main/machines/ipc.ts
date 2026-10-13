import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { MachinesService } from './service'
import { MachinesFailure } from './ssh'

/** Never register management in the phone's RPC table. Check the main desktop
 * frame as well, so a preview/webview cannot invoke its preload methods.
 */
export function registerMachinesIpc(ipc: Pick<IpcMain, 'handle'>, service: MachinesService, allowed: (event: IpcMainInvokeEvent) => boolean): void {
  const handlers: Record<string, (...args: any[]) => unknown> = { // eslint-disable-line @typescript-eslint/no-explicit-any
    'machines:state': () => service.state(),
    'machines:probe-host-key': (host, port) => service.probeHostKey(host, port),
    'machines:add': draft => service.add(draft),
    'machines:install-key': (id, options) => service.installKey(id, options),
    'machines:check': id => service.check(id),
    'machines:remove': id => service.remove(id),
    'machines:permissions': (id, permissions) => service.setPermissions(id, permissions),
    'machines:set-bridge': id => service.setBridge(id),
    'machines:setup-bridge': (id, options) => service.setupBridge(id, options),
    'machines:install-command': (id, os) => service.installCommand(id, os),
    'machines:revoke-key': () => service.revokeAgentsKey(),
    'machines:add-ssh-include': () => service.addSshInclude()
  }
  for (const [channel, handler] of Object.entries(handlers)) ipc.handle(channel, async (event, ...args) => {
    if (!allowed(event)) throw new MachinesFailure('desktop_only', 'Machine management is available only in the local desktop app.')
    try { return await handler(...args) }
    catch (error) {
      const safe = error instanceof MachinesFailure ? error.message : 'The machine operation could not be completed.'
      throw new Error(safe)
    }
  })
}
