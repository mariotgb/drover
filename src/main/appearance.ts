import { app, dialog, type BrowserWindow } from 'electron'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { CONVERT_EXTS, convertToJpeg } from './attachments'

export const IMAGE_BG = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'heic', 'heif', 'tif', 'tiff']
export const VIDEO_BG = ['mp4', 'webm', 'mov', 'm4v']

export function backgroundsDir(): string {
  return join(app.getPath('userData'), 'backgrounds')
}

/** Lets the user choose a background; the file is copied into the app's data. */
export async function pickBackground(win: BrowserWindow | null, kind: 'image' | 'video'): Promise<string | null> {
  const exts = kind === 'image' ? IMAGE_BG : VIDEO_BG
  const opts = { properties: ['openFile' as const], filters: [{ name: kind === 'image' ? 'Images' : 'Videos', extensions: exts }] }
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (res.canceled || !res.filePaths[0]) return null
  const src = res.filePaths[0]
  const ext = extname(src).slice(1).toLowerCase()
  if (!exts.includes(ext)) return null
  const dir = backgroundsDir()
  await mkdir(dir, { recursive: true })
  const convert = CONVERT_EXTS.has(ext)
  const dest = join(dir, `bg-${Date.now()}-${randomBytes(3).toString('hex')}.${convert ? 'jpg' : ext}`)
  if (convert) await convertToJpeg(src, dest)
  else await copyFile(src, dest)
  // Only the newest background is kept.
  for (const f of await readdir(dir)) if (join(dir, f) !== dest) await rm(join(dir, f), { force: true })
  return dest
}

export async function exportTheme(win: BrowserWindow | null, json: string, name: string): Promise<boolean> {
  const opts = { defaultPath: `${name.replace(/[^\w.-]+/g, '-') || 'theme'}.drover-theme.json`, filters: [{ name: 'Theme', extensions: ['json'] }] }
  const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  if (res.canceled || !res.filePath) return false
  await writeFile(res.filePath, json)
  return true
}

export async function importTheme(win: BrowserWindow | null): Promise<string | null> {
  const opts = { properties: ['openFile' as const], filters: [{ name: 'Theme', extensions: ['json'] }] }
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (res.canceled || !res.filePaths[0]) return null
  const st = await stat(res.filePaths[0])
  if (st.size > 256 * 1024) return null
  return readFile(res.filePaths[0], 'utf8')
}

const MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  bmp: 'image/bmp'
}

/** File response with HTTP Range support (needed for <video> playback). */
export async function fileResponse(path: string, range: string | null): Promise<Response> {
  const st = await stat(path)
  const type = MIME[extname(path).slice(1).toLowerCase()] ?? 'application/octet-stream'
  const m = range?.match(/bytes=(\d*)-(\d*)/)
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]))
    let end = m[1] && m[2] ? Number(m[2]) : st.size - 1
    end = Math.min(end, st.size - 1)
    start = Math.min(start, end)
    const body = Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream
    return new Response(body, {
      status: 206,
      headers: { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes' }
    })
  }
  const body = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream
  return new Response(body, { headers: { 'Content-Type': type, 'Content-Length': String(st.size), 'Accept-Ranges': 'bytes' } })
}
