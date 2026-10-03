import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  Crosshair,
  ExternalLink,
  FileCode,
  FolderOpen,
  Globe,
  Laptop,
  Monitor,
  RotateCw,
  Smartphone,
  Tablet,
  X
} from 'lucide-react'
import type { LocalServer, PickedElement } from '@shared/types'
import { api } from '../api'
import { t } from '../i18n'
import { basename, type WorkspaceGroup } from '../model'
import { addElement, getModel, selectedThread, setPreviewUrl, toast, togglePreview, useStore } from '../store'
import pickerSource from '../preview/picker.js?raw'
import { displayTarget, previewTarget } from '../preview/target'
import { IconButton, Spinner } from './primitives'

const MARK = '__HERDR_PICK__'
const NO_RECENT: string[] = []

type Device = 'fill' | 'desktop' | 'tablet' | 'phone'
const DEVICE_WIDTH: Record<Device, number | null> = { fill: null, desktop: 1280, tablet: 768, phone: 390 }

interface WebviewEl extends HTMLElement {
  src: string
  loadURL(url: string): Promise<void>
  reload(): void
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  getURL(): string
  executeJavaScript(code: string): Promise<unknown>
  getWebContentsId(): number
  openDevTools(): void
}


function accentColor(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#d97757'
}

export function serversFor(servers: LocalServer[], cwd: string | null): LocalServer[] {
  if (!cwd) return servers
  const inside = servers.filter((s) => s.cwd && (s.cwd === cwd || s.cwd.startsWith(cwd + '/')))
  return inside.length ? inside : []
}

export function PreviewPanel({ group }: { group: WorkspaceGroup }) {
  const cwd = group.cwd ?? group.workspace.workspace_id
  const url = useStore((s) => s.previewUrl[cwd] ?? '')
  const recent = useStore((s) => s.settings.previewRecent[cwd] ?? NO_RECENT)
  const home = useStore((s) => s.home)
  const [dropping, setDropping] = useState(false)
  const servers = useStore((s) => s.servers)
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<WebviewEl | null>(null)
  const pickRef = useRef(false)
  const [picking, setPicking] = useState(false)
  const [address, setAddress] = useState(displayTarget(url))
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [nav, setNav] = useState({ back: false, forward: false })
  const [device, setDevice] = useState<Device>(() => (localStorage.getItem('drover:preview-device') as Device) || 'fill')
  const [width, setWidth] = useState(() => Math.max(320, Number(localStorage.getItem('drover:preview-w')) || 560))
  const lastNavigated = useRef('')

  const projectServers = serversFor(servers, group.cwd)

  const inject = useCallback(async () => {
    const wv = viewRef.current
    if (!wv) return
    try {
      await wv.executeJavaScript(`window.__herdrPickerAccent=${JSON.stringify(accentColor())};\n${pickerSource}`)
    } catch {
      /* page not ready yet; dom-ready re-injects */
    }
  }, [])

  const setPick = useCallback(
    async (on: boolean) => {
      const wv = viewRef.current
      if (on && !selectedThread()?.kind) {
        toast('info', t('Select an agent thread first — picked elements go to its chat.'))
        return
      }
      pickRef.current = on
      setPicking(on)
      if (!wv) return
      if (on) await inject()
      else await wv.executeJavaScript('window.__herdrPicker && window.__herdrPicker.disable()').catch(() => undefined)
    },
    [inject]
  )

  const onPicked = useCallback(async (element: Omit<PickedElement, 'id' | 'screenshot'>, keep: boolean) => {
    const thread = selectedThread()
    if (!thread?.kind) {
      toast('info', t('Select an agent thread first — picked elements go to its chat.'))
      return
    }
    if (!keep) {
      pickRef.current = false
      setPicking(false)
    }
    const wv = viewRef.current
    let screenshot: string | undefined
    if (wv && element.rect.width > 0 && element.rect.height > 0) {
      await new Promise((r) => setTimeout(r, 60))
      screenshot = (await api.capturePreview(wv.getWebContentsId(), element.rect).catch(() => null)) ?? undefined
    }
    addElement(thread.paneId, { ...element, id: `el${Date.now()}${Math.random().toString(36).slice(2, 6)}`, screenshot })
    window.dispatchEvent(new Event('composer:focus'))
  }, [])

  // Create the <webview> once per project panel.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const wv = document.createElement('webview') as WebviewEl
    wv.setAttribute('partition', 'persist:drover-preview')
    wv.setAttribute('webpreferences', 'contextIsolation=yes,sandbox=yes')
    wv.className = 'webview'
    // Nothing loads by default: only a page asked for in this run.
    const initial = useStore.getState().previewUrl[cwd] || ''
    wv.setAttribute('src', initial || 'about:blank')
    lastNavigated.current = initial
    host.appendChild(wv)
    viewRef.current = wv

    const updateNav = () => {
      try {
        setNav({ back: wv.canGoBack(), forward: wv.canGoForward() })
      } catch {
        /* not attached yet */
      }
    }
    const onNavigate = (e: Event) => {
      const u = (e as Event & { url: string }).url
      if (!u || u === 'about:blank') return
      lastNavigated.current = u
      setAddress(displayTarget(u))
      setPreviewUrl(cwd, u)
      setFailed(null)
      updateNav()
    }
    const onStart = () => setLoading(true)
    const onStop = () => {
      setLoading(false)
      updateNav()
    }
    const onFail = (e: Event) => {
      const ev = e as Event & { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean }
      if (!ev.isMainFrame || ev.errorCode === -3) return
      setFailed(ev.validatedURL || wv.getURL())
    }
    const onDomReady = () => {
      updateNav()
      if (pickRef.current) void inject()
    }
    const onConsole = (e: Event) => {
      const msg = (e as Event & { message: string }).message
      if (typeof msg !== 'string' || !msg.startsWith(MARK)) return
      try {
        const data = JSON.parse(msg.slice(MARK.length))
        if (data.type === 'pick') void onPicked(data.element, !!data.keep)
        else if (data.type === 'exit') {
          pickRef.current = false
          setPicking(false)
        }
      } catch {
        /* ignore */
      }
    }
    wv.addEventListener('did-navigate', onNavigate)
    wv.addEventListener('did-navigate-in-page', onNavigate)
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('did-fail-load', onFail)
    wv.addEventListener('dom-ready', onDomReady)
    wv.addEventListener('console-message', onConsole)
    return () => {
      viewRef.current = null
      wv.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd])

  // Follow URL changes coming from outside (address bar elsewhere, agents).
  useEffect(() => {
    setAddress(displayTarget(url))
    const wv = viewRef.current
    const target = url || null
    if (!wv || !target || target === lastNavigated.current) return
    lastNavigated.current = target
    setFailed(null)
    void wv.loadURL(target).catch(() => undefined)
  }, [url])

  useEffect(() => {
    const onToggle = () => void setPick(!pickRef.current)
    window.addEventListener('preview:pick-toggle', onToggle)
    return () => window.removeEventListener('preview:pick-toggle', onToggle)
  }, [setPick])

  const go = (raw: string) => {
    const target = previewTarget(raw, { cwd: group.cwd, home })
    if (!target) {
      toast('error', t('Enter an address (localhost:5173) or the path to an HTML file'))
      return
    }
    setPreviewUrl(cwd, target)
  }

  const openFile = async () => {
    const path = await api.pickPreviewFile(group.cwd ?? undefined)
    if (path) go(path)
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDropping(false)
    const file = e.dataTransfer.files[0]
    const path = file ? api.pathForFile(file) : ''
    if (path) go(path)
  }

  const deviceWidth = DEVICE_WIDTH[device]
  const noUrl = !url

  return (
    <aside className="preview" style={{ width }}>
      <div
        className="preview-resize"
        onMouseDown={(e) => {
          const startX = e.clientX
          const startW = width
          const cover = document.createElement('div')
          cover.className = 'drag-cover'
          document.body.appendChild(cover)
          const move = (ev: MouseEvent) => setWidth(Math.max(320, Math.min(window.innerWidth - 520, startW - (ev.clientX - startX))))
          const up = () => {
            window.removeEventListener('mousemove', move)
            window.removeEventListener('mouseup', up)
            cover.remove()
            setWidth((w) => {
              localStorage.setItem('drover:preview-w', String(w))
              return w
            })
          }
          window.addEventListener('mousemove', move)
          window.addEventListener('mouseup', up)
        }}
      />
      <div className="preview-bar drag">
        <IconButton size="sm" title={t('Back')} disabled={!nav.back} onClick={() => viewRef.current?.goBack()}>
          <ArrowLeft size={14} />
        </IconButton>
        <IconButton size="sm" title={t('Forward')} disabled={!nav.forward} onClick={() => viewRef.current?.goForward()}>
          <ArrowRight size={14} />
        </IconButton>
        <IconButton size="sm" title={t('Reload')} onClick={() => (noUrl ? undefined : viewRef.current?.reload())}>
          {loading ? <Spinner size={12} /> : <RotateCw size={13} />}
        </IconButton>
        <input
          className="preview-url"
          value={address}
          placeholder={t('localhost:5173 or a path to an .html file')}
          spellCheck={false}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go(address)
            if (e.key === 'Escape') setAddress(displayTarget(url))
          }}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button
          type="button"
          className={clsx('pick-btn', picking && 'active')}
          title={t('Pick an element to send to the agent (⌘⇧C)')}
          disabled={noUrl}
          onClick={() => void setPick(!picking)}
        >
          <Crosshair size={14} />
          <span>{picking ? t('Picking…') : t('Pick')}</span>
        </button>
        <div className="device-switch">
          {(
            [
              ['fill', Laptop, t('Fit panel')],
              ['desktop', Monitor, t('Desktop · 1280')],
              ['tablet', Tablet, t('Tablet · 768')],
              ['phone', Smartphone, t('Phone · 390')]
            ] as const
          ).map(([d, Icon, title]) => (
            <IconButton
              key={d}
              size="sm"
              title={title}
              active={device === d}
              onClick={() => {
                setDevice(d)
                localStorage.setItem('drover:preview-device', d)
              }}
            >
              <Icon size={13} />
            </IconButton>
          ))}
        </div>
        <IconButton size="sm" title={t('Developer tools')} disabled={noUrl} onClick={() => viewRef.current?.openDevTools()}>
          <Bug size={13} />
        </IconButton>
        <IconButton
          size="sm"
          title={t('Open in browser')}
          disabled={noUrl}
          onClick={() => void (url.startsWith('file:') ? api.openPath(displayTarget(url)) : api.openExternal(url))}
        >
          <ExternalLink size={13} />
        </IconButton>
        <IconButton size="sm" title={t('Close preview (⌘⇧P)')} onClick={() => togglePreview(group.workspace.workspace_id, false)}>
          <X size={14} />
        </IconButton>
      </div>
      {picking && <div className="pick-hint">{t('Click an element to add it to the chat · ⇧-click to pick several · Esc to stop')}</div>}
      <div
        className={clsx('preview-stage', deviceWidth && 'framed', dropping && 'dropping')}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDropping(true)
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={onDrop}
      >
        <div className="preview-frame" style={deviceWidth ? { width: deviceWidth } : undefined}>
          <div ref={hostRef} className="webview-host" />
        </div>
        {(noUrl || failed) && (
          <div className="preview-empty">
            <Globe size={26} strokeWidth={1.5} />
            <div className="preview-empty-title">
              {failed ? t('Can’t reach {url}', { url: displayTarget(failed).replace(/^https?:\/\//, '').replace(/\/$/, '') }) : t('Nothing open yet')}
            </div>
            <div className="preview-empty-sub">
              {failed
                ? t('Is the dev server running? Start it in a terminal or ask an agent to.')
                : t('Open a local HTML file or a dev server of {project}, then pick elements to send to an agent.', { project: group.workspace.label || basename(group.cwd) })}
            </div>
            {!failed && (
              <button type="button" className="btn btn-sm" onClick={() => void openFile()}>
                <FolderOpen size={13} /> {t('Open HTML file…')}
              </button>
            )}
            {projectServers.length > 0 && (
              <div className="server-list">
                {projectServers.map((s) => (
                  <button key={s.port} type="button" className="server-opt" onClick={() => go(s.url)}>
                    <span className="server-dot" />
                    <span className="server-url">localhost:{s.port}</span>
                    <span className="server-cmd">{s.command}</span>
                  </button>
                ))}
              </div>
            )}
            {failed && (
              <button type="button" className="btn btn-sm" onClick={() => viewRef.current?.reload()}>
                <RotateCw size={13} /> {t('Retry')}
              </button>
            )}
            {noUrl && recent.length > 0 && (
              <div className="server-list">
                <div className="preview-empty-label">{t('Recent')}</div>
                {recent.slice(0, 5).map((u) => (
                  <button key={u} type="button" className="server-opt" title={displayTarget(u)} onClick={() => go(u)}>
                    {u.startsWith('file:') ? <FileCode size={13} /> : <Globe size={13} />}
                    <span className="server-url">{u.startsWith('file:') ? basename(displayTarget(u)) : displayTarget(u).replace(/^https?:\/\//, '')}</span>
                    {u.startsWith('file:') && <span className="server-cmd">{displayTarget(u).split('/').slice(-2, -1)[0]}</span>}
                  </button>
                ))}
              </div>
            )}
            {noUrl && <div className="preview-empty-hint">{t('…or drop an HTML file here, or type an address or a path above')}</div>}
          </div>
        )}
      </div>
    </aside>
  )
}

/** Opens the preview for the selected thread's project, optionally at a URL. */
export function openPreviewFor(workspaceId: string, url?: string) {
  const group = getModel().groups.find((g) => g.workspace.workspace_id === workspaceId)
  if (!group) return
  if (url) setPreviewUrl(group.cwd ?? workspaceId, url)
  togglePreview(workspaceId, true)
}
