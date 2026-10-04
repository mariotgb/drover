import { useRef, useState } from 'react'
import clsx from 'clsx'
import { RefreshCw, TriangleAlert } from 'lucide-react'
import type { LimitWindow, ProviderLimits } from '@shared/types'
import { api } from '../api'
import { locale, t } from '../i18n'
import { openSettings } from '../actions'
import { useStore } from '../store'
import { AgentAvatar, useClickOutside, useTicker } from './primitives'

const NAMES = { claude: 'Claude Code', codex: 'Codex' } as const
const LABELS: Record<string, string> = { '5-hour': '5-hour', Weekly: 'Weekly', 'Weekly · Opus': 'Weekly · Opus', 'Weekly · Sonnet': 'Weekly · Sonnet' }

/** A window whose reset time has passed no longer counts the old usage. */
export function effectivePercent(w: LimitWindow, now = Date.now()): number {
  if (w.resetsAt && w.resetsAt <= now) return 0
  return Math.max(0, Math.min(100, w.usedPercent))
}

function level(p: number): 'ok' | 'warn' | 'high' {
  return p >= 90 ? 'high' : p >= 70 ? 'warn' : 'ok'
}

export function formatReset(at: number | undefined, now = Date.now()): string {
  if (!at) return ''
  const ms = at - now
  if (ms <= 0) return t('reset')
  const mins = Math.round(ms / 60000)
  if (mins < 60) return t('resets in {m}m', { m: mins })
  const h = Math.floor(mins / 60)
  if (h < 24) return t('resets in {h}h {m}m', { h, m: mins % 60 })
  return t('resets {when}', { when: new Date(at).toLocaleString(locale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' }) })
}

function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return t('just now')
  if (s < 3600) return t('{n} min ago', { n: Math.round(s / 60) })
  if (s < 86400) return t('{n} h ago', { n: Math.round(s / 3600) })
  return t('{n} d ago', { n: Math.round(s / 86400) })
}

const SHORT: Record<string, string> = { '5-hour': '5h', Weekly: 'wk', 'Weekly · Opus': 'opus', 'Weekly · Sonnet': 'sonnet' }

function Bar({ pct }: { pct: number }) {
  return (
    <span className={clsx('limit-bar', `lv-${level(pct)}`)}>
      <span style={{ width: `${Math.max(pct, pct > 0 ? 3 : 0)}%` }} />
    </span>
  )
}

function ProviderRow({ lim }: { lim: ProviderLimits }) {
  const now = Date.now()
  const windows = lim.windows.filter((w) => w.label === '5-hour' || w.label === 'Weekly')
  const shown = windows.length ? windows : lim.windows.slice(0, 2)
  return (
    <div className="usage-row">
      <AgentAvatar kind={lim.provider} size={16} />
      <span className="usage-name">{lim.provider === 'claude' ? 'Claude' : 'Codex'}</span>
      {lim.error && !shown.length ? (
        <span className="usage-err" title={lim.error}>
          <TriangleAlert size={12} /> {t('unavailable')}
        </span>
      ) : (
        <span className="usage-windows">
          {shown.map((w) => {
            const p = effectivePercent(w, now)
            return (
              <span key={w.label} className="usage-win" title={`${t(LABELS[w.label] ?? w.label)}: ${t('{n}% used', { n: Math.round(p) })} ${formatReset(w.resetsAt, now)}`}>
                <span className="usage-win-label">{SHORT[w.label] ?? w.label}</span>
                <Bar pct={p} />
                <span className={clsx('usage-pct', `lv-${level(p)}`)}>{Math.round(p)}%</span>
              </span>
            )
          })}
        </span>
      )}
    </div>
  )
}

export function UsageWidget() {
  const limits = useStore((s) => s.limits)
  const show = useStore((s) => s.settings.showLimits)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useClickOutside(ref, () => setOpen(false), open)
  useTicker(30_000, show)
  if (!show) return null
  const list = [limits.claude, limits.codex].filter((x): x is ProviderLimits => !!x)
  if (!list.length) return null
  const claudeMissing = !limits.claude
  return (
    <div className="usage" ref={ref}>
      <button type="button" className="usage-btn" onClick={() => setOpen(!open)} title={t('Plan usage limits')}>
        {list.map((l) => (
          <ProviderRow key={l.provider} lim={l} />
        ))}
      </button>
      {open && <UsagePopover list={list} claudeMissing={claudeMissing} onClose={() => setOpen(false)} />}
    </div>
  )
}

function UsagePopover({ list, claudeMissing, onClose }: { list: ProviderLimits[]; claudeMissing: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const now = Date.now()
  return (
    <div className="usage-pop">
      <div className="usage-pop-head">
        <span>{t('Plan usage')}</span>
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          title={t('Refresh')}
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            const s = await api.refreshLimits()
            useStore.setState({ limits: s })
            setBusy(false)
          }}
        >
          <RefreshCw size={13} className={clsx(busy && 'spin')} />
        </button>
      </div>
      {list.map((l) => (
        <div key={l.provider} className="usage-provider">
          <div className="usage-provider-head">
            <AgentAvatar kind={l.provider} size={18} />
            <span className="usage-provider-name">{NAMES[l.provider]}</span>
            {l.plan && <span className="usage-plan">{l.plan}</span>}
            {l.reached && <span className="usage-reached">{t('limit reached')}</span>}
          </div>
          {l.windows.map((w) => {
            const p = effectivePercent(w, now)
            return (
              <div key={w.label} className="usage-detail">
                <div className="usage-detail-top">
                  <span>{t(LABELS[w.label] ?? w.label)}</span>
                  <span className={clsx('usage-pct', `lv-${level(p)}`)}>{t('{n}% used', { n: Math.round(p) })}</span>
                </div>
                <Bar pct={p} />
                <div className="usage-detail-sub">{formatReset(w.resetsAt, now)}</div>
              </div>
            )
          })}
          {l.error && <div className="usage-error">{l.error}</div>}
          <div className="usage-updated">
            {l.provider === 'codex' ? t('From your latest Codex session · {when}', { when: ago(l.observedAt, now) }) : t('From Claude Code’s status line · {when}', { when: ago(l.observedAt, now) })}
          </div>
        </div>
      ))}
      {claudeMissing && (
        <div className="usage-provider">
          <div className="usage-provider-head">
            <AgentAvatar kind="claude" size={18} />
            <span className="usage-provider-name">Claude Code</span>
          </div>
          <div className="usage-detail-sub">{t('Not shown yet. Turn it on in Settings → General: Claude Code passes its limits to a local status line — no tokens, no network.')}</div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              onClose()
              openSettings('general')
            }}
          >
            {t('Open Settings')}
          </button>
        </div>
      )}
    </div>
  )
}

/** Tight usage hint for the composer of the current agent. */
export function LimitChip({ kind }: { kind: string | null }) {
  const lim = useStore((s) => (kind === 'claude' ? s.limits.claude : kind === 'codex' ? s.limits.codex : null))
  const show = useStore((s) => s.settings.showLimits)
  if (!show || !lim || !lim.windows.length) return null
  const now = Date.now()
  const worst = lim.windows.reduce((a, b) => (effectivePercent(b, now) > effectivePercent(a, now) ? b : a))
  const p = effectivePercent(worst, now)
  return (
    <span className={clsx('limit-chip', `lv-${level(p)}`)} title={lim.windows.map((w) => `${w.label}: ${Math.round(effectivePercent(w, now))}% ${formatReset(w.resetsAt, now)}`).join('\n')}>
      <Bar pct={p} />
      {SHORT[worst.label] ?? worst.label} {Math.round(p)}%
    </span>
  )
}

/** Phone drawer: the sidebar's limit rows in the same look; a tap shows reset times. */
export function MobileUsage() {
  const limits = useStore((s) => s.limits)
  const show = useStore((s) => s.settings.showLimits)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  useTicker(30_000, show)
  if (!show) return null
  const list = [limits.claude, limits.codex].filter((x): x is ProviderLimits => !!x)
  const now = Date.now()
  return (
    <div className="usage mw-usage">
      <button type="button" className="usage-btn" aria-expanded={open} title={t('Plan usage limits')} onClick={() => setOpen(!open)}>
        {list.map((l) => <ProviderRow key={l.provider} lim={l} />)}
        {!limits.claude && (
          <div className="usage-row usage-missing">
            <AgentAvatar kind="claude" size={16} />
            <span className="usage-name">Claude</span>
            <span className="usage-hint">{t('Turn on the status line bridge on the Mac')}</span>
          </div>
        )}
      </button>
      {open && (
        <div className="mw-usage-detail">
          {list.map((l) => (
            <div key={l.provider} className="usage-provider">
              <div className="usage-provider-head">
                <AgentAvatar kind={l.provider} size={18} />
                <span className="usage-provider-name">{NAMES[l.provider]}</span>
                {l.plan && <span className="usage-plan">{l.plan}</span>}
                {l.reached && <span className="usage-reached">{t('limit reached')}</span>}
              </div>
              {l.windows.map((w) => {
                const p = effectivePercent(w, now)
                return (
                  <div key={w.label} className="usage-detail">
                    <div className="usage-detail-top">
                      <span>{t(LABELS[w.label] ?? w.label)}</span>
                      <span className={clsx('usage-pct', `lv-${level(p)}`)}>{t('{n}% used', { n: Math.round(p) })}</span>
                    </div>
                    <Bar pct={p} />
                    <div className="usage-detail-sub">{formatReset(w.resetsAt, now)}</div>
                  </div>
                )
              })}
              {l.error && <div className="usage-error">{l.error}</div>}
              <div className="usage-updated">
                {l.provider === 'codex' ? t('From your latest Codex session · {when}', { when: ago(l.observedAt, now) }) : t('From Claude Code’s status line · {when}', { when: ago(l.observedAt, now) })}
              </div>
            </div>
          ))}
          {!limits.claude && (
            <p className="usage-detail-sub">{t('Claude Code limits appear once the status line bridge is on in Drover on your Mac: Settings → General. It reads local files only — no tokens, no network.')}</p>
          )}
          <button type="button" className="btn mw-usage-refresh" disabled={busy} onClick={async () => {
            setBusy(true)
            try { useStore.setState({ limits: await api.refreshLimits() }) } finally { setBusy(false) }
          }}>
            <RefreshCw size={15} className={clsx(busy && 'spin')} />{t('Refresh')}
          </button>
        </div>
      )}
    </div>
  )
}
