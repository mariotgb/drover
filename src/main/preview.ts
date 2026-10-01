import { execFile } from 'node:child_process'
import { request } from 'node:http'
import { webContents } from 'electron'
import type { LocalServer } from '@shared/types'
import { saveImage } from './attachments'

// Local dev servers for the preview panel: listening TCP ports, the process
// behind each, and its working directory so servers can be matched to herdr
// projects.

const SYSTEM_COMMANDS = /^(rapportd|ControlCe|ControlCenter|sharingd|launchd|mDNSRespo|mDNSResponder|identitys|AirPlayXP|com\.apple|remoted|UserEvent|SystemUIS|Spotify|Dropbox|Google|Microsoft|Adobe|Creative|figma_age|Figma|Raycast|Docker|com\.docker|ollama|OneDrive|zoom|Slack|Discord|Telegram|steam|Code|Cursor|Electron|Drover|Claude|stable|cupsd|postgres|mysqld|redis-ser|mongod)/i

function run(cmd: string, args: string[], timeout = 4000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (_err, stdout) => resolve(String(stdout ?? '')))
  })
}

function isHttp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, method: 'HEAD', path: '/', timeout: 700 }, (res) => {
      res.resume()
      resolve(true)
    })
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.on('error', () => resolve(false))
    req.end()
  })
}

export async function detectServers(): Promise<LocalServer[]> {
  const out = await run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'])
  const byPid = new Map<number, { command: string; ports: Set<number> }>()
  let pid = 0
  let command = ''
  for (const line of out.split('\n')) {
    const tag = line[0]
    const val = line.slice(1)
    if (tag === 'p') {
      pid = Number(val)
      command = ''
    } else if (tag === 'c') command = val
    else if (tag === 'n' && pid) {
      const m = val.match(/^(\*|127\.0\.0\.1|\[::1\]|\[::\]|localhost|0\.0\.0\.0):(\d+)$/)
      if (!m) continue
      const port = Number(m[2])
      if (port < 1024 || SYSTEM_COMMANDS.test(command)) continue
      const entry = byPid.get(pid) ?? { command, ports: new Set<number>() }
      entry.ports.add(port)
      byPid.set(pid, entry)
    }
  }
  if (!byPid.size) return []
  const cwdOut = await run('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-F', 'pn', '-p', [...byPid.keys()].join(',')])
  const cwds = new Map<number, string>()
  let cur = 0
  for (const line of cwdOut.split('\n')) {
    if (line[0] === 'p') cur = Number(line.slice(1))
    else if (line[0] === 'n' && cur) cwds.set(cur, line.slice(1))
  }
  const servers: LocalServer[] = []
  for (const [p, info] of byPid) {
    for (const port of info.ports) {
      servers.push({ port, pid: p, command: info.command, cwd: cwds.get(p) ?? null, url: `http://localhost:${port}`, http: false })
    }
  }
  await Promise.all(servers.map(async (s) => (s.http = await isHttp(s.port))))
  return servers.filter((s) => s.http).sort((a, b) => a.port - b.port)
}

/** Screenshot of a region of the preview page, saved as an attachment. */
export async function capturePreview(
  id: number,
  rect: { x: number; y: number; width: number; height: number }
): Promise<string | null> {
  const wc = webContents.fromId(id)
  if (!wc || wc.isDestroyed()) return null
  const pad = 6
  const x = Math.max(0, Math.floor(rect.x - pad))
  const y = Math.max(0, Math.floor(rect.y - pad))
  const width = Math.max(1, Math.ceil(rect.width + pad * 2))
  const height = Math.max(1, Math.ceil(rect.height + pad * 2))
  const image = await wc.capturePage({ x, y, width, height })
  if (image.isEmpty()) return null
  const size = image.getSize()
  // Keep attachments reasonable for agents: cap the longest side.
  const scaled = Math.max(size.width, size.height) > 1600 ? image.resize(size.width >= size.height ? { width: 1600 } : { height: 1600 }) : image
  return saveImage(new Uint8Array(scaled.toPNG()), 'image/png', 'element')
}
