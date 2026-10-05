import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BossSettings } from '@shared/boss'

/** Replace without exposing a partial document or permissive temporary file. */
export async function writeBossJson(file: string, value: unknown): Promise<void> {
  return writeBossFile(file, JSON.stringify(value, null, 2) + '\n')
}
export async function writeBossFile(file: string, content: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { mode, flag: 'wx' })
    await chmod(temporary, mode)
    await rename(temporary, file)
  } finally { await unlink(temporary).catch(() => undefined) }
}

export function validateBossSettings(patch: Partial<BossSettings>): void {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(k => k !== 'excludedProjects' && k !== 'hqFolder')) throw new Error('Invalid boss settings')
  if (patch.hqFolder !== undefined && (typeof patch.hqFolder !== 'string' || !isAbsolute(patch.hqFolder) || patch.hqFolder.includes('\0') || patch.hqFolder.length > 8192)) throw new Error('Invalid headquarters folder')
  if (patch.excludedProjects !== undefined && (!Array.isArray(patch.excludedProjects) || patch.excludedProjects.length > 1000 || patch.excludedProjects.some(k => typeof k !== 'string' || !k || k.length > 8192))) throw new Error('Invalid project exclusions')
}

export class BossSettingsStore {
  private data: BossSettings
  constructor(private file: string, defaultFolder: string) { this.data = { hqFolder: defaultFolder, excludedProjects: [] } }
  async load(): Promise<void> {
    try {
      const stored = JSON.parse(await readFile(this.file, 'utf8'))
      validateBossSettings(stored)
      this.data = { ...this.data, ...stored }
    } catch { /* first run or corrupt settings */ }
  }
  get(): BossSettings { return structuredClone(this.data) }
  async set(patch: Partial<BossSettings>): Promise<BossSettings> {
    validateBossSettings(patch)
    const next = { ...this.data, ...patch, ...(patch.hqFolder ? { hqFolder: resolve(patch.hqFolder) } : {}) }
    await writeBossJson(this.file, next)
    this.data = structuredClone(next)
    return this.get()
  }
  static at(userData: string, home: string): BossSettingsStore {
    return new BossSettingsStore(join(userData, 'boss-settings.json'), join(home, '.drover', 'hq'))
  }
}
