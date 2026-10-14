import { randomUUID } from 'node:crypto'
import { access, lstat, mkdtemp, readFile, rm, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { BridgeAdoptOptions, BridgeProgress, BridgeRepairOptions, BridgeScratchOptions, BridgeSetupReport, BridgeStepId, ExistingBridge, HostKey, InstallCommand, Machine, MachineConfirmationOptions, MachineDraft, MachineOs, MachinePermissions, MachinesState, MachinesStatus, SessionCleanupReason, SessionCleanupReport, SessionCleanupResult, HerdrMachine, HerdrSavedMachine, StartHerdrAgentRequest, MachineMethodAnswer, MachineMethodRecommendation, ProjectMachinePolicy } from '@shared/machines'
import { MachinesStore, publicAddress, validHost, validPort, validateDraft, validatePermissions, type StoredMachines } from './store'
import { fingerprint, MachinesFailure, privateDirectory, privateRead, privateWrite, quote, runCommand, sshError, tcpProbe, withAskpass, type CommandResult, type CommandRunner } from './ssh'
import { adminKeyInstallScript, keyInstallScript, removeKeyScript, windowsKeyScript } from './permissions'
import { projectMachineInstructions, writeAwareness } from './awareness'
import { bridgeTunnelUser, createMachineProvisioner, macTunnelAsset, type BridgeOptions, type BridgeTarget, type ExistingBridgeReport, type InstallContext, type InstallerReport, type LegacyBridge } from './provision'
import { BridgeCleanupQueue } from './cleanup'
import { sessionCleanupScript } from './sessions'
import { bridgeKeyPath, detectLocalBridge, keyExists, publicExistingBridge, type BridgeAdmin, type LocalBridge } from './existing-bridge'
import type { HerdrMachineRegistry } from './herdr'
import { recommendMachineMethod, machineNextActions } from './recommend'
import { orderedRoutes, validateRoute } from './routes'
import type { AddMachineRoute, BridgeKeyCandidate, DirectDraft, BridgedDraft, MachineKeyInstallOptions, MachinePhone, MachineRoute, MachineRouteKind } from '@shared/machines'
import { adminKeyCandidates } from './existing-bridge'
import { linuxTunnelAsset, phoneKeyGrantScript } from './provision'

export interface MachineProvisioner {
  setupBridge(machine: Machine, targets: Machine[], agentsPublicKey: string, options: { caddy: boolean }, onStep: (step: string) => Promise<void>): Promise<void>
  installCommand(context: InstallContext, os: MachineOs): Promise<string>
  switchBridge?(previous: Machine | null, next: Machine, targets: Machine[], agentsPublicKey: string): Promise<{ updated: string[]; needsReinstall: string[]; pendingOldCleanup?: string[] }>
  revokeBridgeKey?(bridge: Machine, publicKey: string): Promise<void>
  removeTargets?(bridge: Machine, targets: Machine[], agentsPublicKey: string): Promise<void>
  retireBridge?(bridge: Machine): Promise<void>
  revokeInstallers?(bridge: Machine | null): Promise<void>
  dispose?(): Promise<void>
  verifyExistingBridge?(machine: Machine, legacy: LegacyBridge): Promise<ExistingBridgeReport>
  setupScratchBridge?(machine: Machine, keys: { tunnel: string; agents: string; management: string }, options: BridgeOptions, onStep: (step: BridgeStepId, state: 'running' | 'done' | 'skipped') => Promise<void>): Promise<void>
  repairBridge?(machine: Machine, targets: Machine[], agentsPublicKey: string, options: BridgeOptions, onStep: (step: string) => Promise<void>): Promise<void>
}
export interface MachinesOptions {
  userData: string
  home: string
  env?: () => NodeJS.ProcessEnv
  run?: CommandRunner
  tcp?: typeof tcpProbe
  runtime?: string
  changed?: (state: MachinesState) => void
  provisioner?: MachineProvisioner
  confirmInclude?: () => Promise<boolean>
  periodMs?: number
  assetsDir?: string
  /** Optional advertised LAN address for isolated tests or explicit routing. */
  lanHost?: string
  remoteSettings?: () => { remotePublicUrl?: string; remotePort?: number }
  bridgeAdmin?: () => BridgeAdmin | undefined
  bridgeProgress?: (progress: BridgeProgress) => void
  configurePhone?: (publicUrl: string) => void | Promise<void>
  phoneOriginTransition?: (publicUrl: string) => Promise<(committed: boolean) => Promise<void>>
  herdr?: HerdrMachineRegistry
  herdrChanged?: (machines: HerdrMachine[]) => void
  openHerdr?: (profile: HerdrSavedMachine, paneId: string) => Promise<void>
  phones?: () => MachinePhone[]
  movePhone?: (machine: Machine) => Promise<void>
  platform?: NodeJS.Platform
}
const METRICS = `set -eu
printf 'os=%s\\n' "$(uname -s)"
if [ -r /etc/os-release ]; then . /etc/os-release; printf 'label=%s\\n' "$PRETTY_NAME"; fi
df -Pk / | awk 'NR==2 {printf "disk=%s\\n", $4 * 1024}'
if [ -r /proc/meminfo ]; then awk '/^MemTotal:/ {printf "memoryTotal=%s\\n",$2*1024} /^MemAvailable:/ {printf "memoryAvailable=%s\\n",$2*1024}' /proc/meminfo; fi
if [ "$(uname -s)" = Darwin ]; then printf 'memoryTotal=%s\\n' "$(sysctl -n hw.memsize)"; vm_stat | awk '/page size/ {page=$8} /Pages free:/ {gsub(/\\./,"",$3); printf "memoryAvailable=%s\\n",$3*page}'; fi
if command -v docker >/dev/null; then echo docker=1; else echo docker=0; fi
if command -v herdr >/dev/null; then echo herdr=1; else echo herdr=0; fi
if command -v hostname >/dev/null && hostname -I >/dev/null 2>&1; then printf 'lan=%s\\n' "$(hostname -I)"; elif [ "$(uname -s)" = Darwin ]; then printf 'lan=%s\\n' "$(ipconfig getifaddr en0 || true)"; fi
`
const WINDOWS_METRICS = "$ErrorActionPreference='Stop';'os=Windows';'label='+[Environment]::OSVersion.VersionString;$d=Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='C:'\";'disk='+$d.FreeSpace;$m=Get-CimInstance Win32_OperatingSystem;'memoryTotal='+($m.TotalVisibleMemorySize*1024);'memoryAvailable='+($m.FreePhysicalMemory*1024);'docker='+[int][bool](Get-Command docker -ErrorAction SilentlyContinue);'herdr='+[int][bool](Get-Command herdr -ErrorAction SilentlyContinue)"

export class MachinesService {
  readonly root: string
  readonly configPath: string
  readonly knownHosts: string
  private readonly controlConfig: string
  private store: MachinesStore
  private data: StoredMachines | null = null
  private loaded: Promise<void> | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private timer: NodeJS.Timeout | null = null
  private disposed = false
  private readonly run: CommandRunner
  private readonly tcp: typeof tcpProbe
  private readonly provisioner: MachineProvisioner
  private readonly bridgeCleanup: BridgeCleanupQueue
  private polling = false
  private projects = new Set<string>()
  private installerAttempts = new Map<string, symbol>()
  private herdrRows: HerdrMachine[] = []
  private herdrProfiles: HerdrSavedMachine[] = []
  private herdrPoll: NodeJS.Timeout | null = null
  constructor(private options: MachinesOptions) {
    this.root = join(options.home, '.drover', 'machines')
    this.configPath = join(this.root, 'ssh_config')
    this.controlConfig = join(this.root, 'ssh_control_config')
    this.knownHosts = join(this.root, 'known_hosts')
    this.store = new MachinesStore(options.userData)
    this.run = options.run ?? runCommand
    this.tcp = options.tcp ?? tcpProbe
    const provision = createMachineProvisioner({ run: (m, cmd, input) => this.execute(m, cmd, input), assetsDir: options.assetsDir })
    const targets = async (machines: Machine[]): Promise<BridgeTarget[]> => {
      const result: BridgeTarget[] = []
      for (const machine of machines) result.push({ machine, tunnelPublicKey: await this.generateKey('tunnel-' + machine.id) })
      return result
    }
    const bridgeKey = async (b: Machine): Promise<string> => {
      const line = (await privateRead(this.knownHosts) ?? '').split('\n').find(line => line.split(/\s+/)[0] === this.pinName(b))
      if (!line) throw new MachinesFailure('host_key_unconfirmed', 'Confirm the bridge SSH host key first.')
      return line.split(/\s+/).slice(1, 3).join(' ')
    }
    this.provisioner = options.provisioner ?? {
      setupBridge: async (m, machines, key, settings, onStep) => provision.setupBridge(m, await targets(machines), key, settings, onStep),
      installCommand: async (context, os) => {
        if (context.bridge) {
          const connection = this.d.bridgeConnections?.[context.bridge.id], assigned = await targets(this.d.machines.filter(m => m.kind === 'bridged' && m.bridgeMachineId === context.bridge!.id))
          if (connection && !connection.managed) throw new MachinesFailure('bridge_repair_required', 'Confirm bridge repair to add the installer route and dedicated target grants.')
          if (connection) await provision.repairBridge(context.bridge, assigned, context.agentsPublicKey, this.bridgeOptions(context.bridge))
          else await provision.setupBridge(context.bridge, assigned, context.agentsPublicKey, { caddy: context.bridge.bridgeSetup?.caddy ?? false })
        }
        return provision.installCommand({ ...context, ...(context.machine.permissions.mode === 'read-only' ? { permissionSetupScript: keyInstallScript(context.agentsPublicKey, context.managementPublicKey, context.machine.permissions) } : {}) }, os)
      },
      switchBridge: async (previous, next, machines, key) => provision.switchBridge(previous, next, await targets(machines), key, { ...this.bridgeOptions(next), bridgeHostKey: await bridgeKey(next), additive: !!this.d.bridgeConnections?.[next.id] }),
      revokeBridgeKey: async (b, old) => {
        await provision.revokeJumpKey(b, old); await provision.revokeInstallers(b)
        const assigned = await targets(this.d.machines.filter(m => m.kind === 'bridged' && m.bridgeMachineId === b.id))
        if (this.d.bridgeConnections?.[b.id]) await provision.repairBridge(b, assigned, this.d.agentsKey!.publicKey, this.bridgeOptions(b))
        else await provision.setupBridge(b, assigned, this.d.agentsKey!.publicKey, { caddy: b.bridgeSetup?.caddy ?? false })
      },
      removeTargets: provision.removeTargets,
      retireBridge: provision.retireBridge,
      verifyExistingBridge: provision.verifyExistingBridge,
      setupScratchBridge: provision.setupScratchBridge,
      repairBridge: async (m, machines, key, settings, onStep) => provision.repairBridge(m, await targets(machines), key, settings, onStep),
      revokeInstallers: provision.revokeInstallers,
      dispose: provision.dispose
    }
    this.bridgeCleanup = new BridgeCleanupQueue({
      userData: options.userData,
      activeBridgeId: () => this.d.bridgeMachineId,
      bridge: id => this.d.machines.find(m => m.id === id) ?? null,
      removeTargets: async (bridge, ids, key) => {
        if (!this.provisioner.removeTargets) throw new MachinesFailure('cleanup_unavailable', 'Tunnel credential removal is unavailable.')
        await this.provisioner.removeTargets(bridge, ids.map(id => this.d.machines.find(m => m.id === id) ?? { id } as Machine), key)
      },
      revokeInstallers: async bridge => {
        if (!this.provisioner.revokeInstallers) throw new MachinesFailure('cleanup_unavailable', 'Installer revocation is unavailable.')
        await this.provisioner.revokeInstallers(bridge)
      }
    })
  }
  private env(): NodeJS.ProcessEnv { return this.options.env?.() ?? process.env }
  private keyPath(name = 'agents_ed25519'): string { return join(this.root, 'keys', name) }
  private requireConfirmation(options: MachineConfirmationOptions | undefined): void {
    if (options?.confirmed !== true) throw new MachinesFailure('confirmation_required', 'Explicitly confirm this machine operation first.')
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => { if (this.disposed) throw new MachinesFailure('closed', 'Machines service is closed.'); await this.load(); return action() })
    this.tail = result.catch(() => undefined)
    return result
  }
  private load(): Promise<void> {
    return this.loaded ??= (async () => {
      this.data = await this.store.load()
      const registry = await privateRead(join(this.root, 'projects.json'))
      if (registry) {
        try {
          const paths = JSON.parse(registry)
          if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string' || !p.startsWith('/') || /[\r\n\0]/.test(p))) throw new Error('Invalid paths')
          this.projects = new Set(paths)
        } catch { throw new MachinesFailure('store_invalid', 'The machine project registry is damaged.') }
      }
      await this.render()
      await this.bridgeCleanup.load()
      await this.bridgeCleanup.runOnce()
      if (this.data.machines.length) this.startPeriodic()
    })().catch(error => { this.loaded = null; throw error })
  }
  private get d(): StoredMachines { if (!this.data) throw new Error('Machines not loaded'); return this.data }
  private machine(id: string): Machine {
    const m = this.d.machines.find(m => m.id === id)
    if (!m) throw new MachinesFailure('machine_missing', 'This machine no longer exists.')
    return m
  }
  private clone(m: Machine): Machine { const copy = structuredClone(m); orderedRoutes(copy); copy.nextActions = machineNextActions(copy); return copy }
  private bridge(): Machine | null { return this.d.machines.find(m => m.id === this.d.bridgeMachineId) ?? null }
  private async result(): Promise<MachinesState> {
    // Do not chmod, read, or write the user's ~/.ssh/config in state/check paths.
    const marker = await privateRead(join(this.root, 'include-installed'))
    const machines = structuredClone(this.d.machines)
    for (const machine of machines) {
      machine.sessionCleanup ??= { account: machine.kind === 'bridged' ? 'dedicated' : 'supplied' }
      const connection = this.d.bridgeConnections?.[machine.id]
      if (connection) { machine.discoveredFrom = connection.source; machine.bridgeConnection = { source: connection.source, users: [connection.tunnelUser, connection.jumpUser], publicUrl: connection.publicUrl, macTunnel: connection.macTunnel, forwards: structuredClone(connection.forwards), managed: connection.managed } }
      if (machine.bridgeSetup) {
        delete machine.bridgeSetup.cleanup
        const cleanup = this.bridgeCleanup.cleanupState(machine.id)
        if (cleanup) machine.bridgeSetup.cleanup = cleanup
        else if (machine.bridgeSetup.error?.code === 'bridge_cleanup_pending') delete machine.bridgeSetup.error
      }
      machine.origin ??= 'drover'
      machine.enabled ??= true
      machine.route ??= machine.kind === 'bridged' && machine.bridgeMachineId ? 'bridge' : machine.host && !publicAddress(machine.host) ? 'lan' : 'direct'
      machine.nextActions = machineNextActions(machine)
      orderedRoutes(machine)
    }
    return { machines, bridgeMachineId: this.d.bridgeMachineId, agentsKey: structuredClone(this.d.agentsKey), sshInclude: { installed: marker === this.includeLine(), line: this.includeLine(), configPath: this.configPath } }
  }
  private includeLine(): string { return `Include "${this.configPath}"` }
  async state(): Promise<MachinesState> { return this.serial(async () => { await this.refreshHerdr(); return this.result() }) }
  async herdrMachines(): Promise<HerdrMachine[]> { return this.serial(async () => { await this.refreshHerdr(); return structuredClone(this.herdrRows) }) }
  private async refreshHerdr(): Promise<void> {
    const registry = this.options.herdr
    if (!registry) return
    let profiles: HerdrSavedMachine[]
    try { profiles = await registry.list() } catch { return }
    this.herdrProfiles = profiles
    const before = JSON.stringify(this.d.machines)
    for (const profile of profiles) {
      const m = this.d.machines.find(m => m.herdrId === profile.id || m.host?.toLowerCase() === profile.host?.toLowerCase() && (m.port ?? 22) === profile.port || profile.host === m.alias)
      if (m) {
        m.herdrId = profile.id; m.herdrLabel = profile.label; m.herdrTarget = profile.target; m.herdrSession = profile.session
        if (!m.herdrSyncError) { m.herdrSynced = true; m.enabled = profile.enabled }
        if (m.origin === 'herdr' && !this.d.installed.includes(m.id)) {
          const normalized = this.importedName(profile.label, m.id)
          if (m.name !== normalized) { m.name = normalized; m.alias = 'drover-' + normalized }
          m.host = profile.host; m.port = profile.port; m.user = profile.user ?? m.user
          m.routes = undefined; orderedRoutes(m)
        }
      } else {
        const name = this.importedName(profile.label)
        this.d.machines.push({ id: randomUUID(), name, alias: 'drover-' + name, kind: 'direct', host: profile.host!, port: profile.port!, user: profile.user ?? this.env().USER ?? 'drover', publicIp: publicAddress(profile.host!), origin: 'herdr', enabled: profile.enabled, herdrId: profile.id, herdrLabel: profile.label, herdrTarget: profile.target, herdrSession: profile.session, herdrSynced: true, permissions: { mode: 'full', projects: [] }, status: { state: 'unknown' } })
      }
    }
    for (const m of [...this.d.machines]) if (m.herdrId && !profiles.some(p => p.id === m.herdrId)) {
      // Forget registry-only imports; retain any Drover-owned access/tunnel grants.
      if (m.origin === 'herdr' && !this.d.installed.includes(m.id) && !m.bridgeMachineId && !this.d.bridgeConnections?.[m.id]) this.d.machines = this.d.machines.filter(x => x !== m)
      else { m.herdrSynced = false; m.herdrSyncError = { code: 'herdr_machine_missing' } }
    }
    for (const m of this.d.machines) if (m.origin === 'herdr' && !this.d.installed.includes(m.id)) m.status = { state: 'unknown', error: { code: 'key_not_installed' } }
    if (before !== JSON.stringify(this.d.machines)) { await this.store.save(this.d); await this.render(); this.options.changed?.(await this.result()) }
    let statuses: Awaited<ReturnType<HerdrMachineRegistry['statuses']>> = []
    // Import is metadata-only. Do not let herdr probe a user's original SSH
    // identities before Drover access has been explicitly connected.
    const connectedIds = profiles.filter(p => this.d.machines.some(m => m.herdrId === p.id && p.target === m.alias && this.d.installed.includes(m.id))).map(p => p.id)
    try { if (connectedIds.length) statuses = await registry.statuses(connectedIds) } catch { /* unknown, never infer online */ }
    this.herdrRows = await Promise.all(profiles.map(async profile => {
      const m = this.d.machines.find(m => m.herdrId === profile.id || !!profile.host && m.host?.toLowerCase() === profile.host.toLowerCase() && (m.port ?? 22) === (profile.port ?? 22))!, status = statuses.find(s => s.id === profile.id)
      const state = !connectedIds.includes(profile.id) ? 'unknown' : status?.status === 'reachable' ? 'online' : status?.status === 'unreachable' || status?.status === 'disabled' || !profile.enabled ? 'offline' : 'unknown'
      const row: HerdrMachine = { id: profile.id, label: profile.label, target: profile.target, host: m.host ?? profile.host!, session: profile.session, enabled: profile.enabled, droverMachineId: m.id, route: m.route ?? (m.kind === 'bridged' && m.bridgeMachineId ? 'bridge' : publicAddress(m.host ?? profile.host!) ? 'direct' : 'lan'), status: { state, checkedAt: Date.now(), ...(state === 'offline' ? { error: { code: !profile.enabled ? 'machine_disabled' : 'host_unreachable' } } : {}) }, workspaces: [] }
      if (state === 'online') try {
        const snapshot = await registry.snapshot(profile.id)
        row.herdrVersion = snapshot.version; row.workspaces = registry.workspaces(snapshot)
      } catch (error) { row.status = { state: 'offline', checkedAt: Date.now(), error: sshError(error) } }
      return row
    }))
    this.options.herdrChanged?.(structuredClone(this.herdrRows))
    if (this.d.machines.length) this.startPeriodic()
    if (!this.herdrPoll && !this.disposed) {
      this.herdrPoll = setTimeout(() => { this.herdrPoll = null; void this.serial(() => this.refreshHerdr()).catch(() => undefined) }, 15_000)
      this.herdrPoll.unref()
    }
  }
  private importedName(label: string, id?: string): string {
    const base = label.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+/, '').slice(0, 25) || 'machine'
    let name = base, suffix = 2
    while (this.d.machines.some(m => m.id !== id && m.name === name)) { const ending = '-' + suffix++; name = base.slice(0, 31 - ending.length) + ending }
    return name
  }
  /** Called after UI access/configuration changes only. Never by refresh/poll. */
  async syncHerdr(options: MachineConfirmationOptions): Promise<void> {
    this.requireConfirmation(options)
    return this.serial(() => this.syncHerdrInternal())
  }
  private async syncHerdrInternal(ids?: string[]): Promise<void> {
      const registry = this.options.herdr
      if (!registry) return
      let profiles: HerdrSavedMachine[]
      try { profiles = await registry.list() }
      catch (error) { for (const m of this.d.machines.filter(m => !ids || ids.includes(m.id))) m.herdrSyncError = sshError(error); await this.changed(); return }
      for (const m of this.d.machines) {
        if (ids && !ids.includes(m.id) || !this.d.installed.includes(m.id)) continue
        if (!m.host && !m.bridgeMachineId || this.infrastructureBridge(m)) continue
        try {
          const target = m.alias, label = m.origin === 'herdr' ? m.herdrLabel ?? m.name : m.name
          let profile = profiles.find(p => p.id === m.herdrId || !!m.host && p.host?.toLowerCase() === m.host.toLowerCase() && p.port === (m.port ?? 22) || p.target === target)
          if (!profile || profile.target !== target) {
            const old = profile
            profile = await registry.add(target, label, m.herdrSession ?? 'default')
            profiles.push(profile)
            // Install/check replacement before removing old connection metadata.
            if (old && old.id !== profile.id) await registry.update('remove', old.id)
          }
          if (profile.label !== label) await registry.rename(profile.id, label)
          if (profile.enabled !== (m.enabled !== false)) await registry.update(m.enabled === false ? 'disable' : 'enable', profile.id)
          m.herdrId = profile.id; m.herdrLabel = label; m.herdrTarget = target; m.herdrSession = profile.session; m.herdrSynced = true; delete m.herdrSyncError
        } catch (error) { m.herdrSynced = false; m.herdrSyncError = sshError(error) }
      }
      await this.changed(); await this.refreshHerdr()
  }
  async startHerdrAgent(req: StartHerdrAgentRequest): Promise<{ paneId: string }> {
    return this.serial(async () => {
      if (!this.options.herdr) throw new MachinesFailure('herdr_unavailable', 'Herdr saved machines are unavailable.')
      await this.refreshHerdr()
      const m = this.d.machines.find(m => m.id === req.machineId || m.herdrId === req.machineId)
      if (!m || m.enabled === false) throw new MachinesFailure('machine_disabled', 'Enable this machine before starting an agent.')
      if (!this.d.installed.includes(m.id)) throw new MachinesFailure('key_not_installed', 'Connect and confirm machine access in Drover before starting an agent.')
      const profile = this.herdrProfiles.find(p => p.id === m.herdrId)
      if (!profile || profile.target !== m.alias) throw new MachinesFailure('herdr_sync_failed', 'Sync this machine with herdr first.')
      const result = await this.options.herdr.start(profile, req)
      await this.refreshHerdr(); return result
    })
  }
  async openHerdrAgent(machineId: string, paneId: string): Promise<void> {
    return this.serial(async () => {
      await this.refreshHerdr()
      const profile = this.herdrProfiles.find(p => p.id === machineId || this.d.machines.some(m => m.id === machineId && m.herdrId === p.id))
      if (!profile || !this.options.herdr || !this.options.openHerdr) throw new MachinesFailure('herdr_unavailable', 'This machine is unavailable.')
      const machine = this.d.machines.find(m => m.herdrId === profile.id)!
      if (!this.d.installed.includes(machine.id)) throw new MachinesFailure('key_not_installed', 'Connect and confirm machine access in Drover before opening an agent.')
      if (machine.enabled === false || profile.target !== machine.alias) throw new MachinesFailure('herdr_sync_failed', 'Enable and sync this machine with herdr first.')
      const snapshot = await this.options.herdr.snapshot(profile.id)
      if (!snapshot.agents.some(a => a.pane_id === paneId)) throw new MachinesFailure('agent_missing', 'This remote agent no longer exists.')
      await this.options.openHerdr(profile, paneId)
    })
  }
  async rename(id: string, name: string, options: MachineConfirmationOptions): Promise<void> {
    this.requireConfirmation(options)
    await this.serial(async () => {
      this.requireConfirmation(options)
      const m = this.machine(id)
      validateDraft(m.kind === 'direct' ? { kind: 'direct', name, host: m.host!, port: m.port!, user: m.user } : { kind: 'bridged', name, os: m.os! })
      if (this.d.machines.some(x => x.id !== id && x.name === name)) throw new MachinesFailure('duplicate_name', 'This machine name already exists.')
      m.name = name; m.alias = 'drover-' + name; m.herdrLabel = name; await this.changed()
      if (this.d.installed.includes(id)) await this.syncHerdrInternal([id])
      else if (m.herdrId && this.options.herdr) { try { await this.options.herdr.rename(m.herdrId, name); delete m.herdrSyncError } catch (error) { m.herdrSyncError = sshError(error) }; await this.changed() }
    })
  }
  async setEnabled(id: string, enabled: boolean, options: MachineConfirmationOptions): Promise<void> {
    this.requireConfirmation(options)
    await this.serial(async () => {
      this.requireConfirmation(options)
      if (typeof enabled !== 'boolean') throw new MachinesFailure('invalid_options', 'Choose enabled or disabled.')
      const m = this.machine(id)
      m.enabled = enabled
      if (m.herdrId && this.options.herdr) { try { await this.options.herdr.update(enabled ? 'enable' : 'disable', m.herdrId); delete m.herdrSyncError } catch (error) { m.herdrSyncError = sshError(error) } }
      await this.changed()
    })
  }
  async enableBridgeRoute(id: string, os: MachineOs, options: MachineConfirmationOptions): Promise<Machine> {
    this.requireConfirmation(options)
    return this.serial(async () => {
      this.requireConfirmation(options)
      const m = this.machine(id), bridge = this.bridge()
      if (!bridge || bridge.bridgeSetup?.state !== 'ready') throw new MachinesFailure('no_bridge', 'Set up a bridge first.')
      if (!['linux', 'macos', 'windows'].includes(os) || m.id === bridge.id) throw new MachinesFailure('unsupported_os', 'Choose the home machine OS.')
      await this.ensureKeys()
      const ports = new Set(this.d.machines.map(m => m.bridgePort)); let port = 2225
      while (ports.has(port) || [8780, 8791].includes(port)) port++
      orderedRoutes(m)
      m.kind = 'bridged'; m.os = os; m.bridgePort ??= port; m.bridgeMachineId = bridge.id; m.publicIp = false
      if (!m.routes!.some(r => r.kind === 'bridge')) m.routes!.push({ kind: 'bridge', port: m.bridgePort, user: 'agent', bridgeMachineId: bridge.id, state: 'setup' })
      await this.migrateRoutePin(m)
      await this.changed(); return this.clone(m)
    })
  }
  async recommendMethod(answer: MachineMethodAnswer): Promise<MachineMethodRecommendation> { return this.serial(async () => recommendMachineMethod(answer, !!this.bridge())) }
  async projectMachinePolicy(cwd: string): Promise<ProjectMachinePolicy> { return this.serial(async () => this.policy(cwd)) }
  private policy(cwd: string): ProjectMachinePolicy { return structuredClone(this.d.projectMachinePolicies?.[cwd] ?? { configureRoles: ['lead', 'orchestrator', 'devops'] }) }
  async setProjectMachinePolicy(cwd: string, policy: ProjectMachinePolicy): Promise<void> {
    return this.serial(async () => {
      if (!cwd.startsWith('/') || /[\r\n\0]/.test(cwd) || !Array.isArray(policy?.configureRoles) || policy.configureRoles.length > 30 || policy.configureRoles.some(r => !/^[a-z][a-z0-9_-]{0,63}$/.test(r))) throw new MachinesFailure('invalid_policy', 'Choose valid project machine roles.')
      this.d.projectMachinePolicies ??= {}; this.d.projectMachinePolicies[cwd] = structuredClone(policy); this.projects.add(cwd); await this.changed()
    })
  }
  async setPurpose(id: string, purpose: string): Promise<void> {
    if (typeof purpose !== 'string' || purpose.length > 500 || /[\r\n\0]/.test(purpose)) throw new MachinesFailure('invalid_purpose', 'Enter a single-line machine purpose, up to 500 characters.')
    return this.serial(async () => { this.machine(id).purpose = purpose.trim(); await this.changed() })
  }
  async phones(): Promise<MachinePhone[]> { return structuredClone(this.options.phones?.() ?? []) }
  async loginKeyCandidates(host: string): Promise<BridgeKeyCandidate[]> {
    validHost(host)
    return adminKeyCandidates({ home: this.options.home, userData: this.options.userData, run: this.run, env: this.env() }, host)
  }
  async movePhoneToBridge(id: string, options: MachineConfirmationOptions): Promise<void> {
    this.requireConfirmation(options)
    return this.serial(async () => {
      const m = this.machine(id)
      if (m.bridgeSetup?.state !== 'ready') throw new MachinesFailure('phone_move_unavailable', 'Set up and verify this bridge phone site before moving the phone connection.')
      if (this.options.movePhone) { await this.options.movePhone(this.clone(m)); return }
      const platform = this.options.platform ?? process.platform
      if (!['darwin','linux'].includes(platform) || !this.options.configurePhone) throw new MachinesFailure('phone_move_unavailable', 'Phone tunnel movement is unavailable on this desktop.')
      const connection = this.d.bridgeConnections?.[id]
      if (!connection?.publicUrl) throw new MachinesFailure('phone_route_missing', 'Explicitly configure and verify this bridge phone HTTPS site first.')
      const settleOrigin = await this.options.phoneOriginTransition?.(connection.publicUrl)
      let committed = false
      try {
        const phonePort = connection.forwards.find(f => f.targetPort !== 22)?.listenPort ?? 8780
        const legacy: LegacyBridge = { tunnelUser: connection.tunnelUser, users: [connection.tunnelUser, connection.jumpUser], forwards: [{ listenHost: '127.0.0.1', listenPort: phonePort, targetHost: '127.0.0.1', targetPort: this.options.remoteSettings?.().remotePort ?? 8791 }], publicUrl: connection.publicUrl, phone: true }
        const verified = await this.verifyBridge(m, legacy)
        if (!verified.policy || !verified.caddy.configured || !verified.caddy.active || !verified.users.some(u => u.name === connection.tunnelUser && u.exists && u.authorizedKeyOptions && u.permitListen.includes(`127.0.0.1:${phonePort}`))) throw new MachinesFailure('phone_route_missing', 'Repair and verify this bridge phone account and HTTPS site before moving it.')
        const publicKey = await this.generateKey('phone-tunnel-' + id)
        this.requireSuccess(await this.execute(m, m.user === 'root' ? 'sh -s' : 'sudo -n sh -s', phoneKeyGrantScript(connection.tunnelUser, publicKey, phonePort)))
        const report = await this.phoneHelper({ action: 'move-phone', home: this.options.home, host: m.host, port: m.port ?? 22, user: connection.tunnelUser, keyPath: this.keyPath('phone-tunnel-' + id), knownHostsPath: this.knownHosts, hostKeyAlias: this.pinName(m), forwards: legacy.forwards, publicUrl: connection.publicUrl, phone: true }, platform)
        if (report.moved !== true || report.verified !== true || report.phoneTunnelRunning !== true || report.missing.length || !report.backupPath) throw new MachinesFailure('phone_move_failed', 'The new phone tunnel could not be verified. Inspect its retained recovery backup before retrying.')
        try {
          await this.options.configurePhone(connection.publicUrl)
          const finished = await this.phoneHelper({ action: 'finish-phone', home: this.options.home, backupPath: report.backupPath }, platform)
          if (finished.verified !== true || finished.phoneTunnelRunning !== true || finished.missing.length) throw new MachinesFailure('phone_recovery_incomplete', 'The phone moved, but transaction cleanup needs attention. Keep the recovery backup.')
          committed = true
          await this.changed()
        } catch (error) {
          if (committed) throw error
          const rollback = await this.phoneHelper({ action: 'rollback-phone', home: this.options.home, backupPath: report.backupPath }, platform)
          if (!rollback.recovered || rollback.missing.length) throw new MachinesFailure('phone_recovery_incomplete', 'Phone settings failed and restoring the previous tunnel needs attention. Keep its transaction backup.')
          if (error instanceof MachinesFailure && error.code === 'phone_recovery_incomplete') throw error
          throw new MachinesFailure('phone_settings_failed', 'Phone settings could not change. The exact previous tunnel was restored.')
        }
      } finally { await settleOrigin?.(committed) }
    })
  }
  private async phoneHelper(manifest: object, platform: NodeJS.Platform): Promise<{ moved?: boolean; verified?: boolean; recovered?: boolean; phoneTunnelRunning?: boolean; missing: string[]; backupPath?: string }> {
    const scratch = await mkdtemp(join(tmpdir(), 'drover-phone-move-'))
    try {
      const script = join(scratch, 'phone.py'), input = join(scratch, 'manifest.json')
      await privateWrite(script, platform === 'darwin' ? await macTunnelAsset(this.options.assetsDir) : await linuxTunnelAsset(this.options.assetsDir))
      await privateWrite(input, JSON.stringify(manifest))
      const result = await this.run('python3', [script, input], { env: this.env(), timeoutMs: 90_000 })
      const prefix = platform === 'darwin' ? 'DROVER_MAC_BRIDGE_REPORT ' : 'DROVER_LINUX_BRIDGE_REPORT '
      try {
        const report = JSON.parse(result.stdout.split('\n').find(line => line.startsWith(prefix))!.slice(prefix.length))
        if (result.code || !Array.isArray(report.missing) || report.missing.some((s: unknown) => typeof s !== 'string') || report.backupPath !== undefined && (typeof report.backupPath !== 'string' || /[\r\n\0]/.test(report.backupPath))) throw Error()
        return report
      } catch { throw new MachinesFailure('phone_move_failed', 'The phone helper could not complete the tunnel transaction. The recovery backup is retained.') }
    } finally { await rm(scratch, { recursive: true, force: true }) }
  }
  private async migrateRoutePin(m: Machine): Promise<void> {
    const old = await privateRead(this.knownHosts) ?? ''
    const directPin = `[${m.host}]:${m.port ?? 22}`, pin = this.pinName(m)
    if (directPin === pin || old.split('\n').some(line => line.startsWith(pin + ' '))) return
    const key = old.split('\n').find(line => line.startsWith(directPin + ' '))?.split(/\s+/).slice(1, 3).join(' ')
    if (key) await privateWrite(this.knownHosts, old.trimEnd() + `\n${pin} ${key}\n`)
  }
  async addRoute(id: string, draft: AddMachineRoute, options: MachineConfirmationOptions): Promise<HostKey | InstallCommand> {
    this.requireConfirmation(options)
    if (!draft || !['lan', 'internet', 'bridge'].includes(draft.kind)) throw new MachinesFailure('invalid_route', 'Choose a connection route.')
    if (draft.kind === 'bridge') {
      const machine = await this.serial(async () => this.clone(this.machine(id)))
      await this.enableBridgeRoute(id, draft.os ?? machine.os ?? 'linux', options)
      return this.installCommand(id, draft.os ?? machine.os ?? 'linux')
    }
    const route: MachineRoute = { kind: draft.kind, host: draft.host, port: draft.port ?? 22, state: 'unknown', address: `${draft.host}:${draft.port ?? 22}` }
    validateRoute(route)
    const probe = await this.probeHostKey(route.host!, route.port!)
    if (!draft.acceptedFingerprint) return probe
    return this.serial(async () => {
      const m = this.machine(id)
      const key = await this.scan(route.host!, route.port!)
      if (fingerprint(key) !== draft.acceptedFingerprint) throw new MachinesFailure('host_key_changed', 'The route host key changed after confirmation.')
      const old = await privateRead(this.knownHosts) ?? '', pin = this.pinName(m)
      const pinned = old.split('\n').find(line => line.startsWith(pin + ' '))
      if (pinned && fingerprint(pinned) !== fingerprint(key)) throw new MachinesFailure('host_key_changed', 'This route leads to a different SSH host. Check the machine address.')
      route.user = m.user
      m.routes = orderedRoutes(m).filter(r => r.kind !== route.kind); m.routes.push(route); orderedRoutes(m)
      if (!m.host) { m.host = route.host; m.port = route.port }
      const routePin = m.kind === 'bridged' ? pin : `[${route.host}]:${route.port}`
      await privateWrite(this.knownHosts, old.split('\n').filter(line => line && !line.startsWith(routePin + ' ')).concat(`${routePin} ${key.split(/\s+/).slice(1, 3).join(' ')}`).join('\n') + '\n')
      m.hostKeyPinnedAt = Date.now(); await this.changed(); return { ...probe, known: true }
    })
  }
  async removeRoute(id: string, kind: MachineRouteKind, options: MachineConfirmationOptions): Promise<void> {
    this.requireConfirmation(options)
    return this.serial(async () => {
      const m = this.machine(id), routes = orderedRoutes(m), route = routes.find(r => r.kind === kind)
      if (!route) return
      if (routes.length === 1) throw new MachinesFailure('last_route', 'Keep one connection route, or remove the machine.')
      // Routes may use different accounts on one host. Keep the route if its
      // key cannot be revoked, so a later retry still knows the old login.
      if ((this.d.installed.includes(id) || this.d.issuedInstallers.includes(id)) && !routes.some(r => r !== route && (r.user ?? m.user) === (route.user ?? m.user))) {
        const keys = await this.ensureKeys(), activeRoute = m.activeRoute, fallback = m.fallback, previousRoute = m.route
        try {
          await this.selectRoute(m, new Set(routes.filter(r => r !== route).map(r => r.kind)))
          for (const key of [...new Set([...(this.d.revocations[id] ?? []), keys.agents])]) await this.updateRouteKey(m, key, keys.management, { remove: true, sessionReason: 'revoke' })
        } finally { m.activeRoute = activeRoute; m.fallback = fallback; m.route = previousRoute; await this.render() }
      }
      if (kind === 'bridge') {
        const b = this.d.machines.find(b => b.id === route.bridgeMachineId)
        if (b) {
          if (!this.provisioner.removeTargets) throw new MachinesFailure('cleanup_unavailable', 'Tunnel grant removal is unavailable.')
          await this.provisioner.removeTargets(b, [m], this.d.agentsKey!.publicKey)
        }
        if (this.d.issuedInstallers.includes(id)) { await this.provisioner.revokeInstallers?.(b ?? null); this.installerAttempts.clear(); this.d.issuedInstallers = this.d.issuedInstallers.filter(x => x !== id) }
        delete m.bridgeMachineId
      }
      m.routes = routes.filter(r => r.kind !== kind)
      const direct = m.routes.find(r => r.kind !== 'bridge' && r.host)
      if (direct) { m.host = direct.host; m.port = direct.port; m.user = direct.user ?? m.user }
      else { delete m.host; delete m.port; m.user = m.routes[0].user ?? m.user }
      if (m.activeRoute === kind) { delete m.activeRoute; m.fallback = false }
      await this.changed()
    })
  }
  private async localBridge(machines?: Machine[], saved = this.data): Promise<LocalBridge | null> {
    const ownPublicKeys = [saved?.agentsKey?.publicKey, ...Object.values(saved?.revocations ?? {}).flat(), ...Object.values(saved?.credentialRemovals ?? {}).flatMap(removal => [...removal.agentsPublicKeys, removal.managementPublicKey])].filter((key): key is string => !!key)
    const ownKeyPaths = Object.values(saved?.bridgeConnections ?? {}).flatMap(connection => [connection.jumpKeyPath, ...(connection.adminManaged ? [connection.adminKeyPath] : [])]).filter((key): key is string => !!key)
    return detectLocalBridge({ home: this.options.home, userData: this.options.userData, run: this.run, env: this.env(), remoteSettings: this.options.remoteSettings?.(), admin: this.options.bridgeAdmin?.(), machines, ownPublicKeys, ownKeyPaths })
  }
  async detectExistingBridge(): Promise<ExistingBridge | null> {
    // Do not load/render/start polling or run the cleanup queue: detection is local only.
    const saved = this.data ?? await this.store.load()
    const local = await this.localBridge(saved.machines, saved)
    return local ? publicExistingBridge(local) : null
  }
  private bridgeSteps(): BridgeProgress[] { return (['connect', 'users', 'firewall', 'mac_tunnel', 'phone_site', 'check'] as BridgeStepId[]).map(step => ({ step, state: 'pending' })) }
  private progress(steps: BridgeProgress[], step: BridgeStepId, state: BridgeProgress['state'], error?: BridgeProgress['error']): void {
    const entry: BridgeProgress = { step, state, ...(error ? { error } : {}) }
    steps[steps.findIndex(s => s.step === step)] = entry
    this.options.bridgeProgress?.(structuredClone(entry))
  }
  private failedReport(machineId: string, steps: BridgeProgress[], error: unknown): BridgeSetupReport {
    const reason = sshError(error), running = steps.find(s => s.state === 'running') ?? steps.find(s => s.state === 'pending') ?? steps.at(-1)!
    this.progress(steps, running.step, 'failed', reason)
    for (const step of steps.filter(s => s.state === 'pending')) this.progress(steps, step.step, 'skipped')
    return { machineId, steps: structuredClone(steps), repairSteps: steps.filter(s => s.state === 'failed').map(s => ({ ...s, state: 'pending' })) }
  }
  private legacy(local: LocalBridge): LegacyBridge { return { users: local.users, tunnelUser: local.tunnelUser, forwards: local.forwards, ...(local.publicUrl ? { publicUrl: local.publicUrl } : {}) } }
  private bridgeOptions(machine: Machine): BridgeOptions {
    const connection = this.d.bridgeConnections?.[machine.id]
    return { caddy: !!connection?.publicUrl || machine.bridgeSetup?.caddy === true, publicOrigin: connection?.installerOrigin ?? connection?.publicUrl, phonePort: connection?.forwards.find(f => f.listenPort !== 2222 && f.targetPort !== 22)?.listenPort ?? 8780 }
  }
  private async verifyBridge(machine: Machine, legacy: LegacyBridge): Promise<ExistingBridgeReport> {
    if (!this.provisioner.verifyExistingBridge) throw new MachinesFailure('bridge_verification_failed', 'Bridge verification is unavailable.')
    return this.provisioner.verifyExistingBridge(machine, legacy)
  }
  private mapVerification(steps: BridgeProgress[], report: ExistingBridgeReport, local: LocalBridge): void {
    const missing = (step: BridgeStepId, code: string) => this.progress(steps, step, 'failed', { code })
    if (!report.users.every(u => u.exists && u.authorizedKeyOptions)) missing('users', 'bridge_users_missing')
    else if (!report.policy) missing('users', 'bridge_policy_missing')
    else this.progress(steps, 'users', 'done')
    if (!local.publicUrl) this.progress(steps, 'firewall', 'skipped')
    else if (!report.firewall) missing('firewall', 'bridge_firewall_missing')
    else this.progress(steps, 'firewall', 'done')
    if (local.macTunnel === 'missing') missing('mac_tunnel', 'mac_tunnel_missing')
    else if (!local.tunnelRunning || local.forwards.some(f => !report.listeners.includes(f.listenPort))) missing('mac_tunnel', 'mac_tunnel_stopped')
    else this.progress(steps, 'mac_tunnel', 'done')
    if (!local.publicUrl) this.progress(steps, 'phone_site', 'skipped')
    else if (!report.caddy.configured || !report.caddy.active || report.missing.includes('phone_route_missing')) missing('phone_site', 'phone_route_missing')
    else this.progress(steps, 'phone_site', 'done')
    const failed = steps.some(s => s.state === 'failed') || report.missing.length > 0
    this.progress(steps, 'check', failed ? 'failed' : 'done', failed ? { code: 'bridge_repair_required' } : undefined)
  }
  private availableName(): string {
    let name = 'bridge', suffix = 2
    while (this.d.machines.some(m => m.name === name)) name = `bridge-${suffix++}`
    return name
  }
  async adoptExistingBridge(options?: BridgeAdoptOptions): Promise<BridgeSetupReport> {
    return this.serial(async () => {
      const steps = this.bridgeSteps(); let machineId = ''
      try {
        this.progress(steps, 'connect', 'running')
        const local = await this.localBridge(this.d.machines)
        if (!local) throw new MachinesFailure('existing_bridge_missing', 'No local bridge configuration was found.')
        if (!options?.acceptedFingerprint) throw new MachinesFailure('host_key_unconfirmed', 'Probe and explicitly confirm the bridge SSH fingerprint first.')
        if (options.keyPath !== undefined && options.password !== undefined) throw new MachinesFailure('invalid_bridge_auth', 'Choose an administrator key or a one-time password for this connection.')
        if ((!local.admin || !local.adminKey) && options.password === undefined && options.keyPath === undefined) throw new MachinesFailure('bridge_admin_key_missing', 'Choose an administrator key from this computer, or use a one-time password if the server allows it.')
        const adminUser = options.user ?? local.admin?.user ?? 'root'
        if (!/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(adminUser)) throw new MachinesFailure('invalid_user', 'Enter a valid administrator SSH login.')
        if (!publicAddress(local.host)) throw new MachinesFailure('no_public_ip', 'The detected bridge needs a public IP address.')
        if (this.d.bridgeMachineId && this.d.bridgeMachineId !== local.machineId) throw new MachinesFailure('bridge_state_conflict', 'A different bridge is active. Switch it explicitly before adopting this server.')
        const existing = local.machineId ? this.machine(local.machineId) : null
        if (existing && existing.user !== adminUser) throw new MachinesFailure('bridge_state_conflict', 'The saved server login differs from the configured bridge administrator.')
        let adminKeyPath = local.admin?.keyPath
        if (options.keyPath !== undefined) {
          adminKeyPath = bridgeKeyPath(options.keyPath, this.options.home)
          // A rejected login must not become a saved machine that prevents correcting it.
          const target = existing ?? { kind: 'direct' as const, id: '', alias: local.host, host: local.host, port: local.port, user: adminUser }
          await this.pin(target, options.acceptedFingerprint)
          await this.authenticateBridgeAdminKey(target, adminKeyPath)
        }
        const m = existing ?? this.machine((await this.addInternal({ kind: 'direct', name: this.availableName(), host: local.host, port: local.port, user: adminUser })).id)
        machineId = m.id
        if (options.keyPath === undefined) await this.pin(m, options.acceptedFingerprint)
        else await privateWrite(join(this.options.userData, 'bridge-admin.json'), JSON.stringify({ host: m.host, port: m.port, user: m.user, keyPath: adminKeyPath }))
        this.d.bridgeConnections ??= {}
        const previous = this.d.bridgeConnections[m.id]
        this.d.bridgeConnections[m.id] = { ...previous, source: previous?.source ?? 'existing', adminKeyPath, adminManaged: options.keyPath !== undefined ? false : previous?.adminManaged, jumpUser: previous?.managed ? 'drover-jump' : 'jump', tunnelUser: local.tunnelUser, forwards: structuredClone(local.forwards), publicUrl: local.publicUrl, macTunnel: local.macTunnel, ...(previous?.jumpKeyPath ? { jumpKeyPath: previous.jumpKeyPath } : await keyExists(join(this.options.home, '.ssh/mac_jump_ed25519')) ? { jumpKeyPath: join(this.options.home, '.ssh/mac_jump_ed25519') } : {}) }
        await this.changed()
        if (options.password !== undefined) {
          await this.installBridgeAdminKey(m, options.password)
          await privateWrite(join(this.options.userData, 'bridge-admin.json'), JSON.stringify({ host: m.host, port: m.port, user: m.user, keyPath: this.keyPath('management_ed25519') }))
        }
        await this.render()
        let report: ExistingBridgeReport
        try { report = await this.verifyBridge(m, this.legacy(local)) }
        catch (e) { await this.changed(); throw e }
        this.progress(steps, 'connect', 'done')
        if (!previous?.managed) this.d.bridgeConnections[m.id].jumpUser = report.jumpUser
        m.bridgeSetup = { state: report.policy && report.users.some(u => u.name === local.tunnelUser && u.exists && u.authorizedKeyOptions) && report.users.some(u => u.name === report.jumpUser && u.exists && u.authorizedKeyOptions) ? 'ready' : 'failed', caddy: !!local.publicUrl && report.caddy.configured, checkedAt: Date.now() }
        m.status = { state: 'online', checkedAt: Date.now(), checks: { tcp: true, auth: true } }
        this.d.bridgeMachineId = m.id
        this.mapVerification(steps, report, local)
        const phoneError = steps.find(step => step.step === 'phone_site' && step.state === 'failed')?.error ?? steps.find(step => step.step === 'mac_tunnel' && step.state === 'failed')?.error
        if (phoneError) m.bridgeSetup.error = structuredClone(phoneError)
        await this.changed()
        return { machineId: m.id, steps: structuredClone(steps), repairSteps: steps.filter(s => s.state === 'failed' && s.step !== 'check').map(s => ({ ...s, state: 'pending' })) }
      } catch (error) { return this.failedReport(machineId, steps, error) }
    })
  }
  private directSshArgs(host: string, port: number, user: string, knownHosts: string, pin = `[${host}]:${port}`): string[] {
    return ['-F', '/dev/null', '-p', String(port), '-l', user, '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'GlobalKnownHostsFile=/dev/null', '-o', `HostKeyAlias=${pin}`, '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'ConnectTimeout=5']
  }
  private async authenticateBridgeAdminKey(machine: Pick<Machine, 'host' | 'port' | 'user'>, keyPath: string | undefined): Promise<void> {
    const unreadable = () => new MachinesFailure('bridge_admin_key_unreadable', 'The administrator key could not be read or used. If it has a passphrase, unlock this exact key in ssh-agent on this computer and try again; Drover cannot prompt for a key passphrase in BatchMode.')
    if (!keyPath || !await keyExists(keyPath)) throw unreadable()
    try { await access(keyPath, constants.R_OK) } catch { throw unreadable() }
    const result = await this.run('ssh', [...this.directSshArgs(machine.host!, machine.port!, machine.user, this.knownHosts), '-i', keyPath, '-o', 'PreferredAuthentications=publickey', '-o', 'LogLevel=DEBUG1', machine.host!, 'true'], { env: this.env(), timeoutMs: 15_000 })
    if (!result.code) return
    if (/Load key|identity file .*not accessible|no such identity|bad permissions|UNPROTECTED PRIVATE KEY|passphrase|sign_and_send_pubkey: signing failed|agent refused|agent contains no identities|invalid format|error in libcrypto/i.test(result.stderr) || /Server accepts key/i.test(result.stderr) && !/Authenticated to/i.test(result.stderr)) throw unreadable()
    const reason = sshError(result.stderr)
    if (reason.code === 'auth_failed') throw new MachinesFailure('bridge_admin_key_rejected', 'The server rejected this administrator key for the selected login. Check the login and choose the key authorized for that account.')
    throw new MachinesFailure(reason.code, reason.detail!)
  }
  private async setupMacTunnel(local: LocalBridge): Promise<void> {
    const scratch = await mkdtemp(join(tmpdir(), 'drover-mac-bridge-'))
    try {
      const script = join(scratch, 'mac-tunnel.py'), manifest = join(scratch, 'manifest.json')
      await privateWrite(script, await macTunnelAsset(this.options.assetsDir))
      await privateWrite(manifest, JSON.stringify({ action: 'setup', home: this.options.home, host: local.host, port: local.port, user: local.tunnelUser, keyPath: local.keyPath, knownHostsPath: local.knownHostsPath ?? this.knownHosts, hostKeyAlias: local.hostKeyAlias ?? `[${local.host}]:${local.port}`, forwards: local.forwards, publicUrl: local.publicUrl, phone: !!local.publicUrl }))
      const result = await this.run('python3', [script, manifest], { env: this.env(), timeoutMs: 30_000 })
      if (result.code) throw new MachinesFailure('mac_tunnel_setup_failed', 'The Mac bridge LaunchAgent could not be configured.')
      const line = result.stdout.split('\n').find(l => l.startsWith('DROVER_MAC_BRIDGE_REPORT '))
      let report: { tunnelRunning: boolean; missing: string[] }
      try { report = JSON.parse(line!.slice('DROVER_MAC_BRIDGE_REPORT '.length)); if (typeof report.tunnelRunning !== 'boolean' || !Array.isArray(report.missing)) throw Error() }
      catch { throw new MachinesFailure('invalid_response', 'The Mac tunnel returned an invalid report.') }
      if (!report.tunnelRunning || report.missing.length) throw new MachinesFailure('mac_tunnel_stopped', 'The Mac bridge LaunchAgent is not running. Check local SSH and Drover remote access.')
      local.tunnelRunning = true; local.macTunnel = 'running'
    } finally { await rm(scratch, { recursive: true, force: true }) }
  }
  async setupBridgeFromScratch(options: BridgeScratchOptions): Promise<BridgeSetupReport> {
    return this.serial(async () => {
      const steps = this.bridgeSteps(); let machineId = '', m: Machine | undefined
      try {
        this.progress(steps, 'connect', 'running')
        const port = options?.port ?? 22
        validateDraft({ kind: 'direct', name: 'bridge', host: options?.host, port, user: options?.user })
        if (typeof options.caddy !== 'boolean') throw new MachinesFailure('invalid_bridge_options', 'Choose whether to set up phone access.')
        if (!options.acceptedFingerprint) throw new MachinesFailure('host_key_unconfirmed', 'Probe and explicitly confirm the bridge SSH fingerprint first.')
        if (!options.password) throw new MachinesFailure('invalid_password', 'Enter the one-time administrator password.')
        if (!publicAddress(options.host)) throw new MachinesFailure('no_public_ip', 'A bridge needs a public IP address.')
        if (await this.localBridge(this.d.machines) || this.d.bridgeMachineId || Object.keys(this.d.bridgeConnections ?? {}).length) throw new MachinesFailure('bridge_state_conflict', 'An existing bridge is configured. Adopt or repair it before creating another tunnel.')
        const saved = this.d.machines.find(x => x.kind === 'direct' && x.host === options.host && x.port === port)
        if (saved && saved.user !== options.user) throw new MachinesFailure('bridge_state_conflict', 'The saved administrator login differs.')
        m = saved ?? this.machine((await this.addInternal({ kind: 'direct', name: this.availableName(), host: options.host, port, user: options.user })).id); machineId = m.id
        await this.pin(m, options.acceptedFingerprint)
        this.d.bridgeConnections ??= {}
        this.d.bridgeConnections[m.id] = { source: 'scratch', adminKeyPath: this.keyPath('management_ed25519'), jumpUser: 'jump', tunnelUser: 'bridge-mac', forwards: [], macTunnel: 'missing' }
        await this.changed()
        await this.installBridgeAdminKey(m, options.password)
        const checked = await this.checkInternal(m)
        if (!checked.status.checks?.auth) throw new MachinesFailure(checked.status.error?.code ?? 'auth_failed', 'The new SSH key could not authenticate.')
        if (checked.os !== 'linux') throw new MachinesFailure('unsupported_os', 'A bridge needs a supported Debian or Ubuntu server.')
        if (options.caddy && options.host.includes(':')) throw new MachinesFailure('invalid_host', 'Automatic sslip.io phone setup currently needs an IPv4 bridge address.')
        await privateWrite(join(this.options.userData, 'bridge-admin.json'), JSON.stringify({ host: m.host, port: m.port, user: m.user, keyPath: this.keyPath('management_ed25519') }))
        this.progress(steps, 'connect', 'done')
        const keys = await this.ensureKeys(), tunnel = await this.generateKey('mac-bridge-' + m.id), phoneJump = await this.generateKey('mac-phone-jump-' + m.id)
        const publicUrl = options.caddy ? `https://${options.host.replace(/\./g, '-')}.sslip.io` : undefined
        const local: LocalBridge = { host: options.host, port, users: ['bridge-mac', 'jump'], tunnelUser: 'bridge-mac', keyPath: this.keyPath('mac-bridge-' + m.id), forwards: [{ listenHost: '127.0.0.1', listenPort: 2222, targetHost: '127.0.0.1', targetPort: 22 }, ...(options.caddy ? [{ listenHost: '127.0.0.1', listenPort: 8780, targetHost: '127.0.0.1', targetPort: this.options.remoteSettings?.().remotePort ?? 7780 }] : [])], publicUrl, adminKey: true, tunnelRunning: false, macTunnel: 'missing' }
        if (!this.provisioner.setupScratchBridge) throw new MachinesFailure('bridge_verification_failed', 'Bridge setup is unavailable.')
        this.d.bridgeConnections ??= {}
        this.d.bridgeConnections[m.id] = { ...this.d.bridgeConnections[m.id], source: 'scratch', jumpUser: 'jump', jumpKeyPath: this.keyPath('mac-phone-jump-' + m.id), tunnelUser: local.tunnelUser, forwards: local.forwards, publicUrl, macTunnel: local.macTunnel }
        m.bridgeSetup = { state: 'running', caddy: options.caddy }; await this.changed()
        await this.provisioner.setupScratchBridge(m, { tunnel, agents: phoneJump, management: keys.management }, { caddy: options.caddy, publicOrigin: publicUrl }, async (step, state) => this.progress(steps, step, state))
        if (publicUrl) {
          this.progress(steps, 'phone_site', 'running')
          try { await this.options.configurePhone?.(publicUrl) } catch { throw new MachinesFailure('phone_route_missing', 'Drover remote access could not start on this Mac.') }
          this.progress(steps, 'phone_site', 'done')
        }
        this.progress(steps, 'mac_tunnel', 'running'); await this.setupMacTunnel(local); this.d.bridgeConnections[m.id].macTunnel = local.macTunnel; this.progress(steps, 'mac_tunnel', 'done')
        this.progress(steps, 'check', 'running')
        const report = await this.verifyBridge(m, this.legacy(local))
        this.mapVerification(steps, report, local)
        this.d.bridgeConnections ??= {}
        this.d.bridgeConnections[m.id] = { ...this.d.bridgeConnections[m.id], source: 'scratch', jumpUser: 'jump', jumpKeyPath: this.keyPath('mac-phone-jump-' + m.id), tunnelUser: local.tunnelUser, forwards: local.forwards, publicUrl, macTunnel: local.macTunnel }
        m.bridgeSetup = { state: report.policy && report.users.every(u => u.exists && u.authorizedKeyOptions) ? 'ready' : 'failed', caddy: options.caddy, checkedAt: Date.now() }
        this.d.bridgeMachineId = m.id; await this.changed()
        if (steps.find(s => s.step === 'users')?.state === 'done') await this.repairInternal({ machineId, acceptedFingerprint: options.acceptedFingerprint, confirmed: true }, steps)
        return { machineId, steps: structuredClone(steps), repairSteps: steps.filter(s => s.state === 'failed' && s.step !== 'check').map(s => ({ ...s, state: 'pending' })) }
      } catch (error) {
        if (m?.bridgeSetup) { m.bridgeSetup = { ...m.bridgeSetup, state: 'failed', error: sshError(error) }; await this.changed() }
        return this.failedReport(machineId, steps, error)
      }
    })
  }
  async repairExistingBridge(options: BridgeRepairOptions): Promise<BridgeSetupReport> {
    return this.serial(async () => {
      const steps = this.bridgeSteps()
      try { await this.repairInternal(options, steps); return { machineId: options.machineId, steps: structuredClone(steps), repairSteps: steps.filter(s => s.state === 'failed' && s.step !== 'check').map(s => ({ ...s, state: 'pending' })) } }
      catch (error) { return this.failedReport(options?.machineId ?? '', steps, error) }
    })
  }
  private async repairInternal(options: BridgeRepairOptions, steps: BridgeProgress[]): Promise<void> {
    this.progress(steps, 'connect', 'running')
    if (options?.confirmed !== true) throw new MachinesFailure('bridge_repair_confirmation_required', 'Confirm adding Drover grants and the installer route before repairing this bridge.')
    const m = this.machine(options.machineId), connection = this.d.bridgeConnections?.[m.id]
    if (!connection) throw new MachinesFailure('existing_bridge_missing', 'Adopt the existing bridge before repairing it.')
    if (!this.provisioner.repairBridge) throw new MachinesFailure('bridge_verification_failed', 'Bridge repair is unavailable.')
    await this.pin(m, options.acceptedFingerprint)
    const before = await this.verifyBridge(m, { users: [connection.tunnelUser, 'jump'], tunnelUser: connection.tunnelUser, forwards: connection.forwards, publicUrl: connection.publicUrl })
    if (!before.policy || !before.users.every(u => u.exists && u.authorizedKeyOptions)) throw new MachinesFailure('bridge_policy_missing', 'The existing tunnel policy needs repair before adding Drover grants.')
    const keys = await this.ensureKeys()
    await this.installBridgeAdminKey(m, options.password)
    // Retire this installation's former unrestricted bridge agent credential.
    this.requireSuccess(await this.execute(m, 'sh -s', removeKeyScript(keys.agents, keys.management)))
    connection.installerOrigin ??= connection.publicUrl ?? `https://${m.host!.replace(/\./g, '-')}.sslip.io`
    await privateWrite(join(this.options.userData, 'bridge-admin.json'), JSON.stringify({ host: m.host, port: m.port, user: m.user, keyPath: connection.adminKeyPath }))
    await this.changed()
    this.progress(steps, 'connect', 'done')
    const managedTargets = this.d.machines.filter(t => t.kind === 'bridged' && (!t.bridgeMachineId || t.bridgeMachineId === m.id))
    // Legacy ports are permanent reservations even when the old machine is offline.
    const reserved = new Set([2222, 2223, 2224, 8780, 8791, ...connection.forwards.map(f => f.listenPort), ...before.listeners.filter(p => !this.d.machines.some(t => t.bridgeMachineId === m.id && t.bridgePort === p))])
    let nextPort = 2225
    for (const target of managedTargets) {
      if (reserved.has(target.bridgePort!)) {
        if (this.d.issuedInstallers.includes(target.id) || this.d.installed.includes(target.id)) throw new MachinesFailure('bridge_port_conflict', 'An existing machine uses a legacy bridge port. Repoint its tunnel explicitly before repair.')
        while (reserved.has(nextPort) || this.d.machines.some(t => t.id !== target.id && t.bridgePort === nextPort)) nextPort++
        target.bridgePort = nextPort++
      }
      reserved.add(target.bridgePort!)
    }
    this.progress(steps, 'users', 'running')
    await this.provisioner.repairBridge(m, managedTargets, keys.agents, this.bridgeOptions(m), async () => undefined)
    const local = await this.localBridge(this.d.machines)
    const legacy: LegacyBridge = { users: [...new Set([connection.tunnelUser, 'jump', 'drover-jump', ...managedTargets.map(bridgeTunnelUser)])], tunnelUser: connection.tunnelUser, forwards: connection.forwards, publicUrl: connection.installerOrigin, phone: !!connection.publicUrl }
    const verified = await this.verifyBridge(m, legacy)
    if (!verified.policy || legacy.users!.some(name => !verified.users.some(u => u.name === name && u.exists && u.authorizedKeyOptions))) throw new MachinesFailure('bridge_policy_missing', 'Bridge repair did not verify all legacy and Drover SSH grants.')
    if (!verified.caddy.installerRoute || !verified.caddy.active) throw new MachinesFailure('caddy_repair_requires_manual_integration', 'The installer route could not be verified at the selected bridge site.')
    connection.managed = true; connection.jumpUser = 'drover-jump'; connection.jumpKeyPath = this.keyPath()
    m.needsReinstall = false; m.bridgeSetup = { state: 'ready', caddy: !!connection.publicUrl, checkedAt: Date.now() }
    for (const target of managedTargets) target.bridgeMachineId = m.id
    if (!this.d.bridgeMachineId || this.d.bridgeMachineId === m.id) this.d.bridgeMachineId = m.id
    const mapped: LocalBridge = local ?? { host: m.host!, port: m.port!, users: legacy.users!, tunnelUser: connection.tunnelUser, forwards: connection.forwards, publicUrl: connection.publicUrl, tunnelRunning: connection.macTunnel === 'running', macTunnel: connection.macTunnel, adminKey: true }
    this.mapVerification(steps, verified, mapped)
    const failed = steps.find(step => step.state === 'failed' && step.step !== 'check') ?? steps.find(step => step.state === 'failed')
    if (failed) m.bridgeSetup = { ...m.bridgeSetup, state: 'failed', error: structuredClone(failed.error ?? { code: 'bridge_verification_failed' }) }
    await this.changed()
  }
  async status(): Promise<MachinesStatus> { const s = await this.state(); return { machines: s.machines.map(m => ({ ...m, permissions: { mode: m.permissions.mode, projects: [] } })), bridgeMachineId: s.bridgeMachineId } }
  private async changed(): Promise<void> {
    await this.store.save(this.d)
    await this.render()
    this.options.changed?.(await this.result())
  }
  private pinName(m: Pick<Machine, 'kind' | 'host' | 'port' | 'id'>): string { return m.kind === 'direct' ? `[${m.host}]:${m.port}` : `drover-machine-${m.id}` }
  private infrastructureBridge(m: Machine): boolean {
    return m.kind === 'direct' && (m.id === this.d.bridgeMachineId || !!this.d.bridgeConnections?.[m.id] || !!m.bridgeSetup && m.bridgeSetup.state !== 'none')
  }
  private agentMachines(): Machine[] { return this.d.machines.filter(m => m.enabled !== false && !this.infrastructureBridge(m)) }
  private sshBlock(alias: string, host: string, port: number, user: string, key: string, pin: string, jump?: string, useIdentityAgent = false): string {
    return `Host ${alias}\n  HostName ${host}\n  Port ${port}\n  User ${user}\n  IdentityFile "${key}"\n  IdentitiesOnly yes\n${useIdentityAgent ? '' : '  IdentityAgent none\n'}  UserKnownHostsFile "${this.knownHosts}"\n  GlobalKnownHostsFile /dev/null\n  HostKeyAlias ${pin}\n  StrictHostKeyChecking yes\n  BatchMode yes\n  PasswordAuthentication no\n  KbdInteractiveAuthentication no\n  ForwardAgent no\n  ForwardX11 no\n  ConnectTimeout 5\n  ServerAliveInterval 30\n  ServerAliveCountMax 2\n${jump ? `  ProxyJump ${jump}\n` : ''}\n`
  }
  private routeBlock(m: Machine, management = false): string {
    const routes = orderedRoutes(m), selected = routes.find(r => r.kind === m.activeRoute) ?? routes.find(r => r.state !== 'setup') ?? routes[0]
    if (!selected || m.enabled === false) return ''
    const alias = management ? `drover-management-${m.id}` : m.alias
    if (selected.kind !== 'bridge' && !selected.host) return ''
    const key = management ? this.d.bridgeConnections?.[m.id]?.adminKeyPath ?? this.keyPath('management_ed25519') : this.keyPath()
    const user = selected.user ?? m.user
    if (selected.kind !== 'bridge') return this.sshBlock(alias, selected.host!, selected.port ?? 22, user, key, m.kind === 'bridged' ? this.pinName(m) : `[${selected.host}]:${selected.port ?? 22}`, undefined, management && !!this.d.bridgeConnections?.[m.id]?.adminKeyPath && !this.d.bridgeConnections[m.id].adminManaged).replace('ConnectTimeout 5', selected.kind === 'lan' ? 'ConnectTimeout 1' : 'ConnectTimeout 5')
    const bridge = this.d.machines.find(b => b.id === (selected.bridgeMachineId ?? m.bridgeMachineId))
    if (!bridge) return ''
    return this.sshBlock(alias, '127.0.0.1', selected.port ?? m.bridgePort!, user, key, this.pinName(m), `drover-${management ? 'management' : 'jump'}-${bridge.id}`)
  }
  private async render(): Promise<void> {
    if (!this.d.machines.length && !this.d.agentsKey) return
    await privateDirectory(this.root)
    let text = '# Managed by Drover Machines. Do not put passwords here.\n\n'
    for (const m of this.d.machines) {
      if (!m.needsReinstall && !this.infrastructureBridge(m)) text += this.routeBlock(m)
      text += this.routeBlock(m, true)
    }
    const b = this.bridge()
    if (b) { const connection = this.d.bridgeConnections?.[b.id]; text += this.sshBlock(`drover-jump-${b.id}`, b.host!, b.port!, connection?.jumpUser ?? 'drover-jump', connection?.jumpKeyPath ?? this.keyPath(), this.pinName(b)) }
    await privateWrite(this.controlConfig, text)
    const publicBlocks = text.split(/(?=^Host )/m).filter(block => {
      const alias = block.match(/^Host (\S+)/)?.[1]
      if (!alias) return true
      if (alias.startsWith('drover-management-')) return false
      if (alias.startsWith('drover-jump-')) return !!b && alias === `drover-jump-${b.id}` && (!this.d.bridgeConnections?.[b.id] || this.d.bridgeConnections[b.id].managed === true)
      return true
    })
    // Desktop Herdr can use scoped aliases. Agent launch guides expose them
    // only to the selected project; neither config contains management keys.
    await privateWrite(join(this.root, 'herdr_ssh_config'), publicBlocks.join(''))
    const agentBlocks = publicBlocks.filter(block => {
      const alias = block.match(/^Host (\S+)/)?.[1]
      const machine = this.d.machines.find(m => m.alias === alias)
      return !machine || machine.permissions.mode !== 'projects'
    }).join('')
    await privateWrite(this.configPath, agentBlocks)
    if (await privateRead(this.knownHosts) === null) await privateWrite(this.knownHosts, '')
    await writeAwareness(this.options.home, this.root, this.agentMachines())
    for (const project of this.projects) await this.projectGuide(project)
  }
  private async generateKey(name: string): Promise<string> {
    const path = this.keyPath(name)
    await privateDirectory(join(this.root, 'keys'))
    if (await privateRead(path) !== null) {
      const pub = await privateRead(path + '.pub')
      if (!pub) throw new MachinesFailure('key_damaged', 'A managed SSH key is missing its public key. Restore it or revoke access.')
      fingerprint(pub)
      return pub.trim()
    }
    const result = await this.run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'drover-' + name, '-f', path], { env: this.env() })
    if (result.code) throw new MachinesFailure('key_generation_failed', 'Could not generate a dedicated SSH key.')
    await privateRead(path)
    const pub = await privateRead(path + '.pub')
    if (!pub) throw new MachinesFailure('key_generation_failed', 'SSH key generation did not create a public key.')
    fingerprint(pub)
    return pub.trim()
  }
  private async ensureKeys(): Promise<{ agents: string; management: string }> {
    const agents = await this.generateKey('agents_ed25519'), management = await this.generateKey('management_ed25519')
    if (this.d.agentsKey && this.d.agentsKey.publicKey !== agents) {
      // Recover an interrupted atomic key rotation only if the old public key
      // was durably recorded for remote cleanup before replacement.
      if (!Object.values(this.d.revocations).some(keys => keys.includes(this.d.agentsKey!.publicKey))) throw new MachinesFailure('key_damaged', 'The agents key differs from its saved fingerprint. Restore or revoke it.')
      this.d.agentsKey = { publicKey: agents, fingerprint: fingerprint(agents), createdAt: Date.now() }
      for (const m of this.d.machines) m.needsReinstall = true
      await this.store.save(this.d)
    }
    this.d.agentsKey ??= { publicKey: agents, fingerprint: fingerprint(agents), createdAt: Date.now() }
    return { agents, management }
  }
  async add(draft: MachineDraft): Promise<Machine> {
    const m = await this.serial(() => this.addInternal(draft))
    // A raw draft is not connected yet. Sync only after key onboarding completes.
    return m
  }
  private async addInternal(input: MachineDraft): Promise<Machine> {
      validateDraft(input)
      const draft: DirectDraft | BridgedDraft = 'firstRoute' in input ? input.firstRoute === 'bridge' || input.firstRoute === 'lan' && !input.host ? { kind: 'bridged', name: input.name, os: input.os! } : { kind: 'direct', name: input.name, host: input.host!, port: input.port ?? 22, user: input.user ?? 'drover' } : input
      if ('firstRoute' in input && input.firstRoute === 'bridge' && !this.bridge()) throw new MachinesFailure('no_bridge', 'Set up a bridge before adding this route.')
      if (this.d.machines.some(m => m.name === draft.name)) throw new MachinesFailure('duplicate_name', 'A machine with this name already exists.')
      await this.ensureKeys()
      const b = this.bridge()
      const taken = new Set([...this.d.machines.map(m => m.bridgePort), ...(b && this.d.bridgeConnections?.[b.id] ? [2222, 2223, 2224, 8780, 8791, ...this.d.bridgeConnections[b.id].forwards.map(f => f.listenPort)] : [])])
      let bridgePort = 2224; while (taken.has(bridgePort) || bridgePort === 8780) bridgePort++
      const m: Machine = { id: randomUUID(), name: draft.name, kind: draft.kind, alias: `drover-${draft.name}`, user: draft.kind === 'direct' ? draft.user : 'agent', publicIp: draft.kind === 'direct' && publicAddress(draft.host), permissions: { mode: 'full', projects: [] }, status: { state: draft.kind === 'direct' ? 'unknown' : 'waiting', error: { code: draft.kind === 'direct' ? 'key_not_installed' : b ? 'tunnel_down' : 'no_bridge' } }, ...(draft.kind === 'direct' ? { host: draft.host, port: draft.port } : { os: draft.os, bridgePort, ...(b ? { bridgeMachineId: b.id } : {}) }) }
      this.d.machines.push(m)
      m.discoveredFrom = 'manual'
      orderedRoutes(m)
      if ('firstRoute' in input && draft.kind === 'direct') m.routes![0].kind = input.firstRoute
      if ('firstRoute' in input && input.firstRoute === 'lan' && !input.host) {
        m.routes = [{ kind: 'lan', port: 22, user: 'agent', state: 'setup' }]
        if (!input.alsoBridge) delete m.bridgeMachineId
      }
      if ('firstRoute' in input && input.alsoBridge && input.firstRoute !== 'bridge') {
        m.os = input.os
        m.bridgePort = bridgePort; m.bridgeMachineId = b?.id
        if (!m.routes!.some(r => r.kind === 'bridge')) m.routes!.push({ kind: 'bridge', port: bridgePort, bridgeMachineId: b?.id, user: 'agent', state: 'setup' })
      }
      try { await this.changed() } catch (e) { this.d.machines = this.d.machines.filter(x => x.id !== m.id); throw e }
      this.startPeriodic()
      return this.clone(m)
  }
  private async scan(host: string, port: number, machine?: Pick<Machine, 'kind' | 'host' | 'port' | 'bridgeMachineId'>): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt++) {
      let result: CommandResult | undefined
      try {
        if (machine?.kind === 'bridged') {
          const b = this.d.machines.find(b => b.id === machine.bridgeMachineId)
          if (b) result = await this.execute(b, `ssh-keyscan -T 5 -t ed25519 -p ${port} 127.0.0.1`, undefined, true)
          else if (machine.host) result = await this.run('ssh-keyscan', ['-T', '5', '-t', 'ed25519', '-p', String(machine.port ?? 22), machine.host], { timeoutMs: 10_000, env: this.env() })
          else throw new MachinesFailure('lan_install_pending', 'Run the installer on this local network. Its report will supply the machine’s LAN address; a public bridge is needed across networks.')
        } else result = await this.run('ssh-keyscan', ['-T', '5', '-t', 'ed25519', '-p', String(port), host], { timeoutMs: 10_000, env: this.env() })
      } catch (error) { if (sshError(error).code !== 'timeout') throw error }
      const key = result?.stdout.split('\n').find(line => !line.startsWith('#') && line.split(/\s+/)[1] === 'ssh-ed25519')
      if (key) { fingerprint(key); return key.trim() }
      if (attempt < 2) await delay(250 * (attempt + 1))
    }
    throw new MachinesFailure(machine?.kind === 'bridged' ? 'tunnel_down' : 'host_unreachable', machine?.kind === 'bridged' ? 'The home machine has not connected its tunnel to the bridge.' : 'Could not read an SSH host key. Check the address, port and firewall. The server may be briefly busy; try again in a minute.')
  }
  private async passwordAllowed(host: string, port: number, key: string, user: string): Promise<boolean | undefined> {
    const scratch = await mkdtemp(join(tmpdir(), 'drover-auth-probe-'))
    try {
      const pins = join(scratch, 'known_hosts')
      await privateWrite(pins, `[${host}]:${port} ${key.split(/\s+/).slice(1, 3).join(' ')}\n`)
      const result = await this.run('ssh', [...this.directSshArgs(host, port, user, pins), '-o', 'PreferredAuthentications=none', '-o', 'PubkeyAuthentication=no', '-o', 'IdentityAgent=none', '-o', 'IdentityFile=none', host, 'true'], { env: this.env(), timeoutMs: 10_000 })
      if (sshError(result.stderr).code === 'host_key_changed') throw new MachinesFailure('host_key_changed', 'The host key changed during the probe. Check it again through a trusted channel.')
      const methods = result.stderr.match(/Permission denied\s*\(([^)]*)\)/i)?.[1]
      return methods === undefined ? undefined : methods.split(',').some(method => method.trim() === 'password')
    } catch (error) { if (sshError(error).code === 'host_key_changed') throw error; return undefined }
    finally { await rm(scratch, { recursive: true, force: true }) }
  }
  async probeHostKey(host: string, port: number, user?: string): Promise<HostKey> {
    if (user !== undefined && (typeof user !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(user))) throw new MachinesFailure('invalid_user', 'Enter a valid administrator SSH login.')
    return this.serial(async () => {
      const m = this.d.machines.find(m => m.alias === host && m.kind === 'bridged')
      if (m) { if (port !== m.bridgePort && port !== m.port) throw new MachinesFailure('invalid_port', 'Use this machine’s current SSH port.') }
      else validHost(host)
      validPort(port)
      const key = await this.scan(host, port, m)
      const pin = m ? this.pinName(m) : `[${host}]:${port}`
      const managedKnown = (await privateRead(this.knownHosts) ?? '').split('\n').some(line => line.split(/\s+/)[0] === pin && fingerprint(line) === fingerprint(key))
      let userKnown = false
      if (!m) {
        // ssh-keygen understands hashed known_hosts. Read only this public file;
        // unlike privateRead, never chmod or write the user's SSH files.
        const file = join(this.options.home, '.ssh', 'known_hosts')
        try {
          const stat = await lstat(file)
          if (stat.isFile() && !stat.isSymbolicLink()) for (const name of port === 22 ? [host, pin] : [pin]) {
            const found = await this.run('ssh-keygen', ['-F', name, '-f', file], { env: this.env(), timeoutMs: 5000 })
            userKnown ||= found.stdout.split('\n').some(line => !line.startsWith('#') && line.trim() && fingerprint(line) === fingerprint(key))
          }
        } catch { /* No public pin available. Confirmation is still required. */ }
      }
      const known = managedKnown || userKnown
      const login = user ?? this.d.machines.find(m => m.kind === 'direct' && m.host === host && m.port === port)?.user ?? 'root'
      const passwordAllowed = m ? undefined : await this.passwordAllowed(host, port, key, login)
      return { algorithm: 'ssh-ed25519', fingerprint: fingerprint(key), known, ...(passwordAllowed !== undefined ? { passwordAllowed } : {}) }
    })
  }
  private async pin(m: Pick<Machine, 'kind' | 'host' | 'port' | 'id' | 'alias' | 'bridgePort' | 'bridgeMachineId'>, accepted: string): Promise<void> {
    if (typeof accepted !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(accepted)) throw new MachinesFailure('host_key_unconfirmed', 'Confirm the host-key fingerprint first.')
    const savedMachine = this.d.machines.find(machine => machine.id === m.id)
    const key = m.host && savedMachine?.activeRoute !== 'bridge' ? await this.scan(m.host, m.port ?? 22) : await this.scan(m.alias, m.bridgePort!, m)
    if (fingerprint(key) !== accepted) throw new MachinesFailure('host_key_changed', 'The host key changed after it was shown. Check it again through a trusted channel.')
    const old = await privateRead(this.knownHosts) ?? ''
    const pin = this.pinName(m)
    const lines = old.split('\n').filter(line => line && line.split(/\s+/)[0] !== pin)
    lines.push(`${pin} ${key.split(/\s+/).slice(1, 3).join(' ')}`)
    await privateWrite(this.knownHosts, lines.join('\n') + '\n')
    const saved = savedMachine
    if (saved) saved.hostKeyPinnedAt = Date.now()
  }
  async execute(m: Machine, command: string, input?: string, management = true): Promise<CommandResult> {
    return this.run('ssh', ['-F', this.controlConfig, management ? `drover-management-${m.id}` : m.alias, command], { input, env: this.env(), timeoutMs: command.endsWith('/bin/bash -s') ? 300_000 : 30_000 })
  }
  private requireSuccess(result: CommandResult, password = false): void {
    if (result.code) { const reason = sshError(result.stderr, password); throw new MachinesFailure(reason.code, reason.detail!) }
  }
  private recordSessions(m: Machine, reason: SessionCleanupReason, result: SessionCleanupResult): SessionCleanupResult {
    m.sessionCleanup = { account: m.kind === 'bridged' ? 'dedicated' : 'supplied', last: { ...result, at: Date.now(), reason } }
    return result
  }
  private async updateRemoteKey(m: Machine, agents: string, management: string, options: { permissions?: MachinePermissions; remove?: boolean; removeManagement?: boolean; sessionReason?: SessionCleanupReason } = {}): Promise<SessionCleanupResult | undefined> {
    const routes = orderedRoutes(m)
    const users = [...new Set(routes.map(r => r.user ?? m.user))]
    if (users.length < 2 && (!options.remove || routes.length < 2) && !this.d.keyRemovalProgress?.[m.id]?.length) return this.updateRouteKey(m, agents, management, options)
    const activeRoute = m.activeRoute, fallback = m.fallback, previousRoute = m.route
    let total: SessionCleanupResult | undefined
    let failure: unknown
    let progress: NonNullable<StoredMachines['keyRemovalProgress']>[string][number] | undefined
    if (options.remove) {
      this.d.keyRemovalProgress ??= {}
      const entries = this.d.keyRemovalProgress[m.id] ??= []
      progress = entries.find(entry => entry.publicKey === agents && entry.removeManagement === !!options.removeManagement)
      if (!progress) { progress = { publicKey: agents, removeManagement: !!options.removeManagement, completedLogins: [] }; entries.push(progress) }
      total = progress.sessions
      await this.store.save(this.d)
    }
    try {
      // Installer and supplied-login routes may authorize different accounts
      // on the same host. Retire/update the key in each account before claiming
      // completion; an unreachable login retains the durable pending removal.
      for (const user of users) {
        if (progress?.completedLogins.includes(user)) continue
        const skip = new Set(routes.filter(r => (r.user ?? m.user) !== user).map(r => r.kind))
        try {
          for (;;) {
            await this.selectRoute(m, skip)
            try {
              const result = await this.updateRouteKey(m, agents, management, options)
              if (result) total = { terminated: (total?.terminated ?? 0) + result.terminated, incomplete: !!total?.incomplete || result.incomplete, error: result.error ?? total?.error }
              if (progress) { progress.completedLogins.push(user); progress.sessions = total; await this.store.save(this.d) }
              break
            } catch (error) {
              if (!options.remove || !m.activeRoute || !['timeout', 'host_unreachable', 'tunnel_down', 'bridge_down', 'auth_failed', 'refused'].includes(sshError(error).code)) throw error
              skip.add(m.activeRoute)
              if (!routes.some(r => !skip.has(r.kind))) throw error
            }
          }
        } catch (error) { failure ??= error }
      }
      if (failure) {
        if (options.sessionReason) this.recordSessions(m, options.sessionReason, { terminated: total?.terminated ?? 0, incomplete: true, error: { code: 'session_cleanup_pending', detail: 'Some machine logins are unreachable; their key removal and session cleanup remain pending.' } })
        throw failure
      }
      if (progress) {
        this.d.keyRemovalProgress![m.id] = this.d.keyRemovalProgress![m.id].filter(entry => entry !== progress)
        if (!this.d.keyRemovalProgress![m.id].length) delete this.d.keyRemovalProgress![m.id]
        await this.store.save(this.d)
      }
      return total && options.sessionReason ? this.recordSessions(m, options.sessionReason, total) : total
    } finally { m.activeRoute = activeRoute; m.fallback = fallback; m.route = previousRoute; await this.render() }
  }
  private async updateRouteKey(m: Machine, agents: string, management: string, options: { permissions?: MachinePermissions; remove?: boolean; removeManagement?: boolean; sessionReason?: SessionCleanupReason } = {}): Promise<SessionCleanupResult | undefined> {
    const selected = m.routes?.find(r => r.kind === m.activeRoute)
    const dedicated = m.kind === 'bridged' && (selected?.user ?? m.user) === 'agent'
    const cleanup = options.sessionReason && dedicated ? sessionCleanupScript(m.os) : ''
    let result: CommandResult
    if (m.os === 'windows') {
      if (options.permissions?.mode === 'read-only') throw new MachinesFailure('permission_unavailable', 'Windows does not support the read-only sandbox.')
      const script = windowsKeyScript(agents, management, options.remove, options.removeManagement) + cleanup
      result = await this.execute(m, `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`)
    } else result = await this.execute(m, 'sh -s', (options.remove ? removeKeyScript(agents, management, options.removeManagement) : keyInstallScript(agents, management, options.permissions ?? m.permissions)) + cleanup)
    this.requireSuccess(result)
    if (!options.sessionReason) return
    if (!dedicated) return this.recordSessions(m, options.sessionReason, { terminated: 0, incomplete: true })
    try {
      const line = result.stdout.split('\n').find(line => line.startsWith('DROVER_SESSIONS '))
      const report = JSON.parse(line!.slice(16))
      if (!Number.isSafeInteger(report.terminated) || report.terminated < 0 || typeof report.incomplete !== 'boolean') throw Error('Invalid session cleanup')
      return this.recordSessions(m, options.sessionReason, { terminated: report.terminated, incomplete: report.incomplete, ...(report.incomplete ? { error: { code: 'session_cleanup_incomplete', detail: 'Some existing sessions may still have access. End them on the machine before relying on the new permissions.' } } : {}) })
    } catch { return this.recordSessions(m, options.sessionReason, { terminated: 0, incomplete: true, error: { code: 'session_cleanup_failed', detail: 'Existing agent sessions could not be confirmed as ended. End them on the machine.' } }) }
  }
  private async stageCredentialRemoval(m: Machine): Promise<void> {
    if (!this.d.installed.includes(m.id) && !this.d.issuedInstallers.includes(m.id) && !this.d.revocations[m.id]?.length && !this.d.credentialRemovals[m.id]) return
    const keys = await this.ensureKeys(), previous = this.d.credentialRemovals[m.id]
    this.d.credentialRemovals[m.id] = {
      agentsPublicKeys: [...new Set([...(previous?.agentsPublicKeys ?? []), ...(this.d.revocations[m.id] ?? []), keys.agents])],
      managementPublicKey: previous?.managementPublicKey ?? keys.management,
      ...((previous?.bridgeMachineId ?? m.bridgeMachineId) ? { bridgeMachineId: previous?.bridgeMachineId ?? m.bridgeMachineId } : {})
    }
    m.needsReinstall = true
    // Save before SSH: an offline target still carries both credentials after
    // its bridge is retired, including the old bridge ID for cleanup review.
    await this.store.save(this.d)
  }
  private async finishCredentialRemoval(m: Machine): Promise<SessionCleanupResult | undefined> {
    const pending = this.d.credentialRemovals[m.id]
    if (!pending) return
    if (pending.recoveryId) throw new MachinesFailure('recovery_pending', 'Run the recovery installer to remove the old keys and tunnel locally. Cleanup remains pending until its receipt arrives.')
    if (m.kind === 'direct' && m.bridgeSetup?.state === 'ready') throw new MachinesFailure('bridge_cleanup_pending', 'Retire this bridge before removing its management credential.')
    let sessions: SessionCleanupResult | undefined
    for (const [index, key] of pending.agentsPublicKeys.entries()) {
      const last = index === pending.agentsPublicKeys.length - 1
      sessions = await this.updateRemoteKey(m, key, pending.managementPublicKey, { remove: true, removeManagement: last, ...(last ? { sessionReason: 'remove' } : {}) }) ?? sessions
    }
    delete this.d.credentialRemovals[m.id]
    delete this.d.revocations[m.id]
    delete this.d.keyRemovalProgress?.[m.id]
    this.d.installed = this.d.installed.filter(id => id !== m.id)
    this.d.issuedInstallers = this.d.issuedInstallers.filter(id => id !== m.id)
    await this.store.save(this.d)
    return sessions
  }
  async installKey(id: string, options: MachineKeyInstallOptions): Promise<Machine> {
    await this.serial(() => { if (this.d.bridgeConnections?.[id]) throw new MachinesFailure('bridge_repair_required', 'Bridge credentials are preserved. Use bridge verification to reconnect.'); return this.installKeyInternal(id, options) })
    await this.serial(() => this.syncHerdrInternal([id]))
    return this.serial(async () => this.clone(this.machine(id)))
  }
  private async installBridgeAdminKey(m: Machine, password?: string): Promise<void> {
    const management = await this.generateKey('management_ed25519'), connection = this.d.bridgeConnections![m.id]
    await this.render()
    const script = adminKeyInstallScript(management)
    const result = password !== undefined
      ? await this.passwordKeyInstall(m, script, password)
      : await this.execute(m, 'sh -s', script)
    this.requireSuccess(result, password !== undefined)
    const oldAdmin = connection.adminKeyPath
    connection.adminManaged = true
    if (!this.d.installed.includes(m.id)) this.d.installed.push(m.id)
    connection.adminKeyPath = this.keyPath('management_ed25519')
    await this.changed()
    try { this.requireSuccess(await this.execute(m, 'true')) }
    catch (error) { connection.adminKeyPath = oldAdmin; await this.changed(); throw error }
    m.needsReinstall = false
    await this.changed()
  }
  private async passwordKeyInstall(m: Machine, script: string, password: string): Promise<CommandResult> {
    return withAskpass(password, this.root, this.options.runtime ?? process.execPath, env => this.run('ssh', ['-F', this.controlConfig, '-o', 'BatchMode=no', '-o', 'NumberOfPasswordPrompts=1', '-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'PubkeyAuthentication=no', '-o', 'PasswordAuthentication=yes', '-o', 'KbdInteractiveAuthentication=yes', `drover-management-${m.id}`, 'sh -s'], { input: script, env: { ...this.env(), ...env }, timeoutMs: 30_000 }))
  }
  private async installKeyInternal(id: string, options: MachineKeyInstallOptions): Promise<Machine> {
      if (options?.keyPath !== undefined && options.password !== undefined) throw new MachinesFailure('invalid_options', 'Choose a login key or a password.')
      const m = this.machine(id), keys = await this.ensureKeys()
      await this.pin(m, options?.acceptedFingerprint)
      await this.render()
      // Never reinstall credentials while a full removal is still pending.
      await this.finishCredentialRemoval(m)
      if (m.kind === 'direct' || m.host) {
        const script = keyInstallScript(keys.agents, keys.management, m.permissions)
        let result: CommandResult
        if (options.keyPath !== undefined) {
          const key = bridgeKeyPath(options.keyPath, this.options.home)
          if (!key || !await keyExists(key) || !m.host) throw new MachinesFailure('login_key_unreadable', 'Choose a readable login key from this computer.')
          result = await this.run('ssh', [...this.directSshArgs(m.host, m.port ?? 22, m.user, this.knownHosts, this.pinName(m)), '-i', key, '-o', 'PreferredAuthentications=publickey', m.host, 'sh -s'], { input: script, env: this.env(), timeoutMs: 30_000 })
          this.requireSuccess(result)
        } else if (options.password !== undefined) {
          result = await this.passwordKeyInstall(m, script, options.password)
          this.requireSuccess(result, true)
        } else {
          // The supplied SSH user may already accept a dedicated management key.
          result = await this.execute(m, 'sh -s', script)
          if (result.code && !this.d.installed.includes(m.id)) result = await this.execute(m, 'sh -s', script, false)
          this.requireSuccess(result)
        }
        if (!this.d.installed.includes(m.id)) this.d.installed.push(m.id)
        m.needsReinstall = false
        await this.changed()
      }
      const checked = await this.checkInternal(m)
      if (m.kind === 'bridged' && checked.status.checks?.auth) { if (!this.d.installed.includes(m.id)) this.d.installed.push(m.id); m.needsReinstall = false; await this.changed() }
      return this.clone(m)
  }
  async check(id: string): Promise<Machine> { return this.serial(async () => { await this.bridgeCleanup.runOnce(); return this.checkInternal(this.machine(id)) }) }
  private async selectRoute(m: Machine, skip = new Set<MachineRouteKind>()): Promise<number> {
    const routes = orderedRoutes(m)
    let last: unknown = new MachinesFailure('no_route', 'No connection route is available.')
    for (const route of routes) {
      if (skip.has(route.kind)) continue
      const wasSetup = route.state === 'setup'
      route.state = 'checking'; route.checkedAt = Date.now(); delete route.error
      try {
        let latency: number
        if (route.kind !== 'bridge') {
          if (!route.host) throw new MachinesFailure('lan_install_pending', 'Run the home network installer to discover this machine.')
          latency = await this.tcp(route.host, route.port ?? 22, route.kind === 'lan' ? 800 : 3000)
        }
        else {
          const bridge = this.d.machines.find(b => b.id === (route.bridgeMachineId ?? m.bridgeMachineId))
          if (!bridge || bridge.bridgeSetup?.state !== 'ready') throw new MachinesFailure('no_bridge', 'Set up the selected bridge first.')
          try { await this.tcp(bridge.host!, bridge.port ?? 22, 3000) } catch { throw new MachinesFailure('bridge_down', 'The bridge is unreachable.') }
          const started = performance.now()
          await this.scan(m.alias, route.port ?? m.bridgePort!, { ...m, kind: 'bridged', bridgeMachineId: bridge.id })
          latency = Math.round(performance.now() - started)
        }
        route.state = 'ok'; route.latencyMs = latency; m.activeRoute = route.kind; m.route = route.kind === 'internet' ? 'direct' : route.kind
        m.fallback = route !== routes[0]
        await this.render()
        return latency
      } catch (error) { last = error; route.state = wasSetup ? 'setup' : 'down'; route.error = sshError(error); delete route.latencyMs }
    }
    delete m.activeRoute; m.fallback = false
    throw last
  }
  private async checkInternal(m: Machine): Promise<Machine> {
    if (m.enabled === false || m.origin === 'herdr' && !this.d.installed.includes(m.id)) return this.clone(m)
    m.status = { ...m.status, state: 'checking', error: undefined }
    this.options.changed?.(await this.result())
    let tcp = false, auth = false, latencyMs: number | undefined
    try {
      if (!m.host && !m.bridgeMachineId) throw new MachinesFailure(this.d.credentialRemovals[m.id] ? 'no_bridge' : 'lan_install_pending', 'Run the installer on this local network, or set up a bridge.')
      latencyMs = await this.selectRoute(m)
      tcp = true
      const active = m.routes?.find(r => r.kind === m.activeRoute)
      const pin = m.kind === 'direct' && active?.host ? `[${active.host}]:${active.port ?? 22}` : this.pinName(m)
      if (!(await privateRead(this.knownHosts) ?? '').split('\n').some(line => line.split(/\s+/)[0] === pin)) throw new MachinesFailure('host_key_unconfirmed', 'The SSH port is reachable. Confirm this machine’s host-key fingerprint before signing in.')
      const pending = this.d.revocations[m.id] ?? []
      if (this.d.credentialRemovals[m.id]) await this.finishCredentialRemoval(m)
      else if (pending.length) {
        const keys = await this.ensureKeys()
        for (const key of pending) { await this.updateRemoteKey(m, key, keys.management, { remove: true, sessionReason: 'revoke' }); if (m.bridgeSetup?.state === 'ready' && (!this.d.bridgeConnections?.[m.id] || this.d.bridgeConnections[m.id].managed)) await this.provisioner.revokeBridgeKey?.(m, key) }
        delete this.d.revocations[m.id]
        await this.changed()
      }
      if (m.needsReinstall) throw new MachinesFailure('needs_reinstall', 'Install the updated key or tunnel before reconnecting.')
      let result: CommandResult
      const tried = new Set<MachineRouteKind>()
      for (;;) {
        try {
          result = await this.execute(m, m.os === 'windows' ? `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(WINDOWS_METRICS, 'utf16le').toString('base64')}` : `sh -c ${quote(METRICS)}`, undefined, this.infrastructureBridge(m))
          this.requireSuccess(result); break
        } catch (error) {
          if (!['timeout', 'host_unreachable', 'tunnel_down', 'bridge_down'].includes(sshError(error).code) || !m.activeRoute) throw error
          const route = m.routes!.find(r => r.kind === m.activeRoute)!
          route.state = 'down'; route.error = sshError(error); tried.add(route.kind)
          latencyMs = await this.selectRoute(m, tried)
        }
      }
      auth = true
      const values = Object.fromEntries(result.stdout.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1).trim()] }))
      const numeric = (key: string) => { const n = Number(values[key]); return values[key] !== undefined && Number.isFinite(n) && n >= 0 ? n : undefined }
      m.os = /Linux/i.test(values.os) ? 'linux' : /Darwin/i.test(values.os) ? 'macos' : /Windows/i.test(values.os) ? 'windows' : m.os
      m.osLabel = (values.label || values.os || 'Unknown OS').slice(0, 200)
      if (m.kind === 'bridged' && m.activeRoute === 'bridge') {
        const lan = values.lan?.split(/\s+/).find(host => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host))
        if (lan) {
          validHost(lan)
          const route = m.routes!.find(r => r.kind === 'lan')
          if (route && !route.host) { Object.assign(route, { host: lan, port: 22, user: 'agent', address: `${lan}:22`, state: 'unknown' }); if (!m.host) { m.host = lan; m.port = 22 } }
        }
      }
      m.status = { state: 'online', checkedAt: Date.now(), latencyMs, checks: { tcp, auth, diskAvailableBytes: numeric('disk'), memoryTotalBytes: numeric('memoryTotal'), memoryAvailableBytes: numeric('memoryAvailable'), docker: values.docker === '1', herdr: values.herdr === '1' } }
    } catch (error) { m.status = { state: m.kind === 'bridged' && !tcp ? 'waiting' : 'offline', checkedAt: Date.now(), latencyMs, checks: { tcp, auth }, error: sshError(error) } }
    await this.changed()
    return this.clone(m)
  }
  async setPermissions(id: string, permissions: MachinePermissions): Promise<void> {
    return this.serial(async () => {
      validatePermissions(permissions)
      const m = this.machine(id), old = structuredClone(m.permissions)
      if (this.d.bridgeConnections?.[id]) throw new MachinesFailure('bridge_repair_required', 'Existing bridge credentials are preserved. Permission changes need a dedicated bridge repair.')
      await this.finishCredentialRemoval(m)
      if (permissions.mode === 'read-only' && m.os && m.os !== 'linux') throw new MachinesFailure('permission_unavailable', 'Read-only access requires Linux with a working bubblewrap sandbox.')
      if (m.kind === 'bridged' && this.d.issuedInstallers.includes(id)) {
        const b = this.d.machines.find(b => b.id === m.bridgeMachineId) ?? null
        await this.provisioner.revokeInstallers?.(b)
        this.installerAttempts.clear()
      }
      if (this.d.installed.includes(m.id) || this.d.issuedInstallers.includes(m.id)) {
        const keys = await this.ensureKeys()
        await this.updateRemoteKey(m, keys.agents, keys.management, { permissions, ...(permissions.mode !== old.mode || JSON.stringify(permissions.projects) !== JSON.stringify(old.projects) ? { sessionReason: 'permissions' } : {}) })
      }
      m.permissions = structuredClone(permissions)
      try { await this.changed() } catch (error) { m.permissions = old; throw error }
    })
  }
  async remove(id: string, options: MachineConfirmationOptions): Promise<SessionCleanupResult> {
    this.requireConfirmation(options)
    return this.serial(async () => {
      const m = this.machine(id)
      if (this.d.bridgeConnections?.[id]) {
        // Managed retirement removes only Drover grants; the legacy phone tunnel stays live.
        const connection = this.d.bridgeConnections[id]
        const targets = this.d.machines.filter(x => x.bridgeMachineId === id)
        if (connection.managed) {
          await this.provisioner.revokeInstallers?.(m)
          for (const target of targets) { await this.stageCredentialRemoval(target); try { await this.finishCredentialRemoval(target) } catch { target.needsReinstall = true } }
          if (!this.provisioner.retireBridge) throw new MachinesFailure('cleanup_unavailable', 'Managed bridge credential retirement is unavailable.')
          await this.provisioner.retireBridge(m)
          await this.bridgeCleanup.cancel(id)
        } else if (targets.length) throw new MachinesFailure('bridge_repair_required', 'Detach dependent machines before forgetting this existing bridge.')
        if (connection.managed || connection.adminManaged) {
          const keys = await this.ensureKeys()
          await this.updateRemoteKey(m, keys.agents, keys.management, { remove: true, removeManagement: true })
        }
        for (const target of targets) { delete target.bridgeMachineId; target.needsReinstall = true; target.status = { state: 'waiting', error: { code: 'no_bridge' } } }
        await this.removeHerdrRow(m)
        this.d.machines = this.d.machines.filter(x => x.id !== id)
        delete this.d.keyRemovalProgress?.[id]
        this.d.installed = this.d.installed.filter(x => x !== id)
        this.d.issuedInstallers = this.d.issuedInstallers.filter(x => x !== id)
        delete this.d.revocations[id]
        delete this.d.credentialRemovals[id]
        delete this.d.bridgeConnections[id]
        if (this.d.bridgeMachineId === id) this.d.bridgeMachineId = null
        await this.changed()
        return { terminated: 0, incomplete: true }
      }
      this.installerAttempts.delete(id)
      if (m.kind === 'bridged' && this.d.issuedInstallers.includes(id)) {
        if (!this.provisioner.revokeInstallers) throw new MachinesFailure('cleanup_unavailable', 'Installer revocation is unavailable. Keep this machine until its install links can be revoked.')
        // An unused capability can reinstall credentials after their removal.
        await this.provisioner.revokeInstallers(this.d.machines.find(b => b.id === m.bridgeMachineId) ?? null)
        this.installerAttempts.clear()
      }
      const targets = this.d.machines.filter(x => x.kind === 'bridged' && x.bridgeMachineId === id)
      const retiring = m.kind === 'direct' && (m.bridgeSetup?.state === 'ready' || targets.length > 0 && m.bridgeSetup?.state !== 'none')
      if (retiring && !this.provisioner.retireBridge) throw new MachinesFailure('cleanup_unavailable', 'Bridge retirement is not available. Keep this machine until its tunnel credentials can be removed.')
      if (retiring) {
        this.installerAttempts.clear()
        if (!this.provisioner.revokeInstallers) throw new MachinesFailure('cleanup_unavailable', 'Installer revocation is unavailable. Keep this bridge until its install links can be revoked.')
        await this.provisioner.revokeInstallers(m)
        await this.stageCredentialRemoval(m)
        // Durably stage every target before revoking any key or closing tunnels.
        for (const target of targets) await this.stageCredentialRemoval(target)
        for (const target of targets) {
          try { await this.finishCredentialRemoval(target) }
          catch {
            this.recordSessions(target, 'remove', { terminated: 0, incomplete: true, error: { code: 'session_cleanup_pending', detail: 'This offline machine still needs credential removal and session termination.' } })
            target.status = { state: 'offline', error: { code: 'revocation_pending', detail: 'This machine is unreachable. Agents and management key removal remains pending after bridge retirement.' } }
            await this.store.save(this.d)
          }
        }
        const ownRemoval = this.d.credentialRemovals[id]
        if (ownRemoval) for (const key of ownRemoval.agentsPublicKeys) await this.updateRemoteKey(m, key, ownRemoval.managementPublicKey, { remove: true })
        // The bridge management credential is needed by retirement itself.
        // Target credentials have already been removed or recorded as pending.
        await this.provisioner.retireBridge!(m)
        await this.bridgeCleanup.cancel(id)
        m.bridgeSetup = { ...m.bridgeSetup!, state: 'none' }
        await this.store.save(this.d)
      }
      await this.stageCredentialRemoval(m)
      const sessions = await this.finishCredentialRemoval(m) ?? m.sessionCleanup?.last ?? { terminated: 0, incomplete: m.kind === 'direct' }
      if (m.kind === 'bridged') {
        const b = this.d.machines.find(b => b.id === m.bridgeMachineId)
        if (b && this.d.agentsKey) await this.provisioner.removeTargets?.(b, [m], this.d.agentsKey.publicKey)
      }
      await this.removeHerdrRow(m)
      this.d.machines = this.d.machines.filter(m => m.id !== id)
      delete this.d.keyRemovalProgress?.[id]
      this.d.installed = this.d.installed.filter(x => x !== id)
      this.d.issuedInstallers = this.d.issuedInstallers.filter(x => x !== id)
      delete this.d.revocations[id]
      delete this.d.credentialRemovals[id]
      delete this.d.bridgeConnections?.[id]
      if (this.d.bridgeMachineId === id) this.d.bridgeMachineId = null
      for (const target of targets) {
        delete target.bridgeMachineId
        target.needsReinstall = true
        target.status = { state: 'waiting', error: { code: 'no_bridge', detail: this.d.credentialRemovals[target.id] ? 'Needs a bridge. Agents and management key removal is still pending; reconnect this machine to finish cleanup.' : 'Needs a bridge. Install a new command to restore access through a bridge or on the LAN.' } }
      }
      await this.changed()
      return { terminated: sessions.terminated, incomplete: sessions.incomplete, ...(sessions.error ? { error: sessions.error } : {}) }
    })
  }
  private async removeHerdrRow(m: Machine): Promise<void> {
    if (!m.herdrId || !this.options.herdr) return
    try { await this.options.herdr.update('remove', m.herdrId) }
    catch (error) { m.herdrSyncError = sshError(error); await this.changed(); throw new MachinesFailure('herdr_sync_failed', 'Herdr could not remove this saved machine. Retry from this row.') }
  }
  async setBridge(id: string, options: MachineConfirmationOptions): Promise<void> {
    this.requireConfirmation(options)
    return this.serial(async () => {
      const next = this.machine(id), previous = this.bridge()
      if (this.d.bridgeConnections?.[id] && !this.d.bridgeConnections[id].managed || previous && this.d.bridgeConnections?.[previous.id] && !this.d.bridgeConnections[previous.id].managed) throw new MachinesFailure('bridge_repair_required', 'Confirm bridge repair before switching home machines.')
      if (next.kind !== 'direct' || !next.publicIp) throw new MachinesFailure('no_public_ip', 'A bridge needs a public IP. Private-address machines are LAN-only.')
      if (next.bridgeSetup?.state !== 'ready') throw new MachinesFailure('bridge_not_ready', 'Set up this server as a bridge before selecting it.')
      if (previous?.id === next.id) return
      const targets = this.d.machines.filter(m => m.kind === 'bridged')
      if (this.d.bridgeConnections?.[id] && targets.some(t => [2222, 2223, 2224, 8780, 8791, ...this.d.bridgeConnections![id].forwards.map(f => f.listenPort)].includes(t.bridgePort!))) throw new MachinesFailure('bridge_port_conflict', 'A machine uses a reserved legacy port. Reinstall it on a separate port before switching to this bridge.')
      this.installerAttempts.clear()
      // Write ahead: a crash during remote repointing must not lose the old
      // bridge cleanup job. Its active-ID guard blocks it until selection saves.
      if (previous) await this.bridgeCleanup.enqueue(previous.id, targets.map(m => m.id), this.d.agentsKey!.publicKey)
      const switched = await this.provisioner.switchBridge?.(previous, next, targets, this.d.agentsKey!.publicKey)
      this.d.bridgeMachineId = id
      for (const oldId of switched?.pendingOldCleanup ?? []) await this.bridgeCleanup.enqueue(oldId, targets.map(m => m.id), this.d.agentsKey!.publicKey)
      for (const target of targets) { target.bridgeMachineId = id; const route = orderedRoutes(target).find(r => r.kind === 'bridge'); if (route) { route.bridgeMachineId = id; route.state = switched?.updated.includes(target.id) ? 'unknown' : 'setup' }; target.needsReinstall = !!this.d.credentialRemovals[target.id] || !switched?.updated.includes(target.id); target.status = { state: 'waiting', ...(target.needsReinstall ? { error: { code: 'needs_reinstall', detail: 'Reinstall the tunnel command to connect this machine to the selected bridge.' } } : {}) } }
      await this.changed()
      await this.bridgeCleanup.runOnce()
      this.options.changed?.(await this.result())
    })
  }
  async setupBridge(id: string, options: MachineConfirmationOptions & { caddy: boolean }): Promise<void> {
    this.requireConfirmation(options)
    return this.serial(async () => {
      if (this.d.bridgeConnections?.[id]) throw new MachinesFailure('bridge_repair_required', 'Verify this existing Mac bridge and apply only the reported repair steps.')
      const m = this.machine(id)
      if (m.kind !== 'direct' || !m.publicIp) throw new MachinesFailure('no_public_ip', 'A bridge needs a public IP. Without one, access is LAN-only.')
      if (!options || typeof options.caddy !== 'boolean') throw new MachinesFailure('invalid_options', 'Choose whether to configure the phone website.')
      const keys = await this.ensureKeys()
      m.bridgeSetup = { state: 'running', step: 'connect', caddy: options.caddy }
      await this.changed()
      try {
        await this.provisioner.setupBridge(m, this.d.machines.filter(x => x.kind === 'bridged'), keys.agents, options, async step => { m.bridgeSetup = { ...m.bridgeSetup!, step }; await this.changed() })
        m.bridgeSetup = { state: 'ready', step: options.caddy ? 'phone_tunnel_required' : 'complete', checkedAt: Date.now(), caddy: options.caddy }
      } catch (error) { m.bridgeSetup = { state: 'failed', checkedAt: Date.now(), error: sshError(error), caddy: options.caddy }; await this.changed(); throw error }
      await this.changed()
    })
  }
  async installCommand(id: string, os: MachineOs): Promise<InstallCommand> {
    return this.serial(async () => {
      const m = this.machine(id), b = orderedRoutes(m).some(r => r.kind === 'bridge') ? this.bridge() : null
      if (m.kind !== 'bridged' && !orderedRoutes(m).some(r => r.kind === 'bridge') || !['linux', 'macos', 'windows'].includes(os)) throw new MachinesFailure('unsupported_os', 'Install commands are for home machines running Linux, macOS or Windows.')
      if (m.kind !== 'bridged') { m.kind = 'bridged'; await this.migrateRoutePin(m) }
      if (b && b.bridgeSetup?.state !== 'ready') throw new MachinesFailure('bridge_not_ready', 'Set up the selected bridge before installing home machines.')
      if (m.permissions.mode === 'read-only' && os !== 'linux') throw new MachinesFailure('permission_unavailable', 'Read-only access requires Linux with a working bubblewrap sandbox.')
      // The former bridge route may no longer exist. A recovery installer
      // removes old credentials and the local tunnel on the target itself.
      const pending = this.d.credentialRemovals[id]
      if (pending?.recoveryId) {
        if (!this.provisioner.revokeInstallers) throw new MachinesFailure('cleanup_unavailable', 'Revoke the previous recovery installer before generating a replacement.')
        await this.provisioner.revokeInstallers(b)
        this.installerAttempts.clear()
      }
      const recoveryCleanup = pending ? {
        id: randomUUID(),
        agentsPublicKeys: [...new Set([...pending.agentsPublicKeys, ...(this.d.revocations[id] ?? [])])],
        managementPublicKey: pending.managementPublicKey
      } : undefined
      const keys = await this.ensureKeys()
      let tunnelPublicKey: string | undefined, tunnelPrivateKey: string | undefined, bridgeHostKey: string | undefined
      if (b) {
        tunnelPublicKey = await this.generateKey('tunnel-' + m.id)
        tunnelPrivateKey = (await privateRead(this.keyPath('tunnel-' + m.id)))!
        const line = (await privateRead(this.knownHosts) ?? '').split('\n').find(line => line.split(/\s+/)[0] === this.pinName(b))
        if (!line) throw new MachinesFailure('host_key_unconfirmed', 'Confirm the bridge SSH host key first.')
        bridgeHostKey = line.split(/\s+/).slice(1, 3).join(' ')
        m.bridgeMachineId = b.id
      } else delete m.bridgeMachineId
      m.os = os
      const bridgeRoute = m.routes?.find(r => r.kind === 'bridge')
      if (bridgeRoute) { bridgeRoute.bridgeMachineId = b?.id; bridgeRoute.port = m.bridgePort; bridgeRoute.state = 'setup' }
      const expiresAt = Date.now() + 2 * 60 * 60_000
      const attempt = Symbol(id)
      this.installerAttempts.set(id, attempt)
      if (!this.d.issuedInstallers.includes(id)) this.d.issuedInstallers.push(id)
      if (pending && recoveryCleanup) {
        pending.agentsPublicKeys = recoveryCleanup.agentsPublicKeys
        pending.recoveryId = recoveryCleanup.id
      }
      // Track before publishing a remote capability; remote installation may
      // finish even if this local operation's final store update fails.
      await this.store.save(this.d)
      const command = await this.provisioner.installCommand({ machine: this.clone(m), bridge: b ? this.clone(b) : null, agentsPublicKey: keys.agents, managementPublicKey: keys.management, bridgeHostKey, tunnelPrivateKey, tunnelPublicKey, expiresAt, lanHost: this.options.lanHost, recoveryCleanup, onReport: report => this.installerReport(id, attempt, keys.agents, os, b?.id, report, recoveryCleanup?.id) }, os)
      // The generated command now points to the active bridge; status still waits
      // for an actual tunnel, then host-key confirmation and successful auth.
      m.needsReinstall = !!recoveryCleanup
      if (recoveryCleanup) m.status = { state: 'waiting', error: { code: 'recovery_pending', detail: 'Run this recovery installer. Old agents and management keys and the old local tunnel must be removed before access is restored.' } }
      await this.changed()
      return { command, expiresAt }
    })
  }
  private async installerReport(id: string, attempt: symbol, agentsKey: string, os: MachineOs, bridgeId: string | undefined, report: InstallerReport, recoveryId?: string): Promise<void> {
    if (this.disposed) return
    await this.serial(async () => {
      const m = this.d.machines.find(m => m.id === id)
      if (!m || this.installerAttempts.get(id) !== attempt || this.d.agentsKey?.publicKey !== agentsKey || m.bridgeMachineId !== bridgeId) return
      if (!report || report.machineId !== id || report.os !== os || report.state !== 'installed') throw new MachinesFailure('invalid_report', 'Installer report did not match this machine.')
      const pending = this.d.credentialRemovals[id]
      if (report.cleanupId !== recoveryId || (recoveryId ? pending?.recoveryId !== recoveryId : pending)) throw new MachinesFailure('invalid_report', 'Recovery cleanup was not acknowledged by this installer.')
      const reportedFingerprint = fingerprint(report.hostKey)
      if (!bridgeId) {
        // Only the LAN listener supplies this address from its socket peer.
        validHost(report.lanHost)
        if (!/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(report.lanHost)) throw new MachinesFailure('invalid_report', 'Installer must report from the same private local network.')
        m.host = report.lanHost
        m.port = 22
        m.routes = orderedRoutes(m).filter(r => r.kind !== 'lan' && r.kind !== 'bridge')
        m.routes.push({ kind: 'lan', host: m.host, port: 22, user: 'agent', address: `${m.host}:22`, state: 'unknown' })
      }
      m.installReport = { reportedAt: Date.now(), fingerprint: reportedFingerprint }
      const route = m.routes?.find(r => r.kind === 'bridge')
      if (route && bridgeId) { route.bridgeMachineId = bridgeId; route.port = m.bridgePort; route.user = 'agent'; route.state = 'unknown' }
      if (recoveryId) {
        delete this.d.credentialRemovals[id]
        delete this.d.revocations[id]
        delete this.d.keyRemovalProgress?.[id]
      }
      if (!this.d.installed.includes(id)) this.d.installed.push(id)
      m.needsReinstall = false
      await this.changed()
      // Receipt confirms installer completion, never host trust or SSH auth.
      // checkInternal only authenticates against an explicitly pinned key.
      await this.checkInternal(m)
      this.installerAttempts.delete(id)
    })
  }
  async revokeAgentsKey(options: MachineConfirmationOptions): Promise<SessionCleanupReport[]> {
    this.requireConfirmation(options)
    return this.serial(async () => {
      if (!this.d.agentsKey) return []
      const old = this.d.agentsKey.publicKey
      this.installerAttempts.clear()
      await this.provisioner.revokeInstallers?.(null)
      const revokeIds = new Set([...this.d.installed, ...this.d.issuedInstallers, ...this.d.machines.filter(m => m.bridgeSetup?.state === 'ready').map(m => m.id)])
      for (const id of revokeIds) this.d.revocations[id] = [...new Set([...(this.d.revocations[id] ?? []), old])]
      // Record remote cleanup BEFORE destroying the local key; restart retries it.
      await this.store.save(this.d)
      const replacement = 'agents-next-' + randomUUID()
      const next = await this.generateKey(replacement)
      const privateKey = (await privateRead(this.keyPath(replacement)))!
      await privateWrite(this.keyPath(), privateKey)
      await privateWrite(this.keyPath() + '.pub', next + '\n')
      await unlink(this.keyPath(replacement)); await unlink(this.keyPath(replacement) + '.pub')
      this.d.agentsKey = { publicKey: next, fingerprint: fingerprint(next), createdAt: Date.now() }
      for (const m of this.d.machines) {
        m.needsReinstall = true
        m.status = { state: 'offline', error: { code: 'key_not_installed', detail: 'The agents key was revoked. Install the new key to restore access.' } }
        for (const key of this.d.revocations[m.id] ?? []) {
          try {
            const management = await this.generateKey('management_ed25519')
            await this.updateRemoteKey(m, key, management, { remove: true, sessionReason: 'revoke' })
            if (m.bridgeSetup?.state === 'ready' && (!this.d.bridgeConnections?.[m.id] || this.d.bridgeConnections[m.id].managed)) await this.provisioner.revokeBridgeKey?.(m, key)
            if (this.d.bridgeConnections?.[m.id]) { m.needsReinstall = false; m.status = { state: 'online', checkedAt: Date.now(), checks: { tcp: true, auth: true } } }
            this.d.revocations[m.id] = this.d.revocations[m.id].filter(x => x !== key)
        } catch { m.status.error = { code: 'revocation_pending', detail: 'The local key was regenerated. This offline machine still needs old-key removal; keep its record and reconnect to finish revocation.' }; this.recordSessions(m, 'revoke', { terminated: m.sessionCleanup?.last?.reason === 'revoke' ? m.sessionCleanup.last.terminated : 0, incomplete: true, error: { code: 'session_cleanup_pending', detail: 'This offline machine still needs old-key removal and session termination.' } }) }
        }
      }
      await this.changed()
      return this.d.machines.filter(m => revokeIds.has(m.id)).map(m => ({ machineId: m.id, name: m.name, terminated: m.sessionCleanup?.last?.terminated ?? 0, incomplete: m.sessionCleanup?.last?.incomplete ?? true, ...(m.sessionCleanup?.last?.error ? { error: m.sessionCleanup.last.error } : {}) }))
    })
  }
  async addSshInclude(): Promise<void> {
    return this.serial(async () => {
      if (!this.options.confirmInclude || !await this.options.confirmInclude()) throw new MachinesFailure('cancelled', 'SSH Include was not installed.')
      const directory = join(this.options.home, '.ssh'), file = join(directory, 'config')
      await privateDirectory(directory)
      let current = ''
      try {
        const stat = await lstat(file)
        if (stat.isSymbolicLink() || !stat.isFile()) throw new MachinesFailure('unsafe_path', 'Refusing to modify an SSH configuration symlink.')
        current = await readFile(file, 'utf8')
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const lines = current.split(/\r?\n/)
      // Recognize quoted/unquoted exact Include; unrelated Includes are retained.
      const match = (line: string) => /^\s*Include\s+/i.test(line) && [this.includeLine().toLowerCase(), `Include ${this.configPath}`.toLowerCase()].includes(line.trim().toLowerCase())
      const next = this.includeLine() + '\n' + lines.filter(line => !match(line)).join('\n')
      if (next !== current) { await privateWrite(file + '.drover-backup-' + Date.now(), current); await privateWrite(file, next) }
      await privateWrite(join(this.root, 'include-installed'), this.includeLine())
      this.options.changed?.(await this.result())
    })
  }
  async agentInstructions(cwd: string): Promise<string | null> {
    return this.serial(async () => {
      if (!this.d.machines.length) return null
      if (!this.projects.has(cwd)) { this.projects.add(cwd); await privateWrite(join(this.root, 'projects.json'), JSON.stringify([...this.projects])) }
      return this.projectGuide(cwd)
    })
  }
  private async projectGuide(cwd: string): Promise<string> {
      return projectMachineInstructions(this.root, this.agentMachines(), cwd, async visible => {
        let text = await privateRead(this.configPath) ?? ''
        for (const m of visible.filter(m => m.permissions.mode === 'projects' && !m.needsReinstall)) {
          text += this.routeBlock(m)
        }
        return text
      })
  }
  private startPeriodic(): void {
    if (this.timer || this.disposed) return
    this.timer = setInterval(() => {
      // One scan at a time; a slow SSH operation cannot build a polling backlog.
      if (!this.d.machines.length || this.polling) return
      this.polling = true
      void this.serial(async () => { await this.bridgeCleanup.runOnce(); for (const m of this.d.machines) await this.checkInternal(m) }).catch(() => undefined).finally(() => { this.polling = false })
    }, this.options.periodMs ?? 60_000)
    this.timer.unref()
  }
  dispose(): void { this.disposed = true; if (this.timer) clearInterval(this.timer); if (this.herdrPoll) clearTimeout(this.herdrPoll); this.timer = null; this.herdrPoll = null; void this.provisioner.dispose?.() }
}
