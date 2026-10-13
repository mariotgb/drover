import { randomUUID } from 'node:crypto'
import { lstat, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { HostKey, InstallCommand, Machine, MachineDraft, MachineOs, MachinePermissions, MachinesState, MachinesStatus, SessionCleanupReason, SessionCleanupReport, SessionCleanupResult } from '@shared/machines'
import { MachinesStore, publicAddress, validHost, validPort, validateDraft, validatePermissions, type StoredMachines } from './store'
import { fingerprint, MachinesFailure, privateDirectory, privateRead, privateWrite, quote, runCommand, sshError, tcpProbe, withAskpass, type CommandResult, type CommandRunner } from './ssh'
import { keyInstallScript, removeKeyScript, windowsKeyScript } from './permissions'
import { projectMachineInstructions, writeAwareness } from './awareness'
import { createMachineProvisioner, type BridgeTarget, type InstallContext, type InstallerReport } from './provision'
import { BridgeCleanupQueue } from './cleanup'
import { sessionCleanupScript } from './sessions'

export interface MachineProvisioner {
  setupBridge(machine: Machine, targets: Machine[], agentsPublicKey: string, options: { caddy: boolean }, onStep: (step: string) => Promise<void>): Promise<void>
  installCommand(context: InstallContext, os: MachineOs): Promise<string>
  switchBridge?(previous: Machine | null, next: Machine, targets: Machine[], agentsPublicKey: string): Promise<{ updated: string[]; needsReinstall: string[]; pendingOldCleanup?: string[] }>
  revokeBridgeKey?(bridge: Machine, publicKey: string): Promise<void>
  removeTargets?(bridge: Machine, targets: Machine[], agentsPublicKey: string): Promise<void>
  retireBridge?(bridge: Machine): Promise<void>
  revokeInstallers?(bridge: Machine | null): Promise<void>
  dispose?(): Promise<void>
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
}
const METRICS = `set -eu
printf 'os=%s\\n' "$(uname -s)"
if [ -r /etc/os-release ]; then . /etc/os-release; printf 'label=%s\\n' "$PRETTY_NAME"; fi
df -Pk / | awk 'NR==2 {printf "disk=%s\\n", $4 * 1024}'
if [ -r /proc/meminfo ]; then awk '/^MemTotal:/ {printf "memoryTotal=%s\\n",$2*1024} /^MemAvailable:/ {printf "memoryAvailable=%s\\n",$2*1024}' /proc/meminfo; fi
if [ "$(uname -s)" = Darwin ]; then printf 'memoryTotal=%s\\n' "$(sysctl -n hw.memsize)"; vm_stat | awk '/page size/ {page=$8} /Pages free:/ {gsub(/\\./,"",$3); printf "memoryAvailable=%s\\n",$3*page}'; fi
if command -v docker >/dev/null; then echo docker=1; else echo docker=0; fi
if command -v herdr >/dev/null; then echo herdr=1; else echo herdr=0; fi
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
        if (context.bridge) await provision.setupBridge(context.bridge, await targets(this.d.machines.filter(m => m.kind === 'bridged' && m.bridgeMachineId === context.bridge!.id)), context.agentsPublicKey, { caddy: context.bridge.bridgeSetup?.caddy ?? false })
        return provision.installCommand({ ...context, ...(context.machine.permissions.mode === 'read-only' ? { permissionSetupScript: keyInstallScript(context.agentsPublicKey, context.managementPublicKey, context.machine.permissions) } : {}) }, os)
      },
      switchBridge: async (previous, next, machines, key) => provision.switchBridge(previous, next, await targets(machines), key, { caddy: next.bridgeSetup?.caddy ?? false, bridgeHostKey: await bridgeKey(next) }),
      revokeBridgeKey: async (b, old) => { await provision.revokeJumpKey(b, old); await provision.revokeInstallers(b); await provision.setupBridge(b, await targets(this.d.machines.filter(m => m.kind === 'bridged' && m.bridgeMachineId === b.id)), this.d.agentsKey!.publicKey, { caddy: b.bridgeSetup?.caddy ?? false }) },
      removeTargets: provision.removeTargets,
      retireBridge: provision.retireBridge,
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
  private clone(m: Machine): Machine { return structuredClone(m) }
  private bridge(): Machine | null { return this.d.machines.find(m => m.id === this.d.bridgeMachineId) ?? null }
  private async result(): Promise<MachinesState> {
    // Do not chmod, read, or write the user's ~/.ssh/config in state/check paths.
    const marker = await privateRead(join(this.root, 'include-installed'))
    const machines = structuredClone(this.d.machines)
    for (const machine of machines) {
      machine.sessionCleanup ??= { account: machine.kind === 'bridged' ? 'dedicated' : 'supplied' }
      if (machine.bridgeSetup) {
        delete machine.bridgeSetup.cleanup
        const cleanup = this.bridgeCleanup.cleanupState(machine.id)
        if (cleanup) machine.bridgeSetup.cleanup = cleanup
        else if (machine.bridgeSetup.error?.code === 'bridge_cleanup_pending') delete machine.bridgeSetup.error
      }
    }
    return { machines, bridgeMachineId: this.d.bridgeMachineId, agentsKey: structuredClone(this.d.agentsKey), sshInclude: { installed: marker === this.includeLine(), line: this.includeLine(), configPath: this.configPath } }
  }
  private includeLine(): string { return `Include "${this.configPath}"` }
  async state(): Promise<MachinesState> { return this.serial(() => this.result()) }
  async status(): Promise<MachinesStatus> { const s = await this.state(); return { machines: s.machines.map(m => ({ ...m, permissions: { mode: m.permissions.mode, projects: [] } })), bridgeMachineId: s.bridgeMachineId } }
  private async changed(): Promise<void> {
    await this.store.save(this.d)
    await this.render()
    this.options.changed?.(await this.result())
  }
  private pinName(m: Machine): string { return m.kind === 'direct' ? `[${m.host}]:${m.port}` : `drover-machine-${m.id}` }
  private sshBlock(alias: string, host: string, port: number, user: string, key: string, pin: string, jump?: string): string {
    return `Host ${alias}\n  HostName ${host}\n  Port ${port}\n  User ${user}\n  IdentityFile "${key}"\n  IdentitiesOnly yes\n  IdentityAgent none\n  UserKnownHostsFile "${this.knownHosts}"\n  GlobalKnownHostsFile /dev/null\n  HostKeyAlias ${pin}\n  StrictHostKeyChecking yes\n  BatchMode yes\n  PasswordAuthentication no\n  KbdInteractiveAuthentication no\n  ForwardAgent no\n  ForwardX11 no\n  ConnectTimeout 5\n  ServerAliveInterval 30\n  ServerAliveCountMax 2\n${jump ? `  ProxyJump ${jump}\n` : ''}\n`
  }
  private async render(): Promise<void> {
    if (!this.d.machines.length && !this.d.agentsKey) return
    await privateDirectory(this.root)
    let text = '# Managed by Drover Machines. Do not put passwords here.\n\n'
    for (const m of this.d.machines) {
      if (m.kind === 'direct') {
        if (!m.needsReinstall) text += this.sshBlock(m.alias, m.host!, m.port!, m.user, this.keyPath(), this.pinName(m))
        text += this.sshBlock(`drover-management-${m.id}`, m.host!, m.port!, m.user, this.keyPath('management_ed25519'), this.pinName(m))
      } else {
        const b = this.d.machines.find(b => b.id === m.bridgeMachineId)
        if (b) {
          if (!m.needsReinstall) text += this.sshBlock(m.alias, '127.0.0.1', m.bridgePort!, m.user, this.keyPath(), this.pinName(m), `drover-jump-${b.id}`)
          text += this.sshBlock(`drover-management-${m.id}`, '127.0.0.1', m.bridgePort!, m.user, this.keyPath('management_ed25519'), this.pinName(m), `drover-management-${b.id}`)
        } else if (m.host) {
          if (!m.needsReinstall) text += this.sshBlock(m.alias, m.host, m.port ?? 22, m.user, this.keyPath(), this.pinName(m))
          text += this.sshBlock(`drover-management-${m.id}`, m.host, m.port ?? 22, m.user, this.keyPath('management_ed25519'), this.pinName(m))
        }
      }
    }
    const b = this.bridge()
    if (b) text += this.sshBlock(`drover-jump-${b.id}`, b.host!, b.port!, 'drover-jump', this.keyPath(), this.pinName(b))
    await privateWrite(this.controlConfig, text)
    const agentBlocks = text.split(/(?=^Host )/m).filter(block => {
      const alias = block.match(/^Host (\S+)/)?.[1]
      if (!alias) return true
      if (alias.startsWith('drover-management-')) return false
      const m = this.d.machines.find(m => m.alias === alias)
      return !m || m.permissions.mode !== 'projects'
    }).join('')
    await privateWrite(this.configPath, agentBlocks)
    if (await privateRead(this.knownHosts) === null) await privateWrite(this.knownHosts, '')
    await writeAwareness(this.options.home, this.root, this.d.machines)
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
    return this.serial(async () => {
      validateDraft(draft)
      if (this.d.machines.some(m => m.name === draft.name)) throw new MachinesFailure('duplicate_name', 'A machine with this name already exists.')
      await this.ensureKeys()
      const b = this.bridge()
      const taken = new Set(this.d.machines.map(m => m.bridgePort))
      let bridgePort = 2224; while (taken.has(bridgePort) || bridgePort === 8780) bridgePort++
      const m: Machine = { id: randomUUID(), name: draft.name, kind: draft.kind, alias: `drover-${draft.name}`, user: draft.kind === 'direct' ? draft.user : 'agent', publicIp: draft.kind === 'direct' && publicAddress(draft.host), permissions: { mode: 'full', projects: [] }, status: { state: draft.kind === 'direct' ? 'unknown' : 'waiting', error: { code: draft.kind === 'direct' ? 'key_not_installed' : b ? 'tunnel_down' : 'no_bridge' } }, ...(draft.kind === 'direct' ? { host: draft.host, port: draft.port } : { os: draft.os, bridgePort, ...(b ? { bridgeMachineId: b.id } : {}) }) }
      this.d.machines.push(m)
      try { await this.changed() } catch (e) { this.d.machines = this.d.machines.filter(x => x.id !== m.id); throw e }
      this.startPeriodic()
      return this.clone(m)
    })
  }
  private async scan(host: string, port: number, machine?: Machine): Promise<string> {
    let result: CommandResult
    if (machine?.kind === 'bridged') {
      const b = this.d.machines.find(b => b.id === machine.bridgeMachineId)
      if (b) result = await this.execute(b, `ssh-keyscan -T 5 -t ed25519 -p ${port} 127.0.0.1`, undefined, true)
      else if (machine.host) result = await this.run('ssh-keyscan', ['-T', '5', '-t', 'ed25519', '-p', String(machine.port ?? 22), machine.host], { timeoutMs: 10_000, env: this.env() })
      else throw new MachinesFailure('lan_install_pending', 'Run the installer on this local network. Its report will supply the machine’s LAN address; a public bridge is needed across networks.')
    } else result = await this.run('ssh-keyscan', ['-T', '5', '-t', 'ed25519', '-p', String(port), host], { timeoutMs: 10_000, env: this.env() })
    const key = result.stdout.split('\n').find(line => !line.startsWith('#') && line.split(/\s+/)[1] === 'ssh-ed25519')
    if (!key) throw new MachinesFailure(machine?.kind === 'bridged' ? 'tunnel_down' : 'host_unreachable', machine?.kind === 'bridged' ? 'The home machine has not connected its tunnel to the bridge.' : 'Could not read an SSH host key. Check the address, port and firewall.')
    fingerprint(key)
    return key.trim()
  }
  async probeHostKey(host: string, port: number): Promise<HostKey> {
    return this.serial(async () => {
      const m = this.d.machines.find(m => m.alias === host && m.kind === 'bridged')
      if (m) { if (port !== m.bridgePort && port !== m.port) throw new MachinesFailure('invalid_port', 'Use this machine’s current SSH port.') }
      else validHost(host)
      validPort(port)
      const key = await this.scan(host, port, m)
      const pin = m ? this.pinName(m) : `[${host}]:${port}`
      const known = (await privateRead(this.knownHosts) ?? '').split('\n').some(line => line.split(' ')[0] === pin && fingerprint(line) === fingerprint(key))
      return { algorithm: 'ssh-ed25519', fingerprint: fingerprint(key), known }
    })
  }
  private async pin(m: Machine, accepted: string): Promise<void> {
    if (typeof accepted !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(accepted)) throw new MachinesFailure('host_key_unconfirmed', 'Confirm the host-key fingerprint first.')
    const key = await this.scan(m.host ?? m.alias, m.kind === 'direct' ? m.port! : m.bridgePort!, m)
    if (fingerprint(key) !== accepted) throw new MachinesFailure('host_key_changed', 'The host key changed after it was shown. Check it again through a trusted channel.')
    const old = await privateRead(this.knownHosts) ?? ''
    const pin = this.pinName(m)
    const lines = old.split('\n').filter(line => line && line.split(/\s+/)[0] !== pin)
    lines.push(`${pin} ${key.split(/\s+/).slice(1, 3).join(' ')}`)
    await privateWrite(this.knownHosts, lines.join('\n') + '\n')
  }
  async execute(m: Machine, command: string, input?: string, management = true): Promise<CommandResult> {
    return this.run('ssh', ['-F', this.controlConfig, management ? `drover-management-${m.id}` : m.alias, command], { input, env: this.env(), timeoutMs: 30_000 })
  }
  private requireSuccess(result: CommandResult, password = false): void {
    if (result.code) { const reason = sshError(result.stderr, password); throw new MachinesFailure(reason.code, reason.detail!) }
  }
  private recordSessions(m: Machine, reason: SessionCleanupReason, result: SessionCleanupResult): SessionCleanupResult {
    m.sessionCleanup = { account: m.kind === 'bridged' ? 'dedicated' : 'supplied', last: { ...result, at: Date.now(), reason } }
    return result
  }
  private async updateRemoteKey(m: Machine, agents: string, management: string, options: { permissions?: MachinePermissions; remove?: boolean; removeManagement?: boolean; sessionReason?: SessionCleanupReason } = {}): Promise<SessionCleanupResult | undefined> {
    const cleanup = options.sessionReason && m.kind === 'bridged' ? sessionCleanupScript(m.os) : ''
    let result: CommandResult
    if (m.os === 'windows') {
      if (options.permissions?.mode === 'read-only') throw new MachinesFailure('permission_unavailable', 'Windows does not support the read-only sandbox.')
      const script = windowsKeyScript(agents, management, options.remove, options.removeManagement) + cleanup
      result = await this.execute(m, `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`)
    } else result = await this.execute(m, 'sh -s', (options.remove ? removeKeyScript(agents, management, options.removeManagement) : keyInstallScript(agents, management, options.permissions ?? m.permissions)) + cleanup)
    this.requireSuccess(result)
    if (!options.sessionReason) return
    if (m.kind === 'direct') return this.recordSessions(m, options.sessionReason, { terminated: 0, incomplete: true })
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
    this.d.installed = this.d.installed.filter(id => id !== m.id)
    this.d.issuedInstallers = this.d.issuedInstallers.filter(id => id !== m.id)
    await this.store.save(this.d)
    return sessions
  }
  async installKey(id: string, options: { password?: string; acceptedFingerprint: string }): Promise<Machine> {
    return this.serial(async () => {
      const m = this.machine(id), keys = await this.ensureKeys()
      await this.pin(m, options?.acceptedFingerprint)
      await this.render()
      // Never reinstall credentials while a full removal is still pending.
      await this.finishCredentialRemoval(m)
      if (m.kind === 'direct') {
        const script = keyInstallScript(keys.agents, keys.management, m.permissions)
        let result: CommandResult
        if (options.password !== undefined) {
          result = await withAskpass(options.password, this.root, this.options.runtime ?? process.execPath, env => this.run('ssh', ['-F', this.controlConfig, '-o', 'BatchMode=no', '-o', 'NumberOfPasswordPrompts=1', '-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'PubkeyAuthentication=no', '-o', 'PasswordAuthentication=yes', '-o', 'KbdInteractiveAuthentication=yes', `drover-management-${m.id}`, 'sh -s'], { input: script, env: { ...this.env(), ...env }, timeoutMs: 30_000 }))
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
    })
  }
  async check(id: string): Promise<Machine> { return this.serial(async () => { await this.bridgeCleanup.runOnce(); return this.checkInternal(this.machine(id)) }) }
  private async checkInternal(m: Machine): Promise<Machine> {
    m.status = { ...m.status, state: 'checking', error: undefined }
    this.options.changed?.(await this.result())
    let tcp = false, auth = false, latencyMs: number | undefined
    try {
      if (m.kind === 'direct') latencyMs = await this.tcp(m.host!, m.port!)
      else {
        const b = this.d.machines.find(b => b.id === m.bridgeMachineId)
        if (!b) {
          if (!m.host) throw new MachinesFailure(this.d.credentialRemovals[m.id] ? 'no_bridge' : 'lan_install_pending', this.d.credentialRemovals[m.id] ? 'Needs a bridge. Agents and management key removal remains pending until this machine is reachable.' : 'Run the installer on this local network. Its report will supply the machine’s LAN address; a public bridge is needed across networks.')
          latencyMs = await this.tcp(m.host, m.port ?? 22)
        } else {
          if (b.bridgeSetup?.state !== 'ready') throw new MachinesFailure('no_bridge', 'Set up the selected bridge before connecting home machines.')
          try { await this.tcp(b.host!, b.port!) } catch { throw new MachinesFailure('bridge_down', 'The bridge is unreachable, so the home machine cannot connect.') }
          const start = performance.now()
          await this.scan(m.alias, m.bridgePort!, m)
          latencyMs = Math.round(performance.now() - start)
        }
      }
      tcp = true
      const pin = this.pinName(m)
      if (!(await privateRead(this.knownHosts) ?? '').split('\n').some(line => line.split(/\s+/)[0] === pin)) throw new MachinesFailure('host_key_unconfirmed', 'The SSH port is reachable. Confirm this machine’s host-key fingerprint before signing in.')
      const pending = this.d.revocations[m.id] ?? []
      if (this.d.credentialRemovals[m.id]) await this.finishCredentialRemoval(m)
      else if (pending.length) {
        const keys = await this.ensureKeys()
        for (const key of pending) { await this.updateRemoteKey(m, key, keys.management, { remove: true, sessionReason: 'revoke' }); if (m.bridgeSetup?.state === 'ready') await this.provisioner.revokeBridgeKey?.(m, key) }
        delete this.d.revocations[m.id]
        await this.changed()
      }
      if (m.needsReinstall) throw new MachinesFailure('needs_reinstall', 'Install the updated key or tunnel before reconnecting.')
      const result = await this.execute(m, m.os === 'windows' ? `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(WINDOWS_METRICS, 'utf16le').toString('base64')}` : `sh -c ${quote(METRICS)}`, undefined, false)
      this.requireSuccess(result)
      auth = true
      const values = Object.fromEntries(result.stdout.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1).trim()] }))
      const numeric = (key: string) => { const n = Number(values[key]); return values[key] !== undefined && Number.isFinite(n) && n >= 0 ? n : undefined }
      m.os = /Linux/i.test(values.os) ? 'linux' : /Darwin/i.test(values.os) ? 'macos' : /Windows/i.test(values.os) ? 'windows' : m.os
      m.osLabel = (values.label || values.os || 'Unknown OS').slice(0, 200)
      m.status = { state: 'online', checkedAt: Date.now(), latencyMs, checks: { tcp, auth, diskAvailableBytes: numeric('disk'), memoryTotalBytes: numeric('memoryTotal'), memoryAvailableBytes: numeric('memoryAvailable'), docker: values.docker === '1', herdr: values.herdr === '1' } }
    } catch (error) { m.status = { state: m.kind === 'bridged' && !tcp ? 'waiting' : 'offline', checkedAt: Date.now(), latencyMs, checks: { tcp, auth }, error: sshError(error) } }
    await this.changed()
    return this.clone(m)
  }
  async setPermissions(id: string, permissions: MachinePermissions): Promise<void> {
    return this.serial(async () => {
      validatePermissions(permissions)
      const m = this.machine(id), old = structuredClone(m.permissions)
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
  async remove(id: string): Promise<SessionCleanupResult> {
    return this.serial(async () => {
      const m = this.machine(id)
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
      this.d.machines = this.d.machines.filter(m => m.id !== id)
      this.d.installed = this.d.installed.filter(x => x !== id)
      this.d.issuedInstallers = this.d.issuedInstallers.filter(x => x !== id)
      delete this.d.revocations[id]
      delete this.d.credentialRemovals[id]
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
  async setBridge(id: string): Promise<void> {
    return this.serial(async () => {
      const next = this.machine(id), previous = this.bridge()
      if (next.kind !== 'direct' || !next.publicIp) throw new MachinesFailure('no_public_ip', 'A bridge needs a public IP. Private-address machines are LAN-only.')
      if (next.bridgeSetup?.state !== 'ready') throw new MachinesFailure('bridge_not_ready', 'Set up this server as a bridge before selecting it.')
      if (previous?.id === next.id) return
      const targets = this.d.machines.filter(m => m.kind === 'bridged')
      this.installerAttempts.clear()
      // Write ahead: a crash during remote repointing must not lose the old
      // bridge cleanup job. Its active-ID guard blocks it until selection saves.
      if (previous) await this.bridgeCleanup.enqueue(previous.id, targets.map(m => m.id), this.d.agentsKey!.publicKey)
      const switched = await this.provisioner.switchBridge?.(previous, next, targets, this.d.agentsKey!.publicKey)
      this.d.bridgeMachineId = id
      for (const oldId of switched?.pendingOldCleanup ?? []) await this.bridgeCleanup.enqueue(oldId, targets.map(m => m.id), this.d.agentsKey!.publicKey)
      for (const target of targets) { target.bridgeMachineId = id; target.needsReinstall = !!this.d.credentialRemovals[target.id] || !switched?.updated.includes(target.id); target.status = { state: 'waiting', ...(target.needsReinstall ? { error: { code: 'needs_reinstall', detail: 'Reinstall the tunnel command to connect this machine to the selected bridge.' } } : {}) } }
      await this.changed()
      await this.bridgeCleanup.runOnce()
      this.options.changed?.(await this.result())
    })
  }
  async setupBridge(id: string, options: { caddy: boolean }): Promise<void> {
    return this.serial(async () => {
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
      const m = this.machine(id), b = this.bridge()
      if (m.kind !== 'bridged' || !['linux', 'macos', 'windows'].includes(os)) throw new MachinesFailure('unsupported_os', 'Install commands are for home machines running Linux, macOS or Windows.')
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
      }
      m.installReport = { reportedAt: Date.now(), fingerprint: reportedFingerprint }
      if (recoveryId) {
        delete this.d.credentialRemovals[id]
        delete this.d.revocations[id]
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
  async revokeAgentsKey(): Promise<SessionCleanupReport[]> {
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
            if (m.bridgeSetup?.state === 'ready') await this.provisioner.revokeBridgeKey?.(m, key)
            this.d.revocations[m.id] = this.d.revocations[m.id].filter(x => x !== key)
          } catch { m.status.error = { code: 'revocation_pending', detail: 'The local key was regenerated. This offline machine still needs old-key removal; keep its record and reconnect to finish revocation.' }; this.recordSessions(m, 'revoke', { terminated: 0, incomplete: true, error: { code: 'session_cleanup_pending', detail: 'This offline machine still needs old-key removal and session termination.' } }) }
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
      return projectMachineInstructions(this.root, this.d.machines, cwd, async visible => {
        let text = await privateRead(this.configPath) ?? ''
        for (const m of visible.filter(m => m.permissions.mode === 'projects' && !m.needsReinstall)) {
          const b = this.d.machines.find(b => b.id === m.bridgeMachineId)
          if (m.kind === 'direct') text += this.sshBlock(m.alias, m.host!, m.port!, m.user, this.keyPath(), this.pinName(m))
          else if (b) text += this.sshBlock(m.alias, '127.0.0.1', m.bridgePort!, m.user, this.keyPath(), this.pinName(m), `drover-jump-${b.id}`)
          else if (m.host) text += this.sshBlock(m.alias, m.host, m.port ?? 22, m.user, this.keyPath(), this.pinName(m))
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
  dispose(): void { this.disposed = true; if (this.timer) clearInterval(this.timer); this.timer = null; void this.provisioner.dispose?.() }
}
