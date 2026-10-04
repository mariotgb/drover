import { useState } from 'react'
import clsx from 'clsx'
import { Check, Download, Film, Image as ImageIcon, Paintbrush, Plus, Trash2, Upload, X } from 'lucide-react'
import {
  GRADIENTS,
  MONO_FONTS,
  THEMES,
  isHexColor,
  resolveTheme,
  type AppearanceSettings,
  type ThemeDef,
  type ThemePalette
} from '@shared/themes'
import { api, isRemote } from '../api'
import { t } from '../i18n'
import { toast, updateSettings, useStore } from '../store'

function useAppearance(): [AppearanceSettings, (p: Partial<AppearanceSettings>) => void] {
  const a = useStore((s) => s.settings.appearance)
  const set = (p: Partial<AppearanceSettings>) => void updateSettings({ appearance: { ...useStore.getState().settings.appearance, ...p } })
  return [a, set]
}

function ThemeCard({ theme, active, onClick, label }: { theme: ThemeDef; active: boolean; onClick: () => void; label?: string }) {
  const p = theme.palette
  return (
    <button type="button" className={clsx('theme-card', active && 'active')} onClick={onClick} title={theme.name}>
      <div className="theme-preview" style={{ background: p.bg, borderColor: `color-mix(in srgb, ${p.text} 12%, transparent)` }}>
        <div className="tp-side" style={{ background: p.sidebar }}>
          <span style={{ background: p.accent }} />
          <span style={{ background: p.muted }} />
          <span style={{ background: p.muted }} />
        </div>
        <div className="tp-main">
          <span className="tp-bubble" style={{ background: `color-mix(in srgb, ${p.bg} 90%, ${p.text})` }} />
          <span className="tp-line" style={{ background: p.text }} />
          <span className="tp-line short" style={{ background: p.muted }} />
          <span className="tp-dots">
            <i style={{ background: p.green }} />
            <i style={{ background: p.yellow }} />
            <i style={{ background: p.blue }} />
          </span>
        </div>
      </div>
      <span className="theme-name">
        {active && <Check size={12} />} {label ?? theme.name}
      </span>
    </button>
  )
}

const ACCENTS = ['#d97757', '#2f6fdf', '#1f8a55', '#7c4ddb', '#db2777', '#e0a100', '#0e9f9f', '#5b5b56']

const PALETTE_FIELDS: [keyof ThemePalette, string][] = [
  ['bg', 'Background'],
  ['surface', 'Surfaces'],
  ['sidebar', 'Sidebar'],
  ['text', 'Text'],
  ['muted', 'Secondary text'],
  ['accent', 'Accent'],
  ['green', 'Green / done'],
  ['red', 'Red / errors'],
  ['yellow', 'Yellow / waiting'],
  ['blue', 'Blue / working'],
  ['purple', 'Purple'],
  ['cyan', 'Cyan']
]

export function AppearanceSettingsPane() {
  const [a, set] = useAppearance()
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const current = resolveTheme(a, systemDark)
  const [editing, setEditing] = useState<string | null>(null)
  const editTheme = a.customThemes.find((c) => c.id === editing) ?? null

  const customize = () => {
    const id = `custom-${Date.now().toString(36)}`
    const copy: ThemeDef = { id, name: t('{name} (custom)', { name: current.name }), palette: { ...current.palette }, custom: true }
    set({ customThemes: [...a.customThemes, copy], theme: id })
    setEditing(id)
  }

  const patchCustom = (id: string, patch: Omit<Partial<ThemeDef>, 'palette'> & { palette?: Partial<ThemePalette> }) => {
    set({
      customThemes: a.customThemes.map((c) => (c.id === id ? { ...c, ...patch, palette: { ...c.palette, ...(patch.palette ?? {}) } } : c))
    })
  }

  const exportCurrent = async () => {
    const json = JSON.stringify({ format: 'drover-theme', version: 1, name: current.name, palette: current.palette, accent: a.accent }, null, 2)
    if (await api.exportTheme(json, current.name)) toast('success', t('Theme exported'))
  }

  const importOne = async () => {
    const raw = await api.importTheme()
    if (!raw) return
    try {
      const j = JSON.parse(raw)
      const p = j.palette as ThemePalette
      const keys: (keyof ThemePalette)[] = ['bg', 'surface', 'sidebar', 'text', 'muted', 'accent', 'green', 'red', 'yellow', 'blue', 'purple', 'cyan']
      if (!p || !keys.every((k) => typeof p[k] === 'string' && isHexColor(p[k] as string)) || (p.base !== 'light' && p.base !== 'dark')) throw new Error('bad')
      const id = `custom-${Date.now().toString(36)}`
      set({ customThemes: [...a.customThemes, { id, name: String(j.name || 'Imported').slice(0, 40), palette: p, custom: true }], theme: id })
      toast('success', t('Theme imported'))
    } catch {
      toast('error', t('This file is not a Drover theme'))
    }
  }

  const pick = async (kind: 'image' | 'video') => {
    try {
      const path = await api.pickBackground(kind)
      if (path) set({ background: { ...a.background, kind, path } })
    } catch {
      toast('error', t('Could not use this file as a background'))
    }
  }

  return (
    <div className="settings-section appearance">
      <div className="setting-block-head big">{t('Theme')}</div>
      <div className="theme-grid">
        <ThemeCard theme={resolveTheme({ ...a, theme: 'system' }, systemDark)} label={t('System')} active={a.theme === 'system'} onClick={() => set({ theme: 'system' })} />
        {THEMES.map((th) => (
          <ThemeCard key={th.id} theme={th} active={a.theme === th.id} onClick={() => set({ theme: th.id })} />
        ))}
        {a.customThemes.map((th) => (
          <ThemeCard key={th.id} theme={th} active={a.theme === th.id} onClick={() => set({ theme: th.id })} />
        ))}
      </div>
      <div className="appearance-actions">
        <button type="button" className="btn btn-sm" onClick={customize}>
          <Paintbrush size={13} /> {t('Customize this theme…')}
        </button>
        {current.custom && (
          <button type="button" className="btn btn-sm" onClick={() => setEditing(editing === current.id ? null : current.id)}>
            {editing === current.id ? t('Done editing') : t('Edit colors')}
          </button>
        )}
        <button type="button" className="btn btn-sm" disabled={isRemote} onClick={() => void importOne()}>
          <Upload size={13} /> {t('Import…')}
        </button>
        <button type="button" className="btn btn-sm" disabled={isRemote} onClick={() => void exportCurrent()}>
          <Download size={13} /> {t('Export…')}
        </button>
      </div>

      {editTheme && (
        <div className="theme-editor">
          <div className="theme-editor-head">
            <input className="input" value={editTheme.name} onChange={(e) => patchCustom(editTheme.id, { name: e.target.value })} />
            <div className="segmented small">
              <button type="button" className={clsx(editTheme.palette.base === 'light' && 'active')} onClick={() => patchCustom(editTheme.id, { palette: { base: 'light' } })}>
                {t('Light')}
              </button>
              <button type="button" className={clsx(editTheme.palette.base === 'dark' && 'active')} onClick={() => patchCustom(editTheme.id, { palette: { base: 'dark' } })}>
                {t('Dark')}
              </button>
            </div>
            <button
              type="button"
              className="icon-btn icon-btn-sm"
              title={t('Delete theme')}
              onClick={() => {
                set({ customThemes: a.customThemes.filter((c) => c.id !== editTheme.id), theme: a.theme === editTheme.id ? 'system' : a.theme })
                setEditing(null)
              }}
            >
              <Trash2 size={13} />
            </button>
          </div>
          <div className="color-grid">
            {PALETTE_FIELDS.map(([key, label]) => (
              <label key={key} className="color-field">
                <input
                  type="color"
                  value={(editTheme.palette[key] as string) || '#000000'}
                  onChange={(e) => patchCustom(editTheme.id, { palette: { [key]: e.target.value } as Partial<ThemePalette> })}
                />
                <span>{t(label)}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">{t('Accent color')}</div>
          <div className="setting-hint">{t('Buttons, highlights and the picker outline.')}</div>
        </div>
        <div className="swatches">
          <button type="button" className={clsx('swatch theme-default', !a.accent && 'active')} title={t('Theme default')} style={{ background: current.palette.accent }} onClick={() => set({ accent: null })} />
          {ACCENTS.map((c) => (
            <button key={c} type="button" className={clsx('swatch', a.accent === c && 'active')} style={{ background: c }} title={c} onClick={() => set({ accent: c })} />
          ))}
          <label className={clsx('swatch custom', a.accent && !ACCENTS.includes(a.accent) && 'active')} title={t('Any color')}>
            <input type="color" value={a.accent ?? current.palette.accent} onChange={(e) => set({ accent: e.target.value })} />
            <Plus size={12} />
          </label>
        </div>
      </div>

      <div className="setting-block-head big">{t('Background')}</div>
      <div className="bg-grid">
        <button type="button" className={clsx('bg-card', a.background.kind === 'none' && 'active')} onClick={() => set({ background: { ...a.background, kind: 'none' } })}>
          <span className="bg-swatch none">
            <X size={14} />
          </span>
          <span>{t('None')}</span>
        </button>
        {GRADIENTS.map((g) => (
          <button
            key={g.id}
            type="button"
            className={clsx('bg-card', a.background.kind === 'gradient' && a.background.gradient === g.id && 'active')}
            onClick={() => set({ background: { ...a.background, kind: 'gradient', gradient: g.id } })}
          >
            <span className="bg-swatch" style={{ background: g.css }} />
            <span>{g.name}</span>
          </button>
        ))}
        <button type="button" className={clsx('bg-card', a.background.kind === 'image' && 'active')} disabled={isRemote} onClick={() => void pick('image')}>
          <span className="bg-swatch file">
            {!isRemote && a.background.kind === 'image' && a.background.path ? <img src={`hdfile://local/?p=${encodeURIComponent(a.background.path)}`} alt="" /> : <ImageIcon size={16} />}
          </span>
          <span>{t('Image…')}</span>
        </button>
        <button type="button" className={clsx('bg-card', a.background.kind === 'video' && 'active')} disabled={isRemote} onClick={() => void pick('video')}>
          <span className="bg-swatch file">
            <Film size={16} />
          </span>
          <span>{t('Video…')}</span>
        </button>
      </div>
      {a.background.kind !== 'none' && (
        <div className="slider-rows">
          <Slider label={t('Blur')} value={a.background.blur} min={0} max={40} unit="px" onChange={(v) => set({ background: { ...a.background, blur: v } })} />
          <Slider label={t('Dim')} value={a.background.dim} min={0} max={90} unit="%" onChange={(v) => set({ background: { ...a.background, dim: v } })} />
          <Slider label={t('Panel opacity')} value={Math.round(a.glass * 100)} min={30} max={100} unit="%" onChange={(v) => set({ glass: v / 100 })} />
          {(a.background.kind === 'image' || a.background.kind === 'video') && (
            <div className="slider-row">
              <span className="slider-label">{t('Fit')}</span>
              <div className="segmented small">
                <button type="button" className={clsx(a.background.fit === 'cover' && 'active')} onClick={() => set({ background: { ...a.background, fit: 'cover' } })}>
                  {t('Fill')}
                </button>
                <button type="button" className={clsx(a.background.fit === 'contain' && 'active')} onClick={() => set({ background: { ...a.background, fit: 'contain' } })}>
                  {t('Fit whole')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="setting-block-head big">{t('Text & shape')}</div>
      <div className="setting-row">
        <div className="setting-label">{t('Interface font')}</div>
        <div className="segmented small">
          {(
            [
              ['system', t('System')],
              ['rounded', t('Rounded')],
              ['serif', t('Serif')],
              ['mono', t('Mono')]
            ] as const
          ).map(([v, l]) => (
            <button key={v} type="button" className={clsx(a.uiFont === v && 'active')} onClick={() => set({ uiFont: v })}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">{t('Code & terminal font')}</div>
          <div className="setting-hint">{t('Fonts that are not installed fall back to SF Mono.')}</div>
        </div>
        <select className="input select" value={a.monoFont} onChange={(e) => set({ monoFont: e.target.value })}>
          {MONO_FONTS.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </div>
      <div className="setting-row">
        <div className="setting-label">{t('Corners')}</div>
        <div className="segmented small">
          {(
            [
              ['sharp', t('Sharp')],
              ['default', t('Default')],
              ['round', t('Round')]
            ] as const
          ).map(([v, l]) => (
            <button key={v} type="button" className={clsx(a.radius === v && 'active')} onClick={() => set({ radius: v })}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-label">{t('Density')}</div>
        <div className="segmented small">
          {(
            [
              ['comfortable', t('Comfortable')],
              ['compact', t('Compact')]
            ] as const
          ).map(([v, l]) => (
            <button key={v} type="button" className={clsx(a.density === v && 'active')} onClick={() => set({ density: v })}>
              {l}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function Slider({ label, value, min, max, unit, onChange }: { label: string; value: number; min: number; max: number; unit: string; onChange: (v: number) => void }) {
  return (
    <label className="slider-row">
      <span className="slider-label">{label}</span>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="slider-value">
        {value}
        {unit}
      </span>
    </label>
  )
}
