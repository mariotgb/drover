import { isAbsolute, join } from 'node:path'
import { isIP } from 'node:net'
import type { Machine, MachineDraft, MachinePermissions, MachinesState } from '@shared/machines'
import { MachinesFailure, privateRead, privateWrite } from './ssh'

export interface StoredMachines {
  version: 1
  machines: Machine[]
  bridgeMachineId: string | null
  agentsKey: MachinesState['agentsKey']
  installed: string[]
  /** An issued installer may have installed a key before host confirmation. */
  issuedInstallers: string[]
  /** Old public keys needing removal from offline machines; never private keys. */
  revocations: Record<string, string[]>
  /** Full credential removal survives bridge retirement and desktop restart. */
  credentialRemovals: Record<string, { agentsPublicKeys: string[]; managementPublicKey: string; bridgeMachineId?: string; recoveryId?: string }>
}
export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/
export function validHost(host: unknown): asserts host is string {
  if (typeof host !== 'string' || host.length > 253 || (!isIP(host) && !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host))) throw new MachinesFailure('invalid_host', 'Enter an IP address or hostname without spaces or SSH options.')
}
export function validPort(port: unknown): asserts port is number {
  if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) throw new MachinesFailure('invalid_port', 'SSH port must be between 1 and 65535.')
}
export function validatePermissions(value: MachinePermissions): void {
  if (!value || !['full', 'read-only', 'projects'].includes(value.mode) || !Array.isArray(value.projects) || value.projects.length > 1000 || value.projects.some(p => typeof p !== 'string' || !isAbsolute(p) || /[\r\n\0]/.test(p) || p.length > 8192) || (value.mode === 'projects' && !value.projects.length)) throw new MachinesFailure('invalid_permissions', 'Choose full, read-only, or at least one absolute project folder.')
}
export function validateDraft(draft: MachineDraft): void {
  if (!draft || typeof draft !== 'object' || typeof draft.name !== 'string' || !NAME_PATTERN.test(draft.name)) throw new MachinesFailure('invalid_name', 'Use lowercase letters, digits and dashes for the machine name.')
  if (draft.kind === 'direct') {
    validHost(draft.host); validPort(draft.port)
    if (!/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(draft.user)) throw new MachinesFailure('invalid_user', 'Enter a valid SSH login name.')
  } else if (draft.kind !== 'bridged' || !['linux', 'macos', 'windows'].includes(draft.os)) throw new MachinesFailure('unsupported_os', 'Choose Linux, macOS or Windows.')
}
export function publicAddress(host: string): boolean {
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19))
  }
  if (isIP(host) === 6) return !/^(?:::|::1|f[cd]|fe[89ab]|::ffff:)/i.test(host)
  // DNS may resolve to a private host. Require a literal public IP for bridges.
  return false
}

export class MachinesStore {
  readonly file: string
  constructor(userData: string) { this.file = join(userData, 'machines.json') }
  async load(): Promise<StoredMachines> {
    const raw = await privateRead(this.file)
    if (raw === null) return { version: 1, machines: [], bridgeMachineId: null, agentsKey: null, installed: [], issuedInstallers: [], revocations: {}, credentialRemovals: {} }
    try {
      const data: StoredMachines = JSON.parse(raw)
      data.issuedInstallers ??= []
      data.credentialRemovals ??= {}
      if (data.version !== 1 || !Array.isArray(data.machines) || data.machines.length > 1000 || !Array.isArray(data.installed) || !data.revocations || typeof data.revocations !== 'object') throw new Error('Invalid machines store')
      const ids = new Set<string>(), names = new Set<string>()
      for (const machine of data.machines) {
        validateDraft(machine.kind === 'direct' ? { kind: 'direct', name: machine.name, host: machine.host!, port: machine.port!, user: machine.user } : { kind: 'bridged', name: machine.name, os: machine.os! })
        validatePermissions(machine.permissions)
        if (typeof machine.id !== 'string' || !/^[a-f0-9-]{36}$/.test(machine.id) || ids.has(machine.id) || names.has(machine.name) || machine.alias !== `drover-${machine.name}` || !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(machine.user) || !machine.status || !['online','offline','checking','waiting','unknown'].includes(machine.status.state)) throw new Error('Invalid machine')
        if (machine.bridgeMachineId !== undefined && !/^[a-f0-9-]{36}$/.test(machine.bridgeMachineId)) throw new Error('Invalid machine bridge')
        machine.publicIp = machine.kind === 'direct' && publicAddress(machine.host!)
        if (machine.kind === 'bridged') validPort(machine.bridgePort)
        if (machine.kind === 'bridged' && machine.host !== undefined) {
          validHost(machine.host); validPort(machine.port)
          if (!/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(machine.host)) throw new Error('Invalid LAN machine')
        }
        if (machine.installReport && (!Number.isFinite(machine.installReport.reportedAt) || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(machine.installReport.fingerprint))) throw new Error('Invalid installer report')
        ids.add(machine.id); names.add(machine.name)
        if (machine.status.state === 'checking') machine.status.state = 'unknown'
        if (machine.bridgeSetup?.state === 'running') machine.bridgeSetup = { ...machine.bridgeSetup, state: 'failed', error: { code: 'setup_interrupted', detail: 'Bridge setup was interrupted. Run setup again.' } }
      }
      if (data.bridgeMachineId !== null && !data.machines.some(m => m.id === data.bridgeMachineId && m.kind === 'direct' && m.publicIp)) throw new Error('Invalid bridge')
      if (data.machines.some(m => m.bridgeMachineId && !ids.has(m.bridgeMachineId))) throw new Error('Missing machine bridge')
      if (data.installed.some(id => !ids.has(id))) throw new Error('Invalid installation')
      if (!Array.isArray(data.issuedInstallers) || data.issuedInstallers.some(id => !ids.has(id))) throw new Error('Invalid installer')
      for (const [id, keys] of Object.entries(data.revocations)) if (!ids.has(id) || !Array.isArray(keys) || keys.some(key => typeof key !== 'string' || !/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}/.test(key))) throw new Error('Invalid revocation')
      if (typeof data.credentialRemovals !== 'object' || Array.isArray(data.credentialRemovals)) throw new Error('Invalid credential removal')
      for (const [id, removal] of Object.entries(data.credentialRemovals)) {
        if (!ids.has(id) || !removal || !Array.isArray(removal.agentsPublicKeys) || !removal.agentsPublicKeys.length || [...removal.agentsPublicKeys, removal.managementPublicKey].some(key => typeof key !== 'string' || !/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [^\r\n]*)?$/.test(key)) || removal.bridgeMachineId !== undefined && !/^[a-f0-9-]{36}$/.test(removal.bridgeMachineId)) throw new Error('Invalid credential removal')
        if (removal.recoveryId !== undefined && !/^[a-f0-9-]{36}$/.test(removal.recoveryId)) throw new Error('Invalid recovery cleanup')
      }
      return data
    } catch (error) { if (error instanceof MachinesFailure) throw error; throw new MachinesFailure('store_invalid', 'The machines store is damaged. Restore its backup before changing machine access.') }
  }
  async save(data: StoredMachines): Promise<void> { await privateWrite(this.file, JSON.stringify(data, null, 2) + '\n') }
}
