import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'
import { DEFAULT_APPEARANCE } from '@shared/themes'

export class SettingsStore {
  private data: AppSettings
  private timer: NodeJS.Timeout | null = null
  private listeners = new Set<(s: AppSettings) => void>()

  constructor(private file: string) {
    let loaded: Partial<AppSettings> = {}
    try {
      loaded = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      /* first run */
    }
    this.data = { ...DEFAULT_SETTINGS, ...loaded, agentArgs: { ...DEFAULT_SETTINGS.agentArgs, ...(loaded.agentArgs ?? {}) }, agentModels: { ...(loaded.agentModels ?? {}) } }
    // The preview used to reopen the last URL on its own; it now starts empty and lists it as recent.
    const legacy = (loaded as { previewUrls?: Record<string, string> }).previewUrls
    if (legacy && !loaded.previewRecent) {
      this.data.previewRecent = Object.fromEntries(Object.entries(legacy).filter(([, u]) => typeof u === 'string').map(([k, u]) => [k, [u]]))
    }
    delete (this.data as { previewUrls?: unknown }).previewUrls
    if (!loaded.appearance) {
      // Migrate the first-version theme/accent settings.
      const accents: Record<string, string | null> = { orange: null, blue: '#2f6fdf', green: '#1f8a55', violet: '#7c4ddb', graphite: '#5b5b56' }
      this.data.appearance = {
        ...DEFAULT_APPEARANCE,
        theme: loaded.theme === 'light' || loaded.theme === 'dark' ? loaded.theme : 'system',
        accent: loaded.accent ? accents[loaded.accent] ?? null : null
      }
    } else {
      this.data.appearance = { ...DEFAULT_APPEARANCE, ...loaded.appearance, background: { ...DEFAULT_APPEARANCE.background, ...(loaded.appearance.background ?? {}) } }
    }
  }

  static at(dir: string): SettingsStore {
    return new SettingsStore(join(dir, 'settings.json'))
  }

  get(): AppSettings {
    return this.data
  }

  set(patch: Partial<AppSettings>): AppSettings {
    this.data = { ...this.data, ...patch }
    for (const l of this.listeners) l(this.data)
    this.scheduleSave()
    return this.data
  }

  onChange(fn: (s: AppSettings) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  addRecentFolder(path: string) {
    const list = [path, ...this.data.recentFolders.filter((p) => p !== path)].slice(0, 12)
    this.set({ recentFolders: list })
  }

  private scheduleSave() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 300)
  }

  flush() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.data, null, 2))
      renameSync(tmp, this.file)
    } catch {
      /* ignore */
    }
  }
}
