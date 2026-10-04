import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { ExternalLink, FileText, Globe, RotateCw, X } from 'lucide-react'
import { REMOTE_PREVIEW_CSP, type RemotePreviewError, type RemotePreviewLink, type RemotePreviewRecent, type RemotePreviewRequest } from '@shared/remote'
import { api } from '../api'
import { t } from '../i18n'
import type { Thread } from '../model'
import { useModel, useStore } from '../store'
import { Spinner } from './primitives'

/** The page an agent shows, as herdr reports it (`preview=` pane token). */
export function previewToken(thread: Thread | null): string | null {
  return thread?.pane.tokens?.preview?.trim() || null
}
export function openPreview(paneId: string, recentId?: string) {
  useStore.setState({ mobilePreview: { paneId, ...(recentId ? { recentId } : {}) } })
}
const shortLabel = (raw: string) => raw.replace(/^["']|["']$/g, '').replace(/^https?:\/\//i, '')
/** The iframe never gets allow-same-origin: the page cannot reach Drover's session or API. */
const SANDBOX = REMOTE_PREVIEW_CSP.replace(/^sandbox /, '')

/** Prominent entry in an agent's chat when it has a page to show. */
export function PreviewBanner({ thread }: { thread: Thread }) {
  const raw = previewToken(thread)
  if (!raw) return null
  return (
    <button type="button" className="mw-preview-banner" onClick={() => openPreview(thread.paneId)}>
      <span className="mw-preview-banner-icon"><Globe size={18} /></span>
      <span className="mw-preview-banner-text"><strong>{t('Preview')}</strong><small>{shortLabel(raw)}</small></span>
      <span className="mw-preview-banner-open">{t('Open')}</span>
    </button>
  )
}

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; link: Extract<RemotePreviewLink, { ok: true }> }
  | { phase: 'error'; code: RemotePreviewError | 'failed'; recent: RemotePreviewRecent[] }

/** Full-screen sheet: the page through a short-lived capability link served by the Mac. */
export function PreviewSheet({ paneId, recentId, onClose }: { paneId: string; recentId?: string; onClose: () => void }) {
  const thread = useModel().byPane.get(paneId) ?? null
  const raw = previewToken(thread)
  const [current, setCurrent] = useState<RemotePreviewRequest>(recentId ? { recentId } : { paneId })
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [frame, setFrame] = useState(0)
  const load = useCallback(async (request: RemotePreviewRequest) => {
    setState({ phase: 'loading' })
    try {
      if (!api.previewLink) throw new Error('unavailable')
      const link = await api.previewLink(request)
      if (link.ok) { setState({ phase: 'ready', link }); setFrame((n) => n + 1) }
      else setState({ phase: 'error', code: link.code, recent: link.recent })
    } catch {
      setState({ phase: 'error', code: 'failed', recent: [] })
    }
  }, [])
  // A new agent page replaces the one on screen.
  const shownRaw = useRef(raw)
  useEffect(() => {
    if (raw === shownRaw.current) return
    shownRaw.current = raw
    setCurrent({ paneId })
  }, [raw, paneId])
  useEffect(() => { void load(current) }, [current, load])

  const link = state.phase === 'ready' ? state.link : null
  const recent = state.phase === 'ready' ? state.link.recent : state.phase === 'error' ? state.recent : []
  const title = link?.label ?? (raw ? shortLabel(raw) : t('Preview'))
  return (
    <div className="mw-preview">
      <header className="mw-sheet-head mw-preview-head">
        <div className="mw-sheet-side"><button type="button" className="mw-icon" aria-label={t('Close')} onClick={onClose}><X size={22} /></button></div>
        <div className="mw-sheet-title"><strong>{title}</strong><span>{[thread?.name, t('Preview')].filter(Boolean).join(' · ')}</span></div>
        <div className="mw-sheet-side end">
          {link && <a className="mw-icon" href={link.url} target="_blank" rel="noopener noreferrer" aria-label={t('Open in browser')}><ExternalLink size={20} /></a>}
          <button type="button" className="mw-icon" aria-label={t('Reload')} disabled={state.phase === 'loading'} onClick={() => void load(current)}><RotateCw size={20} /></button>
        </div>
      </header>
      {recent.length > 1 && (
        <div className="mw-preview-recent" role="group" aria-label={t('Recent')}>
          {recent.map((r) => (
            <button type="button" key={r.id} aria-pressed={r.label === link?.label} className={clsx(r.label === link?.label && 'active')} onClick={() => setCurrent({ recentId: r.id })}>
              {r.kind === 'http' ? <Globe size={14} /> : <FileText size={14} />}<span>{r.label}</span>
            </button>
          ))}
        </div>
      )}
      <div className="mw-preview-body">
        {state.phase === 'loading' && <div className="mw-preview-note" role="status"><Spinner size={20} /><p>{t('Loading preview…')}</p></div>}
        {link && (link.reachable
          ? <iframe key={frame} className="mw-preview-frame" src={link.url} title={link.label} sandbox={SANDBOX} referrerPolicy="no-referrer" />
          : <PreviewNote text={t('{url} does not respond. Start the server on your Mac and tap Reload.', { url: link.label })} onRetry={() => void load(current)} />)}
        {state.phase === 'error' && <PreviewNote text={errorText(state.code, thread?.name ?? '')} onRetry={state.code === 'failed' || state.code === 'not_found' ? () => void load(current) : undefined}
          href={state.code === 'not_local' && raw && /^https?:\/\//i.test(raw) ? raw : undefined} />}
      </div>
    </div>
  )
}

function PreviewNote({ text, onRetry, href }: { text: string; onRetry?: () => void; href?: string }) {
  let safe: string | undefined
  try { safe = href && ['http:', 'https:'].includes(new URL(href).protocol) ? href : undefined } catch { safe = undefined }
  return (
    <div className="mw-preview-note" role="status">
      <Globe size={28} />
      <p>{text}</p>
      {onRetry && <button type="button" className="btn" onClick={onRetry}><RotateCw size={16} />{t('Reload')}</button>}
      {safe && <a className="btn" href={safe} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} />{t('Open in browser')}</a>}
    </div>
  )
}

function errorText(code: RemotePreviewError | 'failed', agent: string): string {
  switch (code) {
    case 'no_preview': return t('This agent has no page to preview.')
    case 'too_long': return t('{agent} sent a path that is too long for herdr (80 characters at most). Ask it for a path relative to its folder.', { agent })
    case 'not_local': return t('This is an address on the internet; open it in the browser.')
    case 'unsupported': return t('This address cannot be shown in the preview.')
    case 'not_found': return t('The page file was not found on the Mac.')
    default: return t('Could not open the preview. Check the connection and try again.')
  }
}
