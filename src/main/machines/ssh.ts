import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, parse, relative } from 'node:path'
import { createServer, createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import type { MachineError } from '@shared/machines'

export class MachinesFailure extends Error {
  constructor(public code: string, message: string) { super(message) }
}
export interface CommandResult { code: number; stdout: string; stderr: string }
export interface CommandOptions { input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
export type CommandRunner = (file: string, args: string[], options?: CommandOptions) => Promise<CommandResult>
export const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

/** No shell, no command/stdio logging; callers only expose fixed error reasons. */
export const runCommand: CommandRunner = (file, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
  let stdout = '', stderr = '', timedOut = false, overflow = false
  const kill = () => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch { /* exited */ } }
  const timer = setTimeout(() => { timedOut = true; kill() }, options.timeoutMs ?? 15_000)
  for (const [stream, output] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']] as const) stream.on('data', (bytes: Buffer) => {
    if (output === 'stdout') stdout += bytes.toString('utf8'); else stderr += bytes.toString('utf8')
    if (stdout.length + stderr.length > 1024 * 1024) { overflow = true; kill() }
  })
  child.on('error', () => { clearTimeout(timer); reject(new MachinesFailure('ssh_unavailable', 'OpenSSH is not available. Install its command-line tools.')) })
  child.on('close', code => {
    clearTimeout(timer)
    if (timedOut) reject(new MachinesFailure('timeout', 'The machine did not answer in time.'))
    else if (overflow) reject(new MachinesFailure('invalid_response', 'The machine returned too much output.'))
    else resolve({ code: code ?? 1, stdout, stderr })
  })
  child.stdin.on('error', () => undefined)
  child.stdin.end(options.input)
})

/** Refuse symlinked managed directories/files, including on reads. */
export async function privateDirectory(directory: string): Promise<void> {
  const root = parse(directory).root
  let current = root
  // Reject links in managed parent directories, except the platform temp-dir
  // aliases (/var and /tmp on macOS) which are outside our managed paths.
  for (const part of relative(root, directory).split('/')) {
    current = join(current, part)
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink() && current !== '/var' && current !== '/tmp') throw new MachinesFailure('unsafe_path', 'A managed machines directory contains a symbolic link.')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new MachinesFailure('unsafe_path', 'The machines directory must be a real private directory.')
  await chmod(directory, 0o700)
}
export async function privateRead(file: string): Promise<string | null> {
  try {
    const stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new MachinesFailure('unsafe_path', 'A managed machines file was replaced by a link.')
    await chmod(file, 0o600)
    return await readFile(file, 'utf8')
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
export async function privateWrite(file: string, value: string, mode = 0o600): Promise<void> {
  await privateDirectory(dirname(file))
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`
  try {
    await writeFile(temporary, value, { mode, flag: 'wx' })
    await chmod(temporary, mode)
    await rename(temporary, file)
  } finally { await unlink(temporary).catch(() => undefined) }
}

/** Password lives in memory; askpass reads it from a private, one-use socket.
 * Neither the helper, the environment nor stdin ever contains the password.
 */
export async function withAskpass<T>(password: string, directory: string, runtime: string, action: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  if (!password || password.length > 4096 || /[\r\n\0]/.test(password)) throw new MachinesFailure('invalid_password', 'Enter a single-line password.')
  const scratch = await mkdtemp(join(tmpdir(), 'drover-askpass-'))
  const socketPath = join(scratch, 'password.sock')
  let secret = password, used = false
  const server = createServer(socket => {
    socket.on('error', () => undefined)
    if (used) { socket.end(); return }
    used = true
    socket.end(secret + '\n')
    secret = ''
  })
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
    await chmod(socketPath, 0o600)
    const helper = join(scratch, 'askpass.cjs'), launcher = join(scratch, 'askpass')
    await privateWrite(helper, `const net=require('node:net');const c=net.createConnection(process.env.DROVER_ASKPASS_SOCKET);c.setTimeout(5000,()=>{c.destroy();process.exit(1)});c.on('data',b=>process.stdout.write(b));c.on('end',()=>process.exit(0));c.on('error',()=>process.exit(1));\n`)
    await privateWrite(launcher, `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${quote(runtime)} ${quote(helper)}\n`, 0o700)
    // The directory is supplied for interface symmetry; never put a password in it.
    if (!directory) throw new MachinesFailure('unsafe_path', 'Missing machines directory.')
    return await action({ SSH_ASKPASS: launcher, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'drover:0', DROVER_ASKPASS_SOCKET: socketPath })
  } finally { secret = ''; server.close(); await rm(scratch, { recursive: true, force: true }) }
}

export async function tcpProbe(host: string, port: number, timeoutMs = 5000): Promise<number> {
  const started = performance.now()
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => { socket.destroy(); resolve(Math.round(performance.now() - started)) })
    socket.once('timeout', () => { socket.destroy(); reject(new MachinesFailure('timeout', 'The SSH port did not answer.')) })
    socket.once('error', error => reject(new MachinesFailure(sshError(error).code, sshError(error).detail!)))
  })
}

export function fingerprint(key: string): string {
  const fields = key.trim().split(/\s+/)
  const encoded = fields[0]?.startsWith('ssh-') || fields[0]?.startsWith('ecdsa-') ? fields[1] : fields[2]
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new MachinesFailure('invalid_host_key', 'SSH did not return a valid host key.')
  const blob = Buffer.from(encoded, 'base64')
  if (blob.length < 16) throw new MachinesFailure('invalid_host_key', 'SSH did not return a valid host key.')
  return 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
}
export function sshError(error: unknown, password = false): MachineError {
  const code = (error as NodeJS.ErrnoException)?.code
  if (error instanceof MachinesFailure) return { code: error.code, detail: error.message }
  if (error instanceof Error && typeof (error as { code?: unknown }).code === 'string' && !/^(?:E[A-Z]+)$/.test(String(code))) return { code: String(code), detail: error.message }
  const message = error instanceof Error ? error.message : String(error)
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|host key.*mismatch/i.test(message)) return { code: 'host_key_changed', detail: 'The SSH host key changed. Confirm it through a trusted channel before reconnecting.' }
  if (/Permission denied|Authentication failed/i.test(message)) return { code: password ? 'password_rejected' : 'auth_failed', detail: password ? 'The one-time password was rejected.' : 'The machine refused the agents key.' }
  if (code === 'ECONNREFUSED' || /Connection refused/i.test(message)) return { code: 'refused', detail: 'The host answered, but no SSH server is listening on this port.' }
  if (code === 'ENOTFOUND' || /resolve hostname|Name or service not known/i.test(message)) return { code: 'dns', detail: 'This address does not resolve.' }
  if (code === 'ETIMEDOUT' || /timed out/i.test(message)) return { code: 'timeout', detail: 'The machine did not answer in time.' }
  if (/bwrap|sandbox/i.test(message)) return { code: 'permission_unavailable', detail: 'Restricted access needs a working Linux bubblewrap sandbox. Install it before choosing this permission.' }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || /No route to host/i.test(message)) return { code: 'host_unreachable', detail: 'There is no route to the machine.' }
  return { code: 'ssh_failed', detail: 'SSH could not complete the operation. Check the machine account and SSH service.' }
}
