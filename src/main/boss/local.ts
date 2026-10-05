import { randomBytes } from 'node:crypto'
import { chmod, unlink } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeBossJson } from './store'

export class BossLocalServer {
  private server: Server | null = null
  private socket = ''
  private token = randomBytes(32).toString('hex')
  private starting: Promise<void> | null = null
  constructor(private dispatch: (request: Record<string, unknown>) => Promise<unknown>) {}
  async start(folder: string, runtime: { herdrPath: string | null; session: string }): Promise<void> {
    if (!this.starting) this.starting = this.listen().catch(error => { this.starting = null; throw error })
    await this.starting
    await writeBossJson(join(folder, '.drover', 'boss-runtime.json'), { socket: this.socket, token: this.token, ...runtime })
  }
  private async listen(): Promise<void> {
    const name = `dv-boss-${randomBytes(8).toString('hex')}`
    this.socket = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), name + '.sock')
    const server = this.server = createServer(socket => {
      let input = '', handled = false
      socket.setTimeout(180_000, () => socket.destroy())
      socket.on('error', () => undefined)
      socket.on('data', bytes => {
        if (handled) return
        input += bytes.toString('utf8')
        if (input.length > 2 * 1024 * 1024) { socket.destroy(); return }
        if (!input.includes('\n')) return
        handled = true
        void (async () => {
          try {
            const request: Record<string, unknown> = JSON.parse(input.slice(0, input.indexOf('\n')))
            if (!request || typeof request !== 'object' || Array.isArray(request) || request.token !== this.token) throw new Error('Unauthorized HQ request')
            const result = await this.dispatch(request)
            socket.end(JSON.stringify({ ok: true, result }) + '\n')
          } catch (error) { socket.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + '\n') }
        })()
      })
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.socket, () => { server.off('error', reject); resolve() }) })
    if (process.platform !== 'win32') await chmod(this.socket, 0o600)
    server.unref()
  }
  dispose(): void {
    this.server?.close()
    if (this.socket && process.platform !== 'win32') void unlink(this.socket).catch(() => undefined)
  }
}
