import { isAbsolute, join } from 'node:path'
import { isIP } from 'node:net'
import type { BridgeForward, Machine, MachineDraft, MachinePermissions, MachinesState, ProjectMachinePolicy, SessionCleanupResult } from '@shared/machines'
import { MachinesFailure, privateRead, privateWrite } from './ssh'

export interface StoredMachines {
  version: 1
  machines: Machine[]
  bridgeMachineId: string | null
  agentsKey: MachinesState['agentsKey']
  projectMachinePolicies?: Record<string, ProjectMachinePolicy>
  installed: string[]
  /** An issued installer may have installed a key before host confirmation. */
  issuedInstallers: string[]
  /** Old public keys needing removal from offline machines; never private keys. */
  revocations: Record<string, string[]>
  /** Successful login cleanup survives a later offline login and restart. */
  keyRemovalProgress?: Record<string, { publicKey: string; removeManagement: boolean; completedLogins: string[]; sessions?: SessionCleanupResult }[]>
  /** Full credential removal survives bridge retirement and desktop restart. */
  credentialRemovals: Record<string, { agentsPublicKeys: string[]; managementPublicKey: string; bridgeMachineId?: string; recoveryId?: string }>
  /** Local-only credential references. Never included in MachinesStatus. */
  bridgeConnections?: Record<string, { source: 'existing' | 'scratch'; adminKeyPath?: string; adminManaged?: boolean; jumpKeyPath?: string; jumpUser: string; tunnelUser: string; forwards: BridgeForward[]; publicUrl?: string; macTunnel: 'running' | 'stopped' | 'missing'; managed?: boolean; installerOrigin?: string }>
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
  if ('firstRoute' in draft) {
    if (!['lan', 'internet', 'bridge'].includes(draft.firstRoute) || draft.alsoBridge !== undefined && typeof draft.alsoBridge !== 'boolean') throw new MachinesFailure('invalid_route', 'Choose the first connection route.')
    if (draft.firstRoute === 'bridge') { if (!draft.os || !['linux', 'macos', 'windows'].includes(draft.os)) throw new MachinesFailure('unsupported_os', 'Choose Linux, macOS or Windows.'); return }
    if (draft.firstRoute === 'lan' && !draft.host) { if (!draft.os || !['linux','macos','windows'].includes(draft.os)) throw new MachinesFailure('unsupported_os', 'Choose the home machine OS.'); return }
    return validateDraft({ kind: 'direct', name: draft.name, host: draft.host!, port: draft.port ?? 22, user: draft.user ?? 'drover' })
  }
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
      data.bridgeConnections ??= {}
      data.keyRemovalProgress ??= {}
      if (data.projectMachinePolicies !== undefined) {
        if (!data.projectMachinePolicies || typeof data.projectMachinePolicies !== 'object' || Array.isArray(data.projectMachinePolicies)) throw new Error('Invalid project policies')
        for (const [cwd, policy] of Object.entries(data.projectMachinePolicies)) if (!isAbsolute(cwd) || /[\r\n\0]/.test(cwd) || !Array.isArray(policy?.configureRoles) || policy.configureRoles.length > 30 || policy.configureRoles.some(role => typeof role !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(role))) throw new Error('Invalid project policy')
      }
      if (typeof data.bridgeConnections !== 'object' || Array.isArray(data.bridgeConnections)) throw new Error('Invalid bridge connections')
      if (data.version !== 1 || !Array.isArray(data.machines) || data.machines.length > 1000 || !Array.isArray(data.installed) || !data.revocations || typeof data.revocations !== 'object') throw new Error('Invalid machines store')
      const ids = new Set<string>(), names = new Set<string>()
      for (const machine of data.machines) {
        validateDraft(machine.kind === 'direct' ? { kind: 'direct', name: machine.name, host: machine.host!, port: machine.port!, user: machine.user } : { kind: 'bridged', name: machine.name, os: machine.os! })
        validatePermissions(machine.permissions)
        if (machine.purpose !== undefined && (typeof machine.purpose !== 'string' || machine.purpose.length > 500 || /[\r\n\0]/.test(machine.purpose))) throw new Error('Invalid machine purpose')
        if (machine.routes !== undefined) {
          if (!Array.isArray(machine.routes) || machine.routes.length > 3 || new Set(machine.routes.map(r => r.kind)).size !== machine.routes.length) throw new Error('Invalid routes')
          for (const route of machine.routes) {
            if (!['lan','internet','bridge'].includes(route.kind) || !['ok','down','checking','setup','unknown'].includes(route.state)) throw new Error('Invalid route')
            if (route.kind !== 'bridge' && !(route.kind === 'lan' && !route.host && route.state === 'setup')) { validHost(route.host); validPort(route.port) }
            else if (route.port !== undefined) validPort(route.port)
            if (route.user !== undefined && !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(route.user)) throw new Error('Invalid route login')
            if (route.state === 'checking') route.state = 'unknown'
          }
          if (machine.activeRoute && !machine.routes.some(r => r.kind === machine.activeRoute)) delete machine.activeRoute
        }
        if (typeof machine.id !== 'string' || !/^[a-f0-9-]{36}$/.test(machine.id) || ids.has(machine.id) || names.has(machine.name) || machine.alias !== `drover-${machine.name}` || !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(machine.user) || !machine.status || !['online','offline','checking','waiting','unknown'].includes(machine.status.state)) throw new Error('Invalid machine')
        if (machine.bridgeMachineId !== undefined && !/^[a-f0-9-]{36}$/.test(machine.bridgeMachineId)) throw new Error('Invalid machine bridge')
        machine.publicIp = machine.kind === 'direct' && publicAddress(machine.host!)
        if (machine.kind === 'bridged') validPort(machine.bridgePort)
        if (machine.kind === 'bridged' && machine.host !== undefined) {
          validHost(machine.host); validPort(machine.port)
          if (!machine.routes && !/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(machine.host)) throw new Error('Invalid LAN machine')
        }
        if (machine.installReport && (!Number.isFinite(machine.installReport.reportedAt) || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(machine.installReport.fingerprint))) throw new Error('Invalid installer report')
        ids.add(machine.id); names.add(machine.name)
        if (machine.status.state === 'checking') machine.status.state = 'unknown'
        if (machine.bridgeSetup?.state === 'running') machine.bridgeSetup = { ...machine.bridgeSetup, state: 'failed', error: { code: 'setup_interrupted', detail: 'Bridge setup was interrupted. Run setup again.' } }
      }
      if (data.bridgeMachineId !== null && !data.machines.some(m => m.id === data.bridgeMachineId && m.kind === 'direct' && m.publicIp)) throw new Error('Invalid bridge')
      if (data.machines.some(m => m.bridgeMachineId && !ids.has(m.bridgeMachineId))) throw new Error('Missing machine bridge')
      if (data.installed.some(id => !ids.has(id))) throw new Error('Invalid installation')
      for (const [id, connection] of Object.entries(data.bridgeConnections)) {
        if (!data.machines.some(m => m.id === id && m.kind === 'direct') || !connection || !['existing', 'scratch'].includes(connection.source) || !['running', 'stopped', 'missing'].includes(connection.macTunnel) || !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(connection.jumpUser) || !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(connection.tunnelUser) || [connection.adminKeyPath, connection.jumpKeyPath].some(p => p !== undefined && (!isAbsolute(p) || /[\r\n\0"]/.test(p))) || !Array.isArray(connection.forwards)) throw new Error('Invalid bridge connection')
        for (const forward of connection.forwards) { if (forward.listenHost !== '127.0.0.1' || forward.targetHost !== '127.0.0.1') throw new Error('Invalid bridge forward'); validPort(forward.listenPort); validPort(forward.targetPort) }
        if (connection.publicUrl !== undefined) { const url = new URL(connection.publicUrl); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid bridge URL') }
        if (connection.managed !== undefined && typeof connection.managed !== 'boolean') throw new Error('Invalid bridge management state')
        if (connection.adminManaged !== undefined && typeof connection.adminManaged !== 'boolean') throw new Error('Invalid administrator ownership')
        if (connection.installerOrigin !== undefined) { const url = new URL(connection.installerOrigin); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid installer URL') }
      }
      if (!Array.isArray(data.issuedInstallers) || data.issuedInstallers.some(id => !ids.has(id))) throw new Error('Invalid installer')
      for (const [id, keys] of Object.entries(data.revocations)) if (!ids.has(id) || !Array.isArray(keys) || keys.some(key => typeof key !== 'string' || !/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}/.test(key))) throw new Error('Invalid revocation')
      if (typeof data.keyRemovalProgress !== 'object' || Array.isArray(data.keyRemovalProgress)) throw new Error('Invalid login cleanup')
      for (const [id, entries] of Object.entries(data.keyRemovalProgress)) if (!ids.has(id) || !Array.isArray(entries) || entries.some(entry => !entry || !/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [^\r\n]*)?$/.test(entry.publicKey) || typeof entry.removeManagement !== 'boolean' || !Array.isArray(entry.completedLogins) || entry.completedLogins.some(user => typeof user !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(user)) || entry.sessions !== undefined && (!Number.isSafeInteger(entry.sessions.terminated) || entry.sessions.terminated < 0 || typeof entry.sessions.incomplete !== 'boolean'))) throw new Error('Invalid login cleanup')
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
