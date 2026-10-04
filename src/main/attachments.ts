import { execFile } from 'node:child_process'
import { mkdir, readdir, rm, stat, writeFile, copyFile, chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join, basename, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'

const run = promisify(execFile)

// Pasted screenshots are written to disk and handed to agents as file paths:
// Claude Code and Codex both turn a pasted image path into an image
// attachment. The directory has no spaces so the path pastes cleanly.
export const ATTACHMENTS_DIR = join(homedir(), '.drover', 'attachments')

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp'
}

export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])

/**
 * iPhone/macOS photos (HEIC) and TIFFs render neither in Chromium nor in the
 * agents, so they are converted to JPEG with macOS's built-in sips.
 */
export const CONVERT_EXTS = new Set(['heic', 'heif', 'tif', 'tiff'])
const CONVERT_MIMES: Record<string, string> = { 'image/heic': 'heic', 'image/heif': 'heif', 'image/tiff': 'tiff' }

export async function convertToJpeg(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true, mode: 0o700 })
  await chmod(dirname(dest), 0o700)
  await writeFile(dest, '', { mode: 0o600 })
  try {
    await run('/usr/bin/sips', ['-s', 'format', 'jpeg', src, '--out', dest], { timeout: 60000 })
    await chmod(dest, 0o600)
  } catch (error) { await rm(dest, { force: true }); throw error }
}

function stamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export async function saveImage(bytes: Uint8Array, mime: string, name?: string): Promise<string> {
  const nameExt = name ? extname(name).slice(1).toLowerCase() : ''
  const convert = CONVERT_MIMES[mime.toLowerCase()] ?? (CONVERT_EXTS.has(nameExt) ? nameExt : null)
  const ext = EXT_BY_MIME[mime.toLowerCase()] ?? nameExt
  const safeExt = IMAGE_EXTS.has(ext) ? ext : 'png'
  await mkdir(ATTACHMENTS_DIR, { recursive: true, mode: 0o700 })
  await chmod(ATTACHMENTS_DIR, 0o700)
  const base = name
    ? basename(name, extname(name)).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40) || 'image'
    : 'screenshot'
  const stem = join(ATTACHMENTS_DIR, `${base}-${stamp()}-${randomBytes(3).toString('hex')}`)
  if (convert) {
    const raw = `${stem}.${convert}`
    await writeFile(raw, bytes, { mode: 0o600 })
    try {
      await convertToJpeg(raw, `${stem}.jpg`)
    } finally {
      await rm(raw, { force: true })
    }
    return `${stem}.jpg`
  }
  const file = `${stem}.${safeExt}`
  await writeFile(file, bytes, { mode: 0o600 })
  return file
}

/** Copies a user-picked file when its path would not paste cleanly or its format needs converting. */
export async function stageFile(path: string): Promise<string> {
  const ext = extname(path)
  const convert = CONVERT_EXTS.has(ext.slice(1).toLowerCase())
  if (!convert && !/[\s'"\\]/.test(path)) return path
  await mkdir(ATTACHMENTS_DIR, { recursive: true, mode: 0o700 })
  await chmod(ATTACHMENTS_DIR, 0o700)
  const base = basename(path, ext).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40) || 'file'
  const stem = join(ATTACHMENTS_DIR, `${base}-${stamp()}-${randomBytes(3).toString('hex')}`)
  if (convert) {
    try {
      await convertToJpeg(path, `${stem}.jpg`)
      return `${stem}.jpg`
    } catch {
      /* not convertible: hand over the original */
    }
  }
  await copyFile(path, `${stem}${ext}`)
  await chmod(`${stem}${ext}`, 0o600)
  return `${stem}${ext}`
}

export async function cleanupAttachments(maxAgeDays = 30): Promise<void> {
  try {
    await mkdir(ATTACHMENTS_DIR, { recursive: true, mode: 0o700 })
    await chmod(ATTACHMENTS_DIR, 0o700)
    const cutoff = Date.now() - maxAgeDays * 864e5
    for (const f of await readdir(ATTACHMENTS_DIR)) {
      const p = join(ATTACHMENTS_DIR, f)
      const st = await stat(p)
      if (st.isFile() && st.mtimeMs < cutoff) await rm(p, { force: true })
    }
  } catch {
    /* nothing to clean */
  }
}
