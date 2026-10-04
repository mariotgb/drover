import { appendFile, chmod, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { REMOTE_METHOD_CHANNELS } from '@shared/remote'

type Event = 'ws_connect' | 'ws_disconnect' | 'ws_error' | 'rpc_error' | 'rpc_timeout'
/** Fixed fields only. Never accepts URLs, headers, arguments, error messages or credentials. */
export class RemoteLog {
  private queue = Promise.resolve()
  private pending = 0
  private file: string
  constructor(userData: string, private maxBytes = 1024 * 1024, private copies = 3) {
    this.file = join(userData, 'logs', 'remote.log')
  }
  write(event: Event, connection: string, method?: unknown, code?: number): void {
    if (this.pending >= 256) return // Disk trouble must not grow memory without bound.
    const line = JSON.stringify({ time: new Date().toISOString(), event, connection,
      method: typeof method === 'string' && Object.hasOwn(REMOTE_METHOD_CHANNELS, method) ? method : undefined,
      code: typeof code === 'number' ? code : undefined }) + '\n'
    this.pending++
    this.queue = this.queue.then(async () => {
      await mkdir(join(this.file, '..'), { recursive: true, mode: 0o700 })
      let bytes = 0
      try { bytes = (await stat(this.file)).size } catch { /* First write. */ }
      if (bytes + Buffer.byteLength(line) > this.maxBytes) {
        for (let i = this.copies - 1; i >= 0; i--) {
          const from = i ? `${this.file}.${i}` : this.file
          try { await rename(from, `${this.file}.${i + 1}`) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        }
      }
      await appendFile(this.file, line, { mode: 0o600 })
      await chmod(this.file, 0o600)
    }).catch(() => { /* Diagnostics must never break remote access. */ }).finally(() => { this.pending-- })
  }
  flush(): Promise<void> { return this.queue }
}
