import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { isIP } from 'node:net'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { BridgeForward, ExistingBridge, HostKey, Machine } from '@shared/machines'
import { fingerprint, MachinesFailure, type CommandRunner } from './ssh'
import { validHost, validPort } from './store'

export interface BridgeAdmin { host?: string; port?: number; user: string; keyPath: string }
export interface LocalBridge extends ExistingBridge {
  tunnelUser: string
  forwards: BridgeForward[]
  keyPath?: string
  knownHostsPath?: string
  hostKeyAlias?: string
  admin?: BridgeAdmin
}
export interface ExistingBridgeOptions {
  home: string; userData: string; run: CommandRunner; env: NodeJS.ProcessEnv
  remoteSettings?: { remotePublicUrl?: string; remotePort?: number }
  admin?: BridgeAdmin
  machines?: Machine[]
}
const userPattern = /^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/
function path(value: unknown, home: string): string | undefined {
  if (typeof value !== 'string' || /[\r\n\0"]/.test(value)) return undefined
  const expanded = value.startsWith('~/') ? join(home, value.slice(2)) : value
  return isAbsolute(expanded) ? expanded : undefined
}
async function metadata(file: string): Promise<string | null> {
  try { const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return null; return await readFile(file, 'utf8') }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new MachinesFailure('existing_bridge_invalid', 'Local bridge metadata could not be read.') }
}
export async function keyExists(file: string | undefined): Promise<boolean> {
  if (!file) return false
  try { const stat = await lstat(file); return stat.isFile() && !stat.isSymbolicLink() }
  catch { return false }
}
function origin(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' ? url.origin : undefined } catch { return undefined }
}
function sslipHost(url: string | undefined): string | undefined {
  if (!url) return undefined
  const host = new URL(url).hostname
  const match = host.match(/^(\d{1,3})[.-](\d{1,3})[.-](\d{1,3})[.-](\d{1,3})\.sslip\.io$/i)
  const ip = match?.slice(1).join('.')
  return ip && isIP(ip) === 4 ? ip : undefined
}
export function parseForward(value: string): BridgeForward {
  const parts = value.split(':')
  if (parts.length === 3) parts.unshift('127.0.0.1')
  if (parts.length !== 4 || !['localhost', '127.0.0.1'].includes(parts[0]) || !['localhost', '127.0.0.1'].includes(parts[2])) throw new MachinesFailure('existing_bridge_invalid', 'The existing tunnel must forward loopback ports only.')
  const listenPort = Number(parts[1]), targetPort = Number(parts[3]); validPort(listenPort); validPort(targetPort)
  return { listenHost: '127.0.0.1', listenPort, targetHost: '127.0.0.1', targetPort }
}
/** Parse only SSH transport metadata; never interpret shell commands or Includes. */
export function parseBridgeArguments(args: unknown, home: string): Pick<LocalBridge, 'host' | 'port' | 'tunnelUser' | 'forwards' | 'keyPath' | 'knownHostsPath' | 'hostKeyAlias'> {
  if (!Array.isArray(args) || args.some(a => typeof a !== 'string') || !/^(.+\/)?ssh$/.test(args[0] ?? '')) throw new MachinesFailure('existing_bridge_invalid', 'The bridge LaunchAgent must run OpenSSH directly.')
  let port = 22, user = '', destination = '', keyPath: string | undefined, knownHostsPath: string | undefined, hostKeyAlias: string | undefined
  const forwards: BridgeForward[] = []
  const option = (o: string) => { const [k, ...v] = o.split('='); const value = v.join('='); if (k.toLowerCase() === 'userknownhostsfile') knownHostsPath = path(value, home); if (k.toLowerCase() === 'hostkeyalias') hostKeyAlias = value; if (k.toLowerCase() === 'identityfile') keyPath = path(value, home); if (k.toLowerCase() === 'port') port = Number(value); if (k.toLowerCase() === 'user') user = value }
  for (let i = 1; i < args.length; i++) {
    const arg: string = args[i]
    if (arg === '-R' || arg.startsWith('-R') && arg.length > 2) forwards.push(parseForward(arg === '-R' ? args[++i] : arg.slice(2)))
    else if (arg === '-p') port = Number(args[++i])
    else if (/^-p\d+$/.test(arg)) port = Number(arg.slice(2))
    else if (arg === '-l') user = args[++i]
    else if (arg === '-i') keyPath = path(args[++i], home)
    else if (arg === '-o') option(args[++i] ?? '')
    else if (arg.startsWith('-o')) option(arg.slice(2))
    else if (['-F', '-E', '-S', '-J'].includes(arg)) i++
    else if (!arg.startsWith('-')) { if (destination) throw new MachinesFailure('existing_bridge_invalid', 'Unexpected bridge SSH command.'); destination = arg }
  }
  const split = destination.lastIndexOf('@'); const host = split < 0 ? destination : destination.slice(split + 1)
  if (split >= 0) user = destination.slice(0, split)
  validHost(host); validPort(port)
  if (!userPattern.test(user) || !forwards.length) throw new MachinesFailure('existing_bridge_invalid', 'The bridge LaunchAgent has no valid login or reverse forwards.')
  return { host, port, tunnelUser: user, forwards, keyPath, knownHostsPath, hostKeyAlias }
}
function matchesPin(field: string, names: string[]): boolean {
  return field.split(',').some(entry => {
    if (!entry.startsWith('|1|')) return names.includes(entry)
    const [, version, salt, digest] = entry.split('|')
    if (version !== '1' || !salt || !digest) return false
    const expected = Buffer.from(digest, 'base64')
    return names.some(name => { const actual = createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest(); return actual.length === expected.length && timingSafeEqual(actual, expected) })
  })
}
async function localPin(files: string[], host: string, port: number, alias?: string): Promise<HostKey | undefined> {
  const names = [port === 22 ? host : `[${host}]:${port}`, `[${host}]:${port}`, ...(alias ? [alias] : [])]
  for (const file of [...new Set(files)]) {
    for (const line of (await metadata(file) ?? '').split('\n')) {
      const fields = line.trim().split(/\s+/)
      if (line.startsWith('#') || !matchesPin(fields[0] ?? '', names)) continue
      try { return { algorithm: fields[1], fingerprint: fingerprint(line), known: true } } catch { /* Ignore malformed public metadata. */ }
    }
  }
  return undefined
}
export async function detectLocalBridge(options: ExistingBridgeOptions): Promise<LocalBridge | null> {
  let remote = options.remoteSettings
  if (!remote) { const raw = await metadata(join(options.userData, 'settings.json')); try { const data = raw ? JSON.parse(raw) : {}; remote = { remotePublicUrl: data.remotePublicUrl, remotePort: data.remotePort } } catch { remote = {} } }
  const publicUrl = origin(remote.remotePublicUrl)
  const plist = join(options.home, 'Library/LaunchAgents/dev.drover.bridge.plist')
  let transport: ReturnType<typeof parseBridgeArguments> | undefined
  if (await metadata(plist) !== null) {
    const result = await options.run('plutil', ['-convert', 'json', '-o', '-', plist], { env: options.env })
    try { const data = JSON.parse(result.stdout); if (result.code || data.Label !== 'dev.drover.bridge') throw Error(); transport = parseBridgeArguments(data.ProgramArguments, options.home) }
    catch { throw new MachinesFailure('existing_bridge_invalid', 'The bridge LaunchAgent has invalid SSH metadata.') }
  }
  const host = transport?.host ?? sslipHost(publicUrl)
  if (!host) return null
  validHost(host)
  if (transport && sslipHost(publicUrl) && sslipHost(publicUrl) !== host) throw new MachinesFailure('bridge_state_conflict', 'The phone URL and local tunnel point to different servers.')
  let admin = options.admin
  if (!admin) { const raw = await metadata(join(options.userData, 'bridge-admin.json')); try { admin = raw ? JSON.parse(raw) : undefined } catch { /* Absent configuration. */ } }
  if (admin && (!userPattern.test(admin.user) || admin.host && admin.host !== host || admin.port !== undefined && admin.port !== (transport?.port ?? 22))) admin = undefined
  const adminKeyPath = path(admin?.keyPath, options.home)
  const adminKey = await keyExists(adminKeyPath)
  if (admin && adminKeyPath) admin = { ...admin, keyPath: adminKeyPath }; else admin = undefined
  let tunnelRunning = false
  if (transport) {
    const result = await options.run('launchctl', ['print', `gui/${process.getuid?.() ?? 0}/dev.drover.bridge`], { env: options.env })
    tunnelRunning = result.code === 0 && /\bstate\s*=\s*running\b/.test(result.stdout) && /\bpid\s*=\s*[1-9]\d*/.test(result.stdout)
  }
  const port = transport?.port ?? 22
  const hostKey = await localPin([...(transport?.knownHostsPath ? [transport.knownHostsPath] : []), join(options.home, '.ssh/mac_bridge_known_hosts'), join(options.home, '.ssh/known_hosts'), join(options.home, '.drover/machines/known_hosts')], host, port, transport?.hostKeyAlias)
  return { ...(transport ?? { tunnelUser: 'bridge-mac', forwards: [] }), host, port, users: [...new Set([transport?.tunnelUser ?? 'bridge-mac', 'jump'])], ...(publicUrl ? { publicUrl, phoneUrl: publicUrl } : {}), tunnelRunning, macTunnel: transport ? tunnelRunning ? 'running' : 'stopped' : 'missing', adminKey, ...(adminKeyPath ? { adminKeyPath } : {}), ...(admin ? { admin } : {}), ...(hostKey ? { hostKey } : {}), ...(options.machines?.find(m => m.kind === 'direct' && m.host === host && m.port === port) ? { machineId: options.machines.find(m => m.kind === 'direct' && m.host === host && m.port === port)!.id } : {}) }
}
export function publicExistingBridge(local: LocalBridge): ExistingBridge {
  const { host, port, users, publicUrl, phoneUrl, tunnelRunning, macTunnel, adminKey, adminKeyPath, machineId, hostKey } = local
  return { host, port, users, publicUrl, phoneUrl, tunnelRunning, macTunnel, adminKey, adminKeyPath, machineId, hostKey }
}
