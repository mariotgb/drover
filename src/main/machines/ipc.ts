import type { IpcMain, IpcMainInvokeEvent, OpenDialogOptions, OpenDialogReturnValue } from 'electron'
import { join } from 'node:path'
import type { MachinesService } from './service'
import { MachinesFailure } from './ssh'

/** Never register management in the phone's RPC table. Check the main desktop
 * frame as well, so a preview/webview cannot invoke its preload methods.
 */
export function registerMachinesIpc(ipc: Pick<IpcMain, 'handle'>, service: MachinesService, allowed: (event: IpcMainInvokeEvent) => boolean, keyPicker?: { home: string; open: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue> }): void {
  const handlers: Record<string, (...args: any[]) => unknown> = { // eslint-disable-line @typescript-eslint/no-explicit-any
    'machines:state': () => service.state(),
    'machines:herdr-machines': () => service.herdrMachines(),
    'machines:start-herdr-agent': options => service.startHerdrAgent(options),
    'machines:open-herdr-agent': (machineId, paneId) => service.openHerdrAgent(machineId, paneId),
    'machines:rename': (id, name, options) => service.rename(id, name, options),
    'machines:set-purpose': (id, purpose) => service.setPurpose(id, purpose),
    'machines:add-route': (id, route, options) => service.addRoute(id, route, options),
    'machines:remove-route': (id, kind, options) => service.removeRoute(id, kind, options),
    'machines:sync-herdr': options => service.syncHerdr(options),
    'machines:login-key-candidates': host => service.loginKeyCandidates(host),
    'machines:phones': () => service.phones(),
    'machines:move-phone': (id, options) => service.movePhoneToBridge(id, options),
    'machines:set-enabled': (id, enabled, options) => service.setEnabled(id, enabled, options),
    'machines:enable-bridge-route': (id, os, options) => service.enableBridgeRoute(id, os, options),
    'machines:recommend-method': answer => service.recommendMethod(answer),
    'machines:project-policy': cwd => service.projectMachinePolicy(cwd),
    'machines:set-project-policy': (cwd, policy) => service.setProjectMachinePolicy(cwd, policy),
    'machines:probe-host-key': (host, port, user) => service.probeHostKey(host, port, user),
    'machines:add': draft => service.add(draft),
    'machines:install-key': (id, options) => service.installKey(id, options),
    'machines:check': id => service.check(id),
    'machines:remove': (id, options) => service.remove(id, options),
    'machines:permissions': (id, permissions) => service.setPermissions(id, permissions),
    'machines:set-bridge': (id, options) => service.setBridge(id, options),
    'machines:setup-bridge': (id, options) => service.setupBridge(id, options),
    'machines:detect-existing-bridge': () => service.detectExistingBridge(),
    'machines:choose-bridge-key-file': async () => {
      if (!keyPicker) throw new MachinesFailure('key_picker_unavailable', 'The administrator key picker is unavailable in this desktop session.')
      const result = await keyPicker.open({ title: 'Choose administrator SSH key', defaultPath: join(keyPicker.home, '.ssh'), properties: ['openFile', 'showHiddenFiles'] })
      return result.canceled ? null : result.filePaths[0] ?? null
    },
    'machines:adopt-existing-bridge': options => service.adoptExistingBridge(options),
    'machines:setup-bridge-from-scratch': options => service.setupBridgeFromScratch(options),
    'machines:repair-existing-bridge': options => service.repairExistingBridge(options),
    'machines:install-command': (id, os) => service.installCommand(id, os),
    'machines:revoke-key': options => service.revokeAgentsKey(options),
    'machines:add-ssh-include': () => service.addSshInclude()
  }
  for (const [channel, handler] of Object.entries(handlers)) ipc.handle(channel, async (event, ...args) => {
    if (!allowed(event)) throw new MachinesFailure('desktop_only', 'Machine management is available only in the local desktop app.')
    try { return await handler(...args) }
    catch (error) {
      const safe = error instanceof MachinesFailure ? `[${error.code}] ${error.message}` : 'The machine operation could not be completed.'
      throw new Error(safe)
    }
  })
}
