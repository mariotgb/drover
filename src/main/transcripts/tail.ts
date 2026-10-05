import { watch, type FSWatcher } from 'node:fs'
import { open, stat } from 'node:fs/promises'

/**
 * Follows an append-only JSONL file. Emits complete lines only; a partial
 * trailing line is kept until its newline arrives. Uses fs.watch for low
 * latency plus a slow poll as a safety net (fs.watch can miss events).
 */
export class FileTailer {
  private offset = 0
  private partial: Buffer = Buffer.alloc(0)
  private watcher: FSWatcher | null = null
  private poll: NodeJS.Timeout | null = null
  private reading = false
  private again = false
  private stopped = false
  private identity: string | null = null

  constructor(
    readonly path: string,
    private onLines: (lines: string[], reset: boolean) => void,
    private onError?: (err: Error) => void,
    private maxBytes: () => number = () => Infinity
  ) {}

  async start(): Promise<void> {
    await this.read(true)
    if (this.stopped) return
    try {
      this.watcher = watch(this.path, { persistent: false }, () => void this.read(false))
      this.watcher.on('error', () => {
        this.watcher?.close()
        this.watcher = null
      })
    } catch {
      /* polling only */
    }
    this.poll = setInterval(() => void this.read(false), 1200)
  }

  stop() {
    this.stopped = true
    this.watcher?.close()
    this.watcher = null
    if (this.poll) clearInterval(this.poll)
    this.poll = null
  }

  private async read(initial: boolean): Promise<void> {
    if (this.stopped) return
    if (this.reading) {
      this.again = true
      return
    }
    this.reading = true
    try {
      let reset = initial
      const st = await stat(this.path)
      if (st.size > this.maxBytes()) throw new Error('office-history-limit')
      const identity = `${st.dev}:${st.ino}`
      if ((this.identity !== null && this.identity !== identity) || st.size < this.offset) {
        // Truncated or replaced: start over.
        this.offset = 0
        this.partial = Buffer.alloc(0)
        reset = true
      }
      this.identity = identity
      if (st.size > this.offset || reset) {
        const fh = await open(this.path, 'r')
        try {
          const length = st.size - this.offset
          const buf = Buffer.alloc(length)
          let pos = 0
          while (pos < length) {
            const { bytesRead } = await fh.read(buf, pos, length - pos, this.offset + pos)
            if (!bytesRead) break
            pos += bytesRead
          }
          this.offset += pos
          const data = this.partial.length ? Buffer.concat([this.partial, buf.subarray(0, pos)]) : buf.subarray(0, pos)
          const lastNl = data.lastIndexOf(0x0a)
          let lines: string[] = []
          if (lastNl >= 0) {
            lines = data.subarray(0, lastNl).toString('utf8').split('\n')
            this.partial = Buffer.from(data.subarray(lastNl + 1))
          } else {
            this.partial = Buffer.from(data)
          }
          lines = lines.filter((l) => l.trim().length > 0)
          if (!this.stopped && (lines.length || reset)) this.onLines(lines, reset)
        } finally {
          await fh.close()
        }
      }
    } catch (err) {
      if (!this.stopped) this.onError?.(err as Error)
    } finally {
      this.reading = false
      if (this.again && !this.stopped) {
        this.again = false
        void this.read(false)
      }
    }
  }
}
