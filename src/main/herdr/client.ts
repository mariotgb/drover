import { createConnection, type Socket } from 'node:net'
import { HerdrApiError } from '@shared/types'

// Minimal client for herdr's newline-delimited JSON socket API.
// Every request uses its own short-lived connection (like the herdr CLI does),
// so long waits never block other calls. Subscriptions keep a dedicated
// connection open and receive pushed event lines.

let counter = 0
const nextId = (method: string) => `drover:${method}:${++counter}`

class LineReader {
  private chunks: Buffer[] = []
  constructor(private onLine: (line: string) => void) {}
  push(data: Buffer) {
    let start = 0
    for (let i = 0; i < data.length; i++) {
      if (data[i] === 0x0a) {
        this.chunks.push(data.subarray(start, i))
        const line = Buffer.concat(this.chunks).toString('utf8')
        this.chunks = []
        start = i + 1
        if (line.trim()) this.onLine(line)
      }
    }
    if (start < data.length) this.chunks.push(Buffer.from(data.subarray(start)))
  }
}

export interface SubscriptionHandle {
  close(): void
  readonly closed: boolean
}

export interface HerdrEventEnvelope {
  event: string
  data: Record<string, unknown>
}

export class HerdrClient {
  constructor(public readonly socketPath: string) {}

  request<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 20000
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = nextId(method)
      let settled = false
      let sock: Socket | null = null
      const finish = (err: Error | null, value?: T) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          sock?.destroy()
        } catch {
          /* ignore */
        }
        if (err) reject(err)
        else resolve(value as T)
      }
      const timer = setTimeout(
        () => finish(new HerdrApiError('timeout', `${method} timed out after ${timeoutMs} ms`)),
        timeoutMs
      )
      const reader = new LineReader((line) => {
        let msg: { id?: string; result?: T; error?: { code: string; message: string } }
        try {
          msg = JSON.parse(line)
        } catch {
          return
        }
        if (msg.id !== undefined && msg.id !== id) return
        if (msg.error) finish(new HerdrApiError(msg.error.code, msg.error.message))
        else finish(null, msg.result as T)
      })
      try {
        sock = createConnection(this.socketPath)
      } catch (e) {
        finish(new HerdrApiError('connection_failed', String(e)))
        return
      }
      sock.on('connect', () => {
        sock!.write(JSON.stringify({ id, method, params }) + '\n')
      })
      sock.on('data', (d: Buffer) => reader.push(d))
      sock.on('error', (e: NodeJS.ErrnoException) =>
        finish(new HerdrApiError(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'server_not_running' : 'connection_failed', e.message))
      )
      sock.on('close', () => finish(new HerdrApiError('connection_closed', `${method}: connection closed`)))
    })
  }

  /**
   * Opens an `events.subscribe` stream. `onReady` fires once the server
   * acknowledged the subscription; `onClose` fires exactly once.
   */
  subscribe(
    subscriptions: Record<string, unknown>[],
    handlers: {
      onEvent: (ev: HerdrEventEnvelope) => void
      onReady?: () => void
      onClose?: (err?: Error) => void
    }
  ): SubscriptionHandle {
    const id = nextId('events.subscribe')
    let closed = false
    let acked = false
    const sock = createConnection(this.socketPath)
    const handle: SubscriptionHandle = {
      close() {
        if (closed) return
        closed = true
        try {
          sock.destroy()
        } catch {
          /* ignore */
        }
        handlers.onClose?.()
      },
      get closed() {
        return closed
      }
    }
    const reader = new LineReader((line) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (!acked && msg.id === id) {
        if (msg.error) {
          const e = msg.error as { code: string; message: string }
          closed = true
          sock.destroy()
          handlers.onClose?.(new HerdrApiError(e.code, e.message))
          return
        }
        acked = true
        handlers.onReady?.()
        return
      }
      if (typeof msg.event === 'string') {
        handlers.onEvent({ event: msg.event, data: (msg.data as Record<string, unknown>) ?? {} })
      }
    })
    sock.on('connect', () => {
      sock.write(JSON.stringify({ id, method: 'events.subscribe', params: { subscriptions } }) + '\n')
    })
    sock.on('data', (d: Buffer) => reader.push(d))
    sock.on('error', (e) => {
      if (closed) return
      closed = true
      handlers.onClose?.(e)
    })
    sock.on('close', () => {
      if (closed) return
      closed = true
      handlers.onClose?.()
    })
    return handle
  }
}
