import { randomBytes, createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { networkInterfaces } from 'node:os'
import { isIPv4 } from 'node:net'
import { gzipSync } from 'node:zlib'
import type { InstallCommand, Machine, MachineOs } from '@shared/machines'
import bridgeLib from '../../../remote/bridge/lib.sh?raw'
import hubConfig from '../../../remote/bridge/hub-config.py?raw'
import bridgeScript from '../../../remote/machines/bridge.sh?raw'
import bridgeData from '../../../remote/machines/bridge-data.py?raw'
import capabilityServer from '../../../remote/machines/capability-server.py?raw'
import unixInstaller from '../../../remote/machines/install-unix.sh?raw'
import windowsInstaller from '../../../remote/machines/install-windows.ps1?raw'
import repointScript from '../../../remote/machines/repoint.sh?raw'
import recoveryUnix from '../../../remote/machines/recovery-unix.py?raw'

export interface ProvisionResult { code: number; stdout: string; stderr: string }
export type ProvisionRun = (machine: Machine, command: string, input?: string) => Promise<ProvisionResult>
export interface BridgeTarget { machine: Machine; tunnelPublicKey: string }
export interface RecoveryCleanup { id: string; agentsPublicKeys: string[]; managementPublicKey: string }
export interface InstallerReport {
  machineId: string; os: MachineOs; hostKey: string; state: 'installed'
  /** Bound to this capability's successful local recovery, never host trust. */
  cleanupId?: string
  /** Private/loopback IPv4 observed by Drover's LAN listener, never supplied by the installer. */
  lanHost?: string
}
export interface InstallContext {
  machine: Machine
  bridge: Machine | null
  agentsPublicKey: string
  managementPublicKey: string
  recoveryCleanup?: RecoveryCleanup
  /** Full, server-enforced authorized_keys line from permissions.ts. */
  agentsAuthorizedKey?: string
  /** Installs the forced-command sandbox before installing a read-only key. */
  permissionSetupScript?: string
  bridgeHostKey?: string
  tunnelPrivateKey?: string
  tunnelPublicKey?: string
  expiresAt: number
  /** HTTPS origin served by Caddy on the chosen bridge. */
  publicOrigin?: string
  /** Advertised private LAN address; auto-detected when omitted. */
  lanHost?: string
  onReport?: (report: InstallerReport) => void | Promise<void>
}
export interface BridgeOptions { caddy: boolean; publicOrigin?: string; phonePort?: number }
export interface ProvisionOptions {
  run: ProvisionRun
  onStep?: (step: string) => void | Promise<void>
  /** Optional fixture override; production resources are bundled raw imports. */
  assetsDir?: string
}

export class ProvisionFailure extends Error {
  constructor(public code: string, message: string) { super(message) }
}
const TTL = 2 * 60 * 60 * 1000
export const MACHINES_INSTALL_PREFIX = '/machines/install/'
export const MACHINES_CAPABILITY_PORT = 8791
export const bridgeTunnelUser = (machine: Pick<Machine, 'id'>): string => `dt-${createHash('sha256').update(machine.id).digest('hex').slice(0, 16)}`
export const BRIDGE_JUMP_USER = 'drover-jump'
/** Caddy's phone route needs this separately managed desktop reverse forward. */
export function bridgePhoneForward(localRemotePort: number, bridgePort = 8780): string {
  if (!Number.isInteger(localRemotePort) || localRemotePort < 1 || localRemotePort > 65535 || !Number.isInteger(bridgePort) || bridgePort < 1024 || bridgePort > 65535) throw new ProvisionFailure('invalid_port', 'Invalid phone tunnel port.')
  return `127.0.0.1:${bridgePort}:127.0.0.1:${localRemotePort}`
}
const sh = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`
const ps = (s: string): string => `'${s.replace(/'/g, "''")}'`
const b64 = (s: string): string => Buffer.from(s).toString('base64')
const BUNDLED_ASSETS: Record<string, string> = {
  'bridge/lib.sh': bridgeLib, 'bridge/hub-config.py': hubConfig,
  'machines/bridge.sh': bridgeScript, 'machines/bridge-data.py': bridgeData,
  'machines/capability-server.py': capabilityServer, 'machines/install-unix.sh': unixInstaller,
  'machines/install-windows.ps1': windowsInstaller, 'machines/repoint.sh': repointScript,
  'machines/recovery-unix.py': recoveryUnix
}

function publicKey(s: string): string {
  const fields = s.trim().split(/\s+/)
  if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-[\w-]+)$/.test(fields[0] ?? '') || !/^[A-Za-z0-9+/]+={0,2}$/.test(fields[1] ?? '') || /[\r\n]/.test(s.trim())) throw new ProvisionFailure('invalid_key', 'Expected one OpenSSH public key.')
  const blob = Buffer.from(fields[1], 'base64')
  if (blob.length < 16 || blob.length < 4 + blob.readUInt32BE(0) || blob.subarray(4, 4 + blob.readUInt32BE(0)).toString() !== fields[0]) throw new ProvisionFailure('invalid_key', 'Invalid OpenSSH public key.')
  return `${fields[0]} ${fields[1]}`
}
function port(p: number | undefined): number {
  if (!Number.isInteger(p) || p! < 1024 || p! > 65535 || [8780, MACHINES_CAPABILITY_PORT].includes(p!)) throw new ProvisionFailure('invalid_port', 'Assign a unique bridge loopback port between 1024 and 65535.')
  return p!
}
function host(h: string | undefined): string {
  if (!h || !/^[A-Za-z0-9][A-Za-z0-9.:-]*$/.test(h)) throw new ProvisionFailure('invalid_host', 'Missing or invalid bridge address.')
  return h
}
function installerLanHost(address: string | undefined): string | undefined {
  const ipv4 = address?.replace(/^::ffff:/i, '')
  if (!ipv4 || !isIPv4(ipv4)) return undefined
  const octets = ipv4.split('.').map(Number)
  if (octets[0] === 127 || octets[0] === 10 || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)) return octets.join('.')
  return undefined
}
function origin(value: string | undefined, machine: Machine): string {
  const address = host(machine.host)
  const fallback = /^\d+\.\d+\.\d+\.\d+$/.test(address) ? `https://${address.replace(/\./g, '-')}.sslip.io` : `https://${address}`
  const url = new URL(value ?? fallback)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash || !/^[a-z0-9][a-z0-9.-]*$/i.test(url.hostname)) throw new ProvisionFailure('invalid_origin', 'Use an HTTPS hostname on port 443 for bridge installers.')
  return url.origin
}
function assertBridge(machine: Machine): void {
  if (machine.kind !== 'direct' || !machine.publicIp) throw new ProvisionFailure('no_bridge', 'A bridge needs a direct machine with a public address. Without one, installation is LAN-only.')
  host(machine.host)
}
function assigned(targets: BridgeTarget[]): object[] {
  const ports = new Set<number>(), users = new Set<string>()
  return targets.map(({ machine, tunnelPublicKey }) => {
    const p = port(machine.bridgePort), user = bridgeTunnelUser(machine)
    if (ports.has(p) || users.has(user)) throw new ProvisionFailure('duplicate_port', 'Each bridged machine needs its own tunnel account and loopback port.')
    ports.add(p); users.add(user)
    return { id: machine.id, user, port: p, publicKey: publicKey(tunnelPublicKey) }
  })
}

/** No live SSH/process access: every remote operation goes through the injected runner. */
export function createMachineProvisioner(options: ProvisionOptions) {
  const asset = (name: string): Promise<string> => options.assetsDir ? readFile(join(options.assetsDir, name), 'utf8') : Promise.resolve(BUNDLED_ASSETS[name])
  let local: ReturnType<typeof createServer> | null = null
  const capabilities = new Map<string, { expiresAt: number; script: string; credentials: object | null; receipt: string; cleanupId?: string; report?: InstallerReport; machineId: string; os: MachineOs; onReport?: InstallContext['onReport'] }>()
  let lanPort = 0
  const timers = new Set<ReturnType<typeof setTimeout>>()
  async function assets(files: string[]): Promise<Record<string, string>> {
    return Object.fromEntries(await Promise.all(files.map(async name => [name, await asset(name)])))
  }
  async function execute(machine: Machine, script: string): Promise<ProvisionResult> {
    const result = await options.run(machine, machine.user === 'root' ? '/bin/bash -s' : 'sudo -n /bin/bash -s', script)
    if (result.code !== 0) throw new ProvisionFailure('provision_failed', 'Remote provisioning failed. Check administrator sudo rights, the supported OS and the SSH policy.')
    return result
  }
  async function bridgeAction(machine: Machine, data: object): Promise<ProvisionResult> {
    const files = await assets(['bridge/lib.sh', 'bridge/hub-config.py', 'machines/bridge.sh', 'machines/bridge-data.py', 'machines/capability-server.py'])
    const bundle = gzipSync(Buffer.from(JSON.stringify(files))).toString('base64')
    return execute(machine, `set -euo pipefail\ncommand -v python3 >/dev/null || { echo 'Python 3 required' >&2; exit 1; }\nwork=$(mktemp -d)\ntrap 'rm -rf "$work"' EXIT\npython3 - "$work" <<'DROVER_ASSETS'\nimport base64,gzip,json,pathlib,sys\nr=pathlib.Path(sys.argv[1])\nfor name,text in json.loads(gzip.decompress(base64.b64decode('${bundle}'))).items():\n p=r/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text)\nDROVER_ASSETS\nprintf '%s' ${sh(b64(JSON.stringify(data)))} | base64 -d > "$work/manifest.json"\nbash "$work/machines/bridge.sh" "$work/manifest.json"\n`)
  }
  async function setupBridge(machine: Machine, targets: BridgeTarget[], agentsPublicKey: string, settings: BridgeOptions, onStep = options.onStep): Promise<void> {
    assertBridge(machine)
    const data = { action: 'setup', targets: assigned(targets), agentsPublicKey: publicKey(agentsPublicKey), origin: origin(settings.publicOrigin, machine), phone: settings.caddy, phonePort: settings.phonePort ?? 8780 }
    await onStep?.('bridge-policy')
    await bridgeAction(machine, data)
    await onStep?.(settings.caddy ? 'phone_tunnel_required' : 'bridge-ready')
  }
  function reply(res: ServerResponse, status: number, body: string, type = 'text/plain'): void {
    res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" }); res.end(body)
  }
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const match = /^\/machines\/install\/([A-Za-z0-9_-]{43})\/(script|key|report)$/.exec(req.url ?? '')
    if (!match) { reply(res, 404, 'Not found'); return }
    const cap = capabilities.get(match[1])
    if (!cap || Date.now() >= cap.expiresAt) { capabilities.delete(match[1]); reply(res, 410, 'This install link expired or was revoked. Generate a new command in Drover.'); return }
    if (req.method === 'GET' && match[2] === 'script') {
      if (!cap.credentials) reply(res, 410, 'This install link was used.'); else reply(res, 200, cap.script)
    } else if (req.method === 'GET' && match[2] === 'key') {
      if (!cap.credentials) { reply(res, 410, 'This install link was used.'); return }
      const credentials = cap.credentials; cap.credentials = null
      reply(res, 200, JSON.stringify(credentials), 'application/json')
    } else if (req.method === 'POST' && match[2] === 'report') {
      if (cap.credentials || req.headers.authorization !== `Bearer ${cap.receipt}`) { reply(res, 403, 'Forbidden'); return }
      let size = 0; const chunks: Buffer[] = []
      for await (const chunk of req) { size += chunk.length; if (size > 16384) { reply(res, 413, 'Too large'); return }; chunks.push(chunk) }
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString())
        if (payload.machineId !== cap.machineId || payload.os !== cap.os || payload.state !== 'installed') throw Error('Invalid report')
        if (payload.cleanupId !== cap.cleanupId) throw Error('Invalid recovery receipt')
        const lanHost = installerLanHost(req.socket.remoteAddress)
        if (!lanHost) throw Error('Invalid LAN peer')
        const report: InstallerReport = { machineId: cap.machineId, os: cap.os, state: 'installed', hostKey: publicKey(payload.hostKey), lanHost, ...(cap.cleanupId ? { cleanupId: cap.cleanupId } : {}) }
        cap.report = report
        await cap.onReport?.(report)
        reply(res, 200, '{}', 'application/json')
      } catch { reply(res, 400, 'Invalid report') }
    } else reply(res, 405, 'Method not allowed')
  }
  async function listen(): Promise<void> {
    if (local) return
    local = createServer((req, res) => {
      if (!installerLanHost(req.socket.remoteAddress)) { reply(res, 403, 'LAN installer only'); return }
      void handle(req, res).catch(() => { if (!res.headersSent) reply(res, 500, 'Installer unavailable'); else res.destroy() })
    })
    local.requestTimeout = 15_000; local.headersTimeout = 10_000; local.maxConnections = 16
    await new Promise<void>((ok, fail) => { local!.once('error', fail); local!.listen(0, '0.0.0.0', ok) })
    lanPort = (local.address() as { port: number }).port
    local.unref()
  }
  async function installCommand(context: InstallContext, os: MachineOs): Promise<string> {
    const { machine, bridge } = context
    if (!['linux', 'macos', 'windows'].includes(os) || machine.kind !== 'bridged') throw new ProvisionFailure('invalid_machine', 'Choose a supported bridged machine.')
    if (machine.permissions.mode === 'read-only' && (os !== 'linux' || !context.permissionSetupScript)) throw new ProvisionFailure('permission_unavailable', 'Read-only installation needs the Linux server sandbox; this platform is unsupported.')
    const expiresAt = Math.min(context.expiresAt, Date.now() + TTL)
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new ProvisionFailure('expired', 'Generate a new installer command.')
    const key = publicKey(context.agentsPublicKey), managementKey = publicKey(context.managementPublicKey), authorizedKey = context.agentsAuthorizedKey ?? `${key} drover-agents`
    if (/[\r\n\0]/.test(authorizedKey) || !authorizedKey.includes(key)) throw new ProvisionFailure('invalid_key', 'The authorized key must contain the dedicated agents public key.')
    const recovery = context.recoveryCleanup
    if (recovery && (typeof recovery.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(recovery.id) || !Array.isArray(recovery.agentsPublicKeys) || recovery.agentsPublicKeys.length > 1000)) throw new ProvisionFailure('invalid_cleanup', 'Invalid installer recovery request.')
    const recoveryCleanup = recovery ? { id: recovery.id, agentsPublicKeys: [...new Set(recovery.agentsPublicKeys.map(publicKey))], managementPublicKey: publicKey(recovery.managementPublicKey) } : undefined
    if (bridge) {
      assertBridge(bridge); port(machine.bridgePort)
      if (!context.bridgeHostKey || !context.tunnelPrivateKey || !context.tunnelPublicKey) throw new ProvisionFailure('missing_credentials', 'A pinned bridge host key and a dedicated tunnel key pair are required.')
      publicKey(context.bridgeHostKey); publicKey(context.tunnelPublicKey)
      if (!context.tunnelPrivateKey.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----\n') || context.tunnelPrivateKey.length > 16384) throw new ProvisionFailure('invalid_key', 'Expected the dedicated OpenSSH tunnel private key.')
    }
    for (const [id, cap] of capabilities) if (cap.expiresAt <= Date.now()) capabilities.delete(id)
    const token = randomBytes(32).toString('base64url'), receipt = randomBytes(32).toString('base64url')
    let base: string
    if (bridge) base = origin(context.publicOrigin, bridge)
    else {
      const lanHost = context.lanHost ?? Object.values(networkInterfaces()).flat().find(i => i && !i.internal && i.family === 'IPv4' && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address))?.address
      if (!lanHost || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(lanHost) || !/^\d+\.\d+\.\d+\.\d+$/.test(lanHost)) throw new ProvisionFailure('no_lan_address', 'No public bridge is selected and no private LAN address is available.')
      await listen(); base = `http://${lanHost}:${lanPort}`
    }
    const url = `${base}${MACHINES_INSTALL_PREFIX}${token}`
    const credentials = { version: 1, machineId: machine.id, os, agentsPublicKey: key, managementPublicKey: managementKey, agentsAuthorizedKey: authorizedKey, permissionSetupScript: context.permissionSetupScript ?? '', permissions: machine.permissions.mode, receipt, reportUrl: `${url}/report`, ...(recoveryCleanup ? { recoveryCleanup } : {}), bridge: bridge ? { host: host(bridge.host), sshPort: bridge.port ?? 22, user: bridgeTunnelUser(machine), port: port(machine.bridgePort), hostKey: publicKey(context.bridgeHostKey!), tunnelPublicKey: publicKey(context.tunnelPublicKey!), tunnelPrivateKey: context.tunnelPrivateKey! } : null }
    const template = await asset(`machines/install-${os === 'windows' ? 'windows.ps1' : 'unix.sh'}`)
    const script = template.replaceAll('__DROVER_KEY_URL__', url + '/key').replaceAll('__DROVER_OS__', os).replace('__DROVER_RECOVERY_UNIX__', await asset('machines/recovery-unix.py'))
    if (bridge) {
      await bridgeAction(bridge, { action: 'capability', token, expiresAt, script, credentials })
      // Poll only the fixed capability receipt; never log its token or host key.
      if (context.onReport) {
        let polling = false
        const timer = setInterval(() => {
          if (Date.now() >= expiresAt) { clearInterval(timer); timers.delete(timer); return }
          if (polling) return
          polling = true
          void bridgeAction(bridge, { action: 'report', token }).then(async result => {
            const line = result.stdout.split('\n').find(line => line.startsWith('DROVER_REPORT '))
            if (line) {
              const payload = JSON.parse(line.slice(14))
              if (payload.machineId === machine.id && payload.os === os && payload.state === 'installed' && payload.cleanupId === recoveryCleanup?.id) {
                const report: InstallerReport = { machineId: machine.id, os, state: 'installed', hostKey: publicKey(payload.hostKey), ...(recoveryCleanup ? { cleanupId: recoveryCleanup.id } : {}) }
                await context.onReport!(report); clearInterval(timer); timers.delete(timer)
              }
            }
          }).catch(() => undefined).finally(() => { polling = false })
        }, 5000); timer.unref(); timers.add(timer)
      }
    } else capabilities.set(token, { expiresAt, script, credentials, receipt, cleanupId: recoveryCleanup?.id, machineId: machine.id, os, onReport: context.onReport })
    // Clipboard/history and sudo argv contain only the one-time URL. The
    // installer fetches credentials separately; consumption precedes key bytes.
    if (os === 'windows') return `& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing ${ps(url + '/script')}).Content))`
    return `curl --fail --silent --show-error ${sh(url + '/script')} | sudo /bin/bash`
  }
  async function revokeInstallers(bridge: Machine | null): Promise<void> {
    capabilities.clear()
    for (const timer of timers) clearInterval(timer)
    timers.clear()
    if (bridge) await bridgeAction(bridge, { action: 'revoke-capabilities' })
  }
  async function dispose(): Promise<void> {
    capabilities.clear(); for (const timer of timers) clearInterval(timer); timers.clear()
    if (local) { local.closeAllConnections(); await new Promise<void>(ok => local!.close(() => ok())); local = null }
  }
  async function removeTargets(bridge: Machine, targets: Machine[], agentsPublicKey: string): Promise<void> {
    await bridgeAction(bridge, { action: 'remove', ids: targets.map(t => t.id), agentsPublicKey: publicKey(agentsPublicKey) })
  }
  async function revokeJumpKey(bridge: Machine, oldAgentsPublicKey: string): Promise<void> {
    await bridgeAction(bridge, { action: 'revoke-jump', publicKey: publicKey(oldAgentsPublicKey) })
  }
  async function retireBridge(bridge: Machine): Promise<void> {
    await bridgeAction(bridge, { action: 'retire' })
  }
  async function switchBridge(previous: Machine | null, next: Machine, targets: BridgeTarget[], agentsPublicKey: string, settings: BridgeOptions & { bridgeHostKey: string }): Promise<{ updated: string[]; needsReinstall: string[]; pendingOldCleanup: string[] }> {
    await setupBridge(next, targets, agentsPublicKey, settings)
    const updated: string[] = [], needsReinstall: string[] = []
    const script = await asset('machines/repoint.sh')
    for (const target of targets) {
      const machine = target.machine
      if (machine.os === 'windows') { needsReinstall.push(machine.id); continue }
      const data = { host: host(next.host), sshPort: next.port ?? 22, user: bridgeTunnelUser(machine), port: port(machine.bridgePort), hostKey: publicKey(settings.bridgeHostKey) }
      try { await execute(machine, `DROVER_REPOINT=${sh(b64(JSON.stringify(data)))}\n${script}`); updated.push(machine.id) }
      catch { needsReinstall.push(machine.id) }
    }
    const pendingOldCleanup: string[] = []
    if (previous && previous.id !== next.id) {
      try { await removeTargets(previous, targets.map(t => t.machine), agentsPublicKey); await revokeInstallers(previous) }
      catch { pendingOldCleanup.push(previous.id); await options.onStep?.('old-bridge-cleanup-pending') }
    }
    return { updated, needsReinstall, pendingOldCleanup }
  }
  return { setupBridge, installCommand, switchBridge, removeTargets, revokeJumpKey, retireBridge, revokeInstallers, dispose }
}

/** Convenience for adapters retaining the shared InstallCommand response. */
export async function machineInstallCommand(provisioner: ReturnType<typeof createMachineProvisioner>, context: InstallContext, os: MachineOs): Promise<InstallCommand> {
  return { command: await provisioner.installCommand(context, os), expiresAt: Math.min(context.expiresAt, Date.now() + TTL) }
}
