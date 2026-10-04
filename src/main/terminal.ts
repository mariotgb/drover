import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { TerminalFrame } from '@shared/types'
import { CONTROLLER_ID, sessionArgs } from './herdr/cli'

// Each visible terminal in the UI is backed by one
// `herdr terminal session control <pane> --takeover` process. It prints
// newline-delimited `terminal.frame` records (base64 ANSI, already rendered by
// the herdr server for our cols x rows) and accepts `terminal.input`,
// `terminal.resize`, `terminal.scroll` and `terminal.release` on stdin.

interface Bridge {
  id: string
  target: string
  proc: ChildProcessWithoutNullStreams
  closing: boolean
  closedSent: boolean
  pending: TerminalFrame[]
  flushScheduled: boolean
  stderr: string
}

export interface BridgeHost {
  herdrPath: () => string | null
  env: () => NodeJS.ProcessEnv
  session: () => string
  send: (channel: string, ...args: unknown[]) => void
}

export class TerminalBridges {
  private bridges = new Map<string, Bridge>()

  constructor(private host: BridgeHost) {}

  /** Reloading/closing the desktop window must not tear down browser terminals. */
  closeLocal(): void {
    for (const id of this.bridges.keys()) if (!id.startsWith('remote:')) this.close(id)
  }

  open(id: string, target: string, cols: number, rows: number, observeOnly = false): { ok: boolean; error?: string } {
    this.close(id)
    const herdr = this.host.herdrPath()
    if (!herdr) return { ok: false, error: 'herdr not found' }
    cols = Math.max(20, Math.min(1000, Math.floor(cols)))
    rows = Math.max(5, Math.min(500, Math.floor(rows)))
    const proc = spawn(
      herdr,
      [
        ...sessionArgs(this.host.session()),
        'terminal',
        'session',
        observeOnly ? 'observe' : 'control',
        target,
        '--cols',
        String(cols),
        '--rows',
        String(rows),
        ...(observeOnly ? [] : ['--takeover'])
      ],
      { env: { ...this.host.env(), HERDR_CONTROLLER_ID: CONTROLLER_ID }, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    const bridge: Bridge = {
      id,
      target,
      proc,
      closing: false,
      closedSent: false,
      pending: [],
      flushScheduled: false,
      stderr: ''
    }
    this.bridges.set(id, bridge)

    let chunks: Buffer[] = []
    proc.stdout.on('data', (data: Buffer) => {
      let start = 0
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== 0x0a) continue
        chunks.push(data.subarray(start, i))
        const line = Buffer.concat(chunks).toString('utf8')
        chunks = []
        start = i + 1
        this.handleLine(bridge, line)
      }
      if (start < data.length) chunks.push(Buffer.from(data.subarray(start)))
    })
    proc.stderr.on('data', (d: Buffer) => {
      bridge.stderr = (bridge.stderr + d.toString('utf8')).slice(-4000)
    })
    proc.stdin.on('error', () => {
      /* process went away; exit handler reports it */
    })
    proc.on('error', (err) => this.finish(bridge, `failed to start herdr: ${err.message}`))
    proc.on('exit', (code) => {
      const reason = bridge.stderr.trim().split('\n').pop() || (code ? `exited with code ${code}` : 'closed')
      this.finish(bridge, reason)
    })
    return { ok: true }
  }

  private handleLine(bridge: Bridge, line: string) {
    if (!line.trim()) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.type === 'terminal.frame' && typeof msg.bytes === 'string') {
      bridge.pending.push({
        seq: Number(msg.seq ?? 0),
        full: Boolean(msg.full),
        width: Number(msg.width ?? 0),
        height: Number(msg.height ?? 0),
        data: new Uint8Array(Buffer.from(msg.bytes, 'base64'))
      })
      if (!bridge.flushScheduled) {
        bridge.flushScheduled = true
        setImmediate(() => {
          bridge.flushScheduled = false
          if (!bridge.pending.length || bridge.closing) return
          const frames = bridge.pending
          bridge.pending = []
          this.host.send('term:frames', bridge.id, frames)
        })
      }
    } else if (msg.type === 'terminal.closed') {
      this.finish(bridge, typeof msg.reason === 'string' ? msg.reason : 'closed')
    }
  }

  private finish(bridge: Bridge, reason: string) {
    if (bridge.closedSent) return
    bridge.closedSent = true
    if (this.bridges.get(bridge.id) === bridge) this.bridges.delete(bridge.id)
    if (!bridge.closing) this.host.send('term:closed', bridge.id, reason)
  }

  private write(id: string, msg: Record<string, unknown>) {
    const bridge = this.bridges.get(id)
    if (!bridge || bridge.closing || !bridge.proc.stdin.writable) return
    bridge.proc.stdin.write(JSON.stringify(msg) + '\n')
  }

  input(id: string, text: string) {
    if (!text) return
    this.write(id, { type: 'terminal.input', text })
  }

  inputBytes(id: string, base64: string) {
    this.write(id, { type: 'terminal.input', bytes: base64 })
  }

  resize(id: string, cols: number, rows: number) {
    cols = Math.max(20, Math.min(1000, Math.floor(cols)))
    rows = Math.max(5, Math.min(500, Math.floor(rows)))
    this.write(id, { type: 'terminal.resize', cols, rows })
  }

  scroll(id: string, direction: 'up' | 'down', lines: number, source: 'wheel' | 'page_key' = 'wheel') {
    lines = Math.max(1, Math.min(200, Math.round(lines)))
    this.write(id, { type: 'terminal.scroll', direction, lines, source })
  }

  close(id: string) {
    const bridge = this.bridges.get(id)
    if (!bridge) return
    this.write(id, { type: 'terminal.release' })
    bridge.closing = true
    this.bridges.delete(id)
    try {
      bridge.proc.stdin.end()
    } catch {
      /* ignore */
    }
    const timer = setTimeout(() => {
      try {
        bridge.proc.kill('SIGTERM')
      } catch {
        /* ignore */
      }
    }, 1500)
    bridge.proc.once('exit', () => clearTimeout(timer))
  }

  closeAll() {
    for (const id of [...this.bridges.keys()]) this.close(id)
  }
}
