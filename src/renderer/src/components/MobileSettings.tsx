import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Check, ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react'
import { GRADIENTS, MONO_FONTS, THEMES, resolveTheme, type AppearanceSettings, type ThemeDef } from '@shared/themes'
import { REMOTE_AUTH_ROUTES, REMOTE_PUSH_ROUTES, type RemoteAuthSession, type RemotePushPreferences, type RemotePushStatus } from '@shared/remote'
import { applyAppearance, UI_FONTS } from '../appearance'
import { errorText } from '../api'
import { disablePush, enablePush, installedPwa, pushRequest, supportsPush } from '../push'
import { logoutRemote } from '../remote-session'
import { locale, t } from '../i18n'
import { toast, updateSettings, useStore } from '../store'
import { ACCENTS } from './AppearanceSettings'
import { Spinner } from './primitives'

type Page = 'main' | 'theme' | 'background' | 'font' | 'mono'

function useAppearance(): [AppearanceSettings, (p: Partial<AppearanceSettings>) => void] {
  const a = useStore((s) => s.settings.appearance)
  const set = (p: Partial<AppearanceSettings>) => void updateSettings({ appearance: { ...useStore.getState().settings.appearance, ...p } })
  return [a, set]
}

const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches
const FONT_LABELS = { system: 'System', rounded: 'Rounded', serif: 'Serif', mono: 'Mono' } as const

/** iOS-style settings: only what makes sense on a phone. Appearance is the Mac's own setting. */
export function MobileSettings({ onClose }: { onClose: () => void }) {
  const [page, setPage] = useState<Page>('main')
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => { body.current?.scrollTo(0, 0) }, [page])
  const titles: Record<Page, string> = { main: t('Settings'), theme: t('Theme'), background: t('Background'), font: t('Interface font'), mono: t('Code & terminal font') }
  return (
    <div className="mw-settings">
      <header className="mw-sheet-head">
        <div className="mw-sheet-side">{page !== 'main' && <button type="button" className="mw-text-btn back" onClick={() => setPage('main')}><ChevronLeft size={22} />{t('Settings')}</button>}</div>
        <div className="mw-sheet-title"><strong>{titles[page]}</strong></div>
        <div className="mw-sheet-side end">{page === 'main' && <button type="button" className="mw-text-btn strong" onClick={onClose}>{t('Done')}</button>}</div>
      </header>
      <div className="mw-settings-body" ref={body}>
        {page === 'main' && <MainPage open={setPage} />}
        {page === 'theme' && <ThemePage />}
        {page === 'background' && <BackgroundPage />}
        {page === 'font' && <FontPage />}
        {page === 'mono' && <MonoPage />}
      </div>
    </div>
  )
}

function Group({ title, footer, children }: { title?: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <section className="mw-group">
      {title && <h2>{title}</h2>}
      <div className="mw-group-list">{children}</div>
      {footer && <div className="mw-group-foot">{footer}</div>}
    </section>
  )
}

function NavRow({ label, value, onClick, icon }: { label: string; value?: ReactNode; onClick: () => void; icon?: ReactNode }) {
  return (
    <button type="button" className="mw-row nav" onClick={onClick}>
      {icon}
      <span className="mw-row-label">{label}</span>
      {value !== undefined && <span className="mw-row-value">{value}</span>}
      <ChevronRight size={18} className="mw-row-chev" />
    </button>
  )
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return <div className="mw-row"><span className="mw-row-label">{label}</span><span className="mw-row-value">{value}</span></div>
}

function ToggleRow({ label, on, disabled, onChange }: { label: string; on: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className={clsx('mw-row', disabled && 'disabled')}>
      <span className="mw-row-label">{label}</span>
      <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={clsx('toggle', on && 'on')} onClick={() => onChange(!on)}><span /></button>
    </label>
  )
}

function Segments<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="mw-row stacked">
      <span className="mw-row-label">{label}</span>
      <div className="segmented mw-segmented" role="radiogroup" aria-label={label}>
        {options.map(([v, text]) => (
          <button key={v} type="button" role="radio" aria-checked={value === v} className={clsx(value === v && 'active')} onClick={() => onChange(v)}>{text}</button>
        ))}
      </div>
    </div>
  )
}

function OptionRow({ label, active, onClick, lead, style }: { label: string; active: boolean; onClick: () => void; lead?: ReactNode; style?: React.CSSProperties }) {
  return (
    <button type="button" role="radio" aria-checked={active} className="mw-row option" onClick={onClick}>
      {lead}
      <span className="mw-row-label" style={style}>{label}</span>
      {active && <Check size={20} className="mw-row-check" />}
    </button>
  )
}

function themeLabel(a: AppearanceSettings) {
  if (a.theme === 'system') return t('Match system')
  const theme = [...THEMES, ...a.customThemes].find((th) => th.id === a.theme)
  return theme ? themeName(theme) : t('Match system')
}
function themeName(theme: ThemeDef) {
  return theme.id === 'light' ? t('Light') : theme.id === 'dark' ? t('Dark') : theme.name
}
function backgroundLabel(a: AppearanceSettings) {
  const bg = a.background
  if (bg.kind === 'gradient') return GRADIENTS.find((g) => g.id === bg.gradient)?.name ?? GRADIENTS[0].name
  if (bg.kind === 'image') return t('Image')
  if (bg.kind === 'video') return t('Video')
  return t('None')
}

function MainPage({ open }: { open: (page: Page) => void }) {
  const [a, set] = useAppearance()
  const leadOnly = useStore((s) => s.settings.leadOnly)
  const current = resolveTheme(a, systemDark())
  const accents = a.accent && !ACCENTS.includes(a.accent) ? [...ACCENTS, a.accent] : ACCENTS
  return <>
    <Group title={t('Appearance')} footer={t('Appearance is shared with Drover on your Mac: a change shows up on both.')}>
      <NavRow label={t('Theme')} value={themeLabel(a)} onClick={() => open('theme')} />
      <div className="mw-row stacked">
        <span className="mw-row-label">{t('Accent color')}</span>
        <div className="mw-swatches" role="radiogroup" aria-label={t('Accent color')}>
          <button type="button" role="radio" aria-checked={!a.accent} aria-label={t('Theme default')} className={clsx('mw-swatch theme-default', !a.accent && 'active')} style={{ ['--swatch' as string]: current.palette.accent }} onClick={() => set({ accent: null })} />
          {accents.map((c) => <button key={c} type="button" role="radio" aria-checked={a.accent === c} aria-label={c} className={clsx('mw-swatch', a.accent === c && 'active')} style={{ ['--swatch' as string]: c }} onClick={() => set({ accent: c })} />)}
        </div>
      </div>
      <NavRow label={t('Background')} value={backgroundLabel(a)} onClick={() => open('background')} />
      <NavRow label={t('Interface font')} value={t(FONT_LABELS[a.uiFont] ?? 'System')} onClick={() => open('font')} />
      <NavRow label={t('Code & terminal font')} value={a.monoFont} onClick={() => open('mono')} />
      <Segments label={t('Corners')} value={a.radius} options={[['sharp', t('Sharp')], ['default', t('Default')], ['round', t('Round')]]} onChange={(radius) => set({ radius })} />
      <Segments label={t('Density')} value={a.density} options={[['comfortable', t('Comfortable')], ['compact', t('Compact')]]} onChange={(density) => set({ density })} />
    </Group>
    <Group title={t('Agents list')} footer={t('Other agents of a project fold into one row that opens on tap. Agents waiting for an answer stay in sight. Pick the lead in the agent menu.')}>
      <ToggleRow label={t('Show only the project lead')} on={leadOnly} onChange={(v) => void updateSettings({ leadOnly: v })} />
    </Group>
    <NotificationGroup />
    <DeviceGroup />
    <AboutGroup />
  </>
}

function ThemePreview({ theme }: { theme: ThemeDef }) {
  const p = theme.palette
  return (
    <span className="mw-theme-preview" style={{ background: p.bg, borderColor: `color-mix(in srgb, ${p.text} 14%, transparent)` }} aria-hidden>
      <i style={{ background: p.sidebar }} />
      <b style={{ background: p.accent }} />
      <em style={{ background: p.text }} />
    </span>
  )
}

function ThemePage() {
  const [a, set] = useAppearance()
  const system = resolveTheme({ ...a, theme: 'system' }, systemDark())
  const custom = a.customThemes
  return <>
    <Group footer={t('“Match system” follows the light or dark mode of this phone.')}>
      <OptionRow label={t('Match system')} active={a.theme === 'system'} lead={<ThemePreview theme={system} />} onClick={() => set({ theme: 'system' })} />
    </Group>
    <Group title={t('Themes')}>
      {THEMES.map((th) => <OptionRow key={th.id} label={themeName(th)} active={a.theme === th.id} lead={<ThemePreview theme={th} />} onClick={() => set({ theme: th.id })} />)}
    </Group>
    {custom.length > 0 && <Group title={t('Your themes')}>
      {custom.map((th) => <OptionRow key={th.id} label={th.name} active={a.theme === th.id} lead={<ThemePreview theme={th} />} onClick={() => set({ theme: th.id })} />)}
    </Group>}
  </>
}

/** Previews instantly, saves once the finger stops. */
function SliderRow({ label, value, min, max, unit, onCommit, preview }: { label: string; value: number; min: number; max: number; unit: string; onCommit: (v: number) => void; preview: (v: number) => void }) {
  const [local, setLocal] = useState(value)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => setLocal(value), [value])
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <label className="mw-row stacked">
      <span className="mw-row-label">{label}<span className="mw-row-value">{local}{unit}</span></span>
      <input type="range" className="mw-range" min={min} max={max} value={local} aria-label={label} style={{ ['--fill' as string]: `${((local - min) / (max - min)) * 100}%` }}
        onChange={(e) => {
          const v = Number(e.target.value)
          setLocal(v)
          preview(v)
          clearTimeout(timer.current)
          timer.current = setTimeout(() => onCommit(v), 300)
        }} />
    </label>
  )
}

function BackgroundPage() {
  const [a, set] = useAppearance()
  const bg = a.background
  const preview = (p: Partial<AppearanceSettings>) => {
    const s = useStore.getState().settings
    applyAppearance({ ...s, appearance: { ...s.appearance, ...p } })
  }
  return <>
    <Group footer={t('Pick a picture or a video in Drover on your Mac; it shows here too.')}>
      <OptionRow label={t('None')} active={bg.kind === 'none'} lead={<span className="mw-bg-preview none" />} onClick={() => set({ background: { ...bg, kind: 'none' } })} />
      {GRADIENTS.map((g) => (
        <OptionRow key={g.id} label={g.name} active={bg.kind === 'gradient' && (bg.gradient ?? GRADIENTS[0].id) === g.id} lead={<span className="mw-bg-preview" style={{ background: g.css }} />}
          onClick={() => set({ background: { ...bg, kind: 'gradient', gradient: g.id } })} />
      ))}
      {(bg.kind === 'image' || bg.kind === 'video') && <OptionRow label={bg.kind === 'image' ? t('Image from your Mac') : t('Video from your Mac')} active lead={<span className="mw-bg-preview media" />} onClick={() => undefined} />}
    </Group>
    {bg.kind !== 'none' && <Group title={t('Effects')}>
      <SliderRow label={t('Dim')} value={bg.dim} min={0} max={90} unit="%" preview={(dim) => preview({ background: { ...bg, dim } })} onCommit={(dim) => set({ background: { ...useStore.getState().settings.appearance.background, dim } })} />
      <SliderRow label={t('Blur')} value={bg.blur} min={0} max={40} unit=" px" preview={(blur) => preview({ background: { ...bg, blur } })} onCommit={(blur) => set({ background: { ...useStore.getState().settings.appearance.background, blur } })} />
      <SliderRow label={t('Panel opacity')} value={Math.round(a.glass * 100)} min={30} max={100} unit="%" preview={(v) => preview({ glass: v / 100 })} onCommit={(v) => set({ glass: v / 100 })} />
      {(bg.kind === 'image' || bg.kind === 'video') && <Segments label={t('Fit')} value={bg.fit} options={[['cover', t('Fill')], ['contain', t('Fit whole')]]} onChange={(fit) => set({ background: { ...bg, fit } })} />}
    </Group>}
  </>
}

function FontPage() {
  const [a, set] = useAppearance()
  return (
    <Group>
      {(Object.keys(FONT_LABELS) as (keyof typeof FONT_LABELS)[]).map((f) => (
        <OptionRow key={f} label={t(FONT_LABELS[f])} active={a.uiFont === f} style={{ fontFamily: UI_FONTS[f] }} onClick={() => set({ uiFont: f })} />
      ))}
    </Group>
  )
}

function MonoPage() {
  const [a, set] = useAppearance()
  return (
    <Group footer={t('Fonts that are not installed fall back to SF Mono.')}>
      {MONO_FONTS.map((f) => <OptionRow key={f} label={f} active={a.monoFont === f} style={{ fontFamily: `'${f}', ui-monospace, monospace` }} onClick={() => set({ monoFont: f })} />)}
    </Group>
  )
}

function NotificationGroup() {
  const [status, setStatus] = useState<RemotePushStatus | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [local, setLocal] = useState(false)
  const supported = supportsPush()
  const installed = installedPwa()
  useEffect(() => {
    void (async () => {
      setStatus(await pushRequest<RemotePushStatus>(REMOTE_PUSH_ROUTES.status))
      if (supported) setLocal(!!await (await navigator.serviceWorker.getRegistration('/'))?.pushManager.getSubscription())
    })().catch((e) => setError(errorText(e)))
  }, [supported])
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await work() } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const enabled = !!status?.subscribed && local
  const change = (patch: Partial<RemotePushPreferences>) => {
    if (!status) return
    const previous = status
    setStatus({ ...status, preferences: { ...status.preferences, ...patch } })
    void run(async () => {
      try { setStatus(await pushRequest(REMOTE_PUSH_ROUTES.preferences, patch)) } catch (cause) { setStatus(previous); throw cause }
    })
  }
  const hint = !supported && installed
    ? t('Push notifications are not available in this browser. Try the installed Drover app on your Home Screen.')
    : !installed ? t('On iPhone, add Drover to your Home Screen from Safari’s Share menu, then open it from there to enable notifications.')
      : t('Get notified when an agent finishes or needs your answer. Notification previews do not contain chat messages.')
  return (
    <Group title={t('Notifications')} footer={<>{error ? <span className="mw-error" role="alert">{error}</span> : hint}</>}>
      {!status && !error ? <div className="mw-row"><Spinner /></div> : <>
        <ToggleRow label={t('Phone notifications')} on={enabled} disabled={busy || !supported || !status} onChange={() => void run(async () => {
          if (enabled) { setStatus(await disablePush()); setLocal(false) } else { setStatus(await enablePush()); setLocal(true) }
        })} />
        <ToggleRow label={t('When an agent finishes')} on={!!status?.preferences.finished} disabled={busy || !status} onChange={(finished) => change({ finished })} />
        <ToggleRow label={t('When an agent needs an answer')} on={!!status?.preferences.blocked} disabled={busy || !status} onChange={(blocked) => change({ blocked })} />
      </>}
    </Group>
  )
}

function DeviceGroup() {
  const [session, setSession] = useState<RemoteAuthSession | null>(null)
  useEffect(() => {
    void fetch(REMOTE_AUTH_ROUTES.session, { credentials: 'same-origin', cache: 'no-store' }).then((r) => r.json() as Promise<RemoteAuthSession>).then(setSession).catch(() => undefined)
  }, [])
  const date = (ms?: number) => (ms ? new Date(ms).toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' }) : '—')
  const signOut = () => useStore.setState({ dialog: {
    type: 'confirm', title: t('Sign out on this phone?'), message: t('To come back, sign in with your passkey. Your agents keep working on the Mac.'), confirm: t('Sign out'), danger: true,
    onConfirm: async () => {
      try { await logoutRemote() } catch (e) { toast('error', errorText(e)) }
    }
  } })
  return (
    <Group title={t('This device')} footer={t('Remove this phone’s access on your Mac: Settings → Remote access.')}>
      <InfoRow label={t('Name')} value={session?.device?.name ?? '—'} />
      <InfoRow label={t('Paired')} value={date(session?.device?.createdAt)} />
      <InfoRow label={t('Signed in until')} value={date(session?.expiresAt)} />
      <button type="button" className="mw-row danger" onClick={signOut}><span className="mw-row-label">{t('Sign out')}</span></button>
    </Group>
  )
}

function AboutGroup() {
  const appVersion = useStore((s) => s.appVersion)
  const herdr = useStore((s) => s.snapshot?.version ?? s.connection.version)
  const session = useStore((s) => s.connection.session)
  return (
    <Group title={t('About')}>
      <InfoRow label="Drover" value={appVersion || '—'} />
      <InfoRow label="herdr" value={herdr || '—'} />
      <InfoRow label={t('herdr session')} value={session} />
      <a className="mw-row nav" href="https://github.com/mariotgb/drover" target="_blank" rel="noreferrer"><span className="mw-row-label">{t('Source code on GitHub')}</span><ExternalLink size={17} className="mw-row-chev" /></a>
    </Group>
  )
}
