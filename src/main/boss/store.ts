import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BossSettings } from '@shared/boss'
import type { AgentSessionRef } from '@shared/types'

export interface BossBinding {
  session: string
  folder: string
  workspaceId: string
  paneId: string
  kind: string
  name: string
  args: string[]
  prompt: string
  agentSession?: AgentSessionRef | null
}

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
  private boss: BossBinding | null = null
  private get bindingsFile(): string { return join(dirname(this.file), 'boss-binding.json') }
  constructor(private file: string, defaultFolder: string) { this.data = { hqFolder: defaultFolder, excludedProjects: [] } }
  async load(): Promise<void> {
    try {
      const stored = JSON.parse(await readFile(this.file, 'utf8'))
      validateBossSettings(stored)
      this.data = { ...this.data, ...stored }
    } catch { /* first run or corrupt settings */ }
    try {
      const stored = JSON.parse(await readFile(this.bindingsFile, 'utf8'))
      // Migrate the earliest binding from the short-lived per-session format.
      // A single global reservation is authoritative across all selected sessions.
      const binding: BossBinding | null = stored.version === 2 ? stored.boss : stored.version === 1 && stored.sessions && typeof stored.sessions === 'object' && !Array.isArray(stored.sessions) ? Object.values(stored.sessions)[0] as BossBinding ?? null : null
      if (![1, 2].includes(stored.version) || !binding) throw new Error('Invalid boss binding')
        if (typeof binding.session !== 'string' || !isAbsolute(binding.folder) ||
            ![binding.workspaceId, binding.paneId, binding.kind, binding.name, binding.prompt].every(v => typeof v === 'string') ||
            !Array.isArray(binding.args) || binding.args.some(v => typeof v !== 'string')) throw new Error('Invalid boss binding')
      this.boss = binding
    } catch (error) {
      // Losing this file must not silently create a second boss.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  globalBinding(): BossBinding | null { return structuredClone(this.boss) }
  binding(session: string): BossBinding | null { return this.boss?.session === session ? this.globalBinding() : null }
  async bind(binding: BossBinding): Promise<void> {
    if (this.boss && (this.boss.session !== binding.session || this.boss.paneId !== binding.paneId)) throw new Error('A global Main boss already exists')
    await writeBossJson(this.bindingsFile, { version: 2, boss: binding })
    this.boss = structuredClone(binding)
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
