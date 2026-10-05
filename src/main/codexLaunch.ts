import { execFile } from 'node:child_process'
import { which } from './env'

export interface CodexCommandResult { code: number; stdout: string; stderr: string }
export function runCodex(env: NodeJS.ProcessEnv, args: string[], timeout = 15000): Promise<CodexCommandResult> {
  const binary = which('codex', env)
  if (!binary) return Promise.resolve({ code: 127, stdout: '', stderr: 'Codex CLI is not installed' })
  return new Promise(resolve => execFile(binary, args, { env, timeout, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
    resolve({ code: error ? typeof error.code === 'number' ? error.code : 1 : 0, stdout: String(stdout), stderr: String(stderr) })
  }))
}
export function codexIsolatedArgs(args: readonly string[], supported: boolean): string[] {
  return supported && !args.includes('--no-daemon') ? ['--no-daemon', ...args] : [...args]
}
export class CodexLaunch {
  private help: Promise<string> | null = null
  constructor(private env: () => NodeJS.ProcessEnv) {}
  reset(): void { this.help = null }
  async supportsNoDaemon(): Promise<boolean> {
    this.help ??= runCodex(this.env(), ['--help']).then(result => result.code === 0 ? result.stdout : '')
    return /(?:^|\s)--no-daemon(?:\s|$)/m.test(await this.help)
  }
  async args(args: readonly string[] = []): Promise<string[]> { return codexIsolatedArgs(args, await this.supportsNoDaemon()) }
}
