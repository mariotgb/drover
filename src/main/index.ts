import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  Notification,
  protocol,
  screen,
  shell,
  type IpcMainInvokeEvent
} from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AGENT_KINDS } from '@shared/agents'
import type { ModelChoice } from '@shared/models'
import {
  HerdrApiError,
  type AgentKindInfo,
  type AppSettings,
  type NewAgentRequest,
  type SendPromptRequest,
  type TranscriptUpdate
} from '@shared/types'
import { createAgent, sendPrompt } from './actions'
import { ATTACHMENTS_DIR, cleanupAttachments, CONVERT_EXTS, IMAGE_EXTS, saveImage, stageFile } from './attachments'
import { modelCatalog, switchAgentModel } from './models'
import { loginEnv, which } from './env'
import { HerdrService } from './herdr/service'
import { LimitsService } from './limits'
import { buildMenu } from './menu'
import { mt, setMainLanguage } from './i18n'
import { capturePreview, detectServers } from './preview'
import { backgroundsDir, exportTheme, fileResponse, importTheme, pickBackground, VIDEO_BG } from './appearance'
import { findTheme } from '@shared/themes'
import { discoverRoles } from './roles'
import { defaultPaths, installStatusline, statuslineState, uninstallStatusline } from './claudeStatusline'
import { SettingsStore } from './settings'
import { TerminalBridges } from './terminal'
import { TranscriptManager } from './transcripts/manager'

app.setName('Drover')

// Development overrides: an isolated profile and herdr session.
if (process.env.DROVER_USER_DATA) app.setPath('userData', process.env.DROVER_USER_DATA)

protocol.registerSchemesAsPrivileged([
  { scheme: 'hdfile', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

const userData = app.getPath('userData')
const settings = SettingsStore.at(userData)
if (process.env.DROVER_SESSION) settings.set({ session: process.env.DROVER_SESSION })
const service = new HerdrService({
  logDir: join(userData, 'logs'),
  autoStartServer: () => settings.get().autoStartServer
})

let win: BrowserWindow | null = null
let selectedPaneId: string | null = null

function send(channel: string, ...args: unknown[]) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

const bridges = new TerminalBridges({
  herdrPath: () => service.herdrPath,
  env: () => service.env,
  session: () => service.sessionName,
  send
})

const lastPoke: Record<string, number> = {}
const transcripts = new TranscriptManager(service, (u: TranscriptUpdate) => {
  send('transcript:update', u)
  // Agent activity means fresh limit snapshots on disk (Codex rollout,
  // Claude Code status line); pick them up without waiting for the timer.
  const agent = u.meta?.agent
  if (agent && !u.reset && Date.now() - (lastPoke[agent] ?? 0) > 5000) {
    lastPoke[agent] = Date.now()
    void (agent === 'codex' ? limits.refreshCodex() : limits.refreshClaude())
  }
})

const limits = new LimitsService({
  env: () => loginEnv(),
  enabled: () => settings.get().showLimits
})
limits.on('limits', (s) => send('limits:update', s))

// ---------------------------------------------------------------------------
// herdr service wiring

service.on('connection', (c) => send('herdr:connection', c))
service.on('snapshot', (s) => {
  send('herdr:snapshot', s)
  transcripts.onSnapshot(s)
  updateBadge()
})

service.on('status-change', ({ pane, from, to, name }) => {
  if (pane.agent === 'claude' && from === 'working') void limits.refreshClaude()
  const s = settings.get()
  if (!s.notifications || !Notification.isSupported()) return
  const focusedHere = win?.isFocused() && selectedPaneId === pane.pane_id
  if (focusedHere) return
  const label = name || pane.label || pane.agent || pane.pane_id
  const detail = pane.terminal_title_stripped || pane.title || ''
  let title: string | null = null
  if (to === 'done' && (from === 'working' || from === 'unknown')) title = mt('{name} finished', { name: label })
  else if (to === 'blocked') title = mt('{name} needs your input', { name: label })
  if (!title) return
  const n = new Notification({ title, body: detail, silent: !s.notificationSound })
  n.on('click', () => {
    showWindow()
    send('app:select-pane', pane.pane_id)
  })
  n.show()
})

function updateBadge() {
  if (process.platform !== 'darwin' || !app.dock) return
  const panes = service.snapshot?.panes ?? []
  const count = panes.filter((p) => p.agent_status === 'blocked' || p.agent_status === 'done').length
  app.dock.setBadge(count ? String(count) : '')
}

// ---------------------------------------------------------------------------
// window

const stateFile = join(userData, 'window-state.json')
interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
}

function loadWindowState(): WindowState {
  try {
    const st = JSON.parse(readFileSync(stateFile, 'utf8')) as WindowState
    const visible = screen.getAllDisplays().some((d) => {
      const b = d.workArea
      return st.x !== undefined && st.y !== undefined && st.x < b.x + b.width - 100 && st.y < b.y + b.height - 100 && st.x + st.width > b.x + 100 && st.y + 40 > b.y
    })
    return visible ? st : { width: st.width, height: st.height }
  } catch {
    return { width: 1360, height: 880 }
  }
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return
  const b = win.getNormalBounds()
  try {
    writeFileSync(stateFile, JSON.stringify({ ...b, maximized: win.isMaximized() }))
  } catch {
    /* ignore */
  }
}

function applyTheme(s: AppSettings) {
  const a = s.appearance
  if (a.theme === 'system') nativeTheme.themeSource = 'system'
  else nativeTheme.themeSource = findTheme(a.theme, a.customThemes)?.palette.base ?? 'system'
}

function createWindow() {
  const st = loadWindowState()
  win = new BrowserWindow({
    x: st.x,
    y: st.y,
    width: Math.max(900, st.width),
    height: Math.max(560, st.height),
    minWidth: 820,
    minHeight: 520,
    show: false,
    title: 'Drover',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 19 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
      webviewTag: true
    }
  })
  if (st.maximized) win.maximize()
  win.once('ready-to-show', () => (BACKGROUND ? win?.showInactive() : win?.show()))
  win.on('close', saveWindowState)
  win.on('closed', () => {
    bridges.closeAll()
    win = null
  })
  win.on('focus', () => {
    send('app:window-focus', true)
    service.scheduleRefresh(10)
    void limits.refresh()
  })
  win.on('blur', () => send('app:window-focus', false))
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) {
      e.preventDefault()
      if (/^https?:/i.test(url)) void shell.openExternal(url)
    }
  })
  win.webContents.on('render-process-gone', () => bridges.closeAll())
  win.webContents.on('did-start-loading', () => bridges.closeAll())

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function showWindow() {
  if (!win) createWindow()
  else {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}

// ---------------------------------------------------------------------------
// IPC

type Handler = (e: IpcMainInvokeEvent, ...args: any[]) => unknown // eslint-disable-line @typescript-eslint/no-explicit-any
const handle = (channel: string, fn: Handler) => ipcMain.handle(channel, fn)

function wrap<T>(p: Promise<T>): Promise<{ ok: true; result: T } | { ok: false; code: string; error: string }> {
  return p.then(
    (result) => ({ ok: true as const, result }),
    (e: unknown) => ({
      ok: false as const,
      code: e instanceof HerdrApiError ? e.code : 'error',
      error: e instanceof Error ? e.message : String(e)
    })
  )
}

const CLI_ALLOWED = new Set(['integration', 'plugin', 'session', 'status', 'worktree', 'notification'])

// DROVER_READONLY=1 turns the app into a pure viewer (used to test
// against a live session): no focus changes, no input, terminals observed
// instead of controlled.
const READONLY = process.env.DROVER_READONLY === '1'
/** Automated test runs: show the window without taking focus from the user's apps. */
const BACKGROUND = process.env.DROVER_BACKGROUND === '1'
const READONLY_METHODS = /^(ping|session\.snapshot|[a-z_.]+\.(list|get|read|layout|process_info|explain)|layout\.export)$/
function readonlyBlocked(method: string): boolean {
  return READONLY && !READONLY_METHODS.test(method)
}

function registerIpc() {
  handle('app:init', async () => ({
    settings: settings.get(),
    connection: service.connection,
    snapshot: service.snapshot,
    home: homedir(),
    attachmentsDir: ATTACHMENTS_DIR,
    platform: process.platform,
    appVersion: app.getVersion()
  }))

  handle('settings:set', (_e, patch: Partial<AppSettings>) => {
    const prevSession = settings.get().session
    const next = settings.set(patch)
    applyTheme(next)
    if (patch.language) {
      setMainLanguage(next.language)
      rebuildMenu()
    }
    if (patch.showLimits !== undefined) limits.start()
    if (patch.session && patch.session !== prevSession) {
      bridges.closeAll()
      transcripts.dispose()
      void service.start(next.session)
    }
    return next
  })

  handle('limits:get', () => limits.state)
  handle('limits:refresh', async () => {
    await limits.refresh()
    return limits.state
  })
  handle('preview:servers', () => detectServers())
  handle('appearance:pick-background', (_e, kind: 'image' | 'video') => pickBackground(win, kind))
  handle('appearance:export-theme', (_e, json: string, name: string) => exportTheme(win, json, name))
  handle('appearance:import-theme', () => importTheme(win))
  handle('roles:discover', (_e, cwd: string) => (typeof cwd === 'string' && cwd.startsWith('/') ? discoverRoles(cwd) : []))
  handle('preview:capture', (_e, id: number, rect: { x: number; y: number; width: number; height: number }) => capturePreview(id, rect))
  handle('claude-statusline:state', async () => statuslineState(defaultPaths(await loginEnv())))
  handle('claude-statusline:set', async (_e, enable: boolean) => {
    if (READONLY) throw new Error('read-only mode')
    const paths = defaultPaths(await loginEnv())
    if (enable) await installStatusline(paths)
    else await uninstallStatusline(paths)
    await limits.refreshClaude()
    return statuslineState(paths)
  })

  handle('herdr:request', (_e, method: string, params: Record<string, unknown>, timeoutMs?: number) =>
    readonlyBlocked(method)
      ? { ok: false, code: 'readonly', error: `read-only mode: ${method} blocked` }
      : wrap(service.request(method, params ?? {}, timeoutMs))
  )
  handle('herdr:sessions', () => service.listSessions())
  handle('herdr:start-server', () => service.startServerAndWait())
  handle('herdr:reconnect', () => service.start(settings.get().session))
  handle('herdr:version', () => service.version())
  handle('herdr:cli', async (_e, args: string[]) => {
    if (!Array.isArray(args) || !CLI_ALLOWED.has(String(args[0]))) {
      return { code: 2, stdout: '', stderr: 'command not allowed' }
    }
    return service.cli(args.map(String), 180000)
  })

  handle('agents:kinds', async (): Promise<AgentKindInfo[]> => {
    const env = service.env
    return AGENT_KINDS.map((d) => {
      const bin = d.binaries.find((b) => which(b, env)) ?? d.binaries[0]
      return { kind: d.kind, label: d.label, binary: bin, installed: !!which(bin, env), transcript: d.transcript }
    })
  })

  handle('agent:send', (_e, req: SendPromptRequest) =>
    READONLY ? { ok: false, code: 'readonly', error: 'read-only mode' } : sendPrompt(service, req)
  )
  handle('models:catalog', () => modelCatalog(service.env))
  handle('agent:set-model', async (_e, paneId: string, kind: string, choice: ModelChoice) => {
    if (READONLY) return { ok: false, code: 'readonly', error: 'read-only mode' }
    return switchAgentModel(service, paneId, kind, choice, await modelCatalog(service.env))
  })
  handle('agent:create', async (_e, req: NewAgentRequest) => {
    if (READONLY) return { ok: false, code: 'readonly', error: 'read-only mode' }
    if (req.folder) settings.addRecentFolder(req.folder)
    return createAgent(service, req)
  })

  handle('term:open', (_e, id: string, target: string, cols: number, rows: number) => bridges.open(id, target, cols, rows, READONLY))
  ipcMain.on('term:input', (_e, id: string, text: string) => bridges.input(id, text))
  ipcMain.on('term:input-bytes', (_e, id: string, b64: string) => bridges.inputBytes(id, b64))
  ipcMain.on('term:resize', (_e, id: string, cols: number, rows: number) => bridges.resize(id, cols, rows))
  ipcMain.on('term:scroll', (_e, id: string, dir: 'up' | 'down', lines: number, source?: 'wheel' | 'page_key') =>
    bridges.scroll(id, dir, lines, source)
  )
  ipcMain.on('term:close', (_e, id: string) => bridges.close(id))

  handle('transcript:subscribe', (_e, paneId: string) => transcripts.subscribe(paneId))
  ipcMain.on('transcript:unsubscribe', (_e, paneId: string) => transcripts.unsubscribe(paneId))

  ipcMain.on('app:selected-pane', (_e, paneId: string | null) => {
    selectedPaneId = paneId
  })

  handle('attach:save-image', (_e, bytes: Uint8Array, mime: string, name?: string) => saveImage(bytes, mime, name))
  handle('attach:stage', (_e, path: string) => stageFile(path))
  handle('attach:pick', async () => {
    const res = await dialog.showOpenDialog(win!, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images', extensions: [...IMAGE_EXTS, ...CONVERT_EXTS] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    return res.canceled ? [] : res.filePaths
  })
  handle('dialog:pick-folder', async (_e, defaultPath?: string) => {
    const res = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: defaultPath || homedir()
    })
    return res.canceled ? null : res.filePaths[0]
  })

  handle('shell:open-path', (_e, p: string) => shell.openPath(p))
  handle('shell:reveal', (_e, p: string) => shell.showItemInFolder(p))
  handle('shell:open-external', (_e, url: string) => {
    if (/^(https?|mailto):/i.test(url)) return shell.openExternal(url)
    return undefined
  })
  handle('shell:open-in-editor', async (_e, p: string) => {
    const env = service.env
    for (const bin of ['cursor', 'code', 'zed', 'subl']) {
      const found = which(bin, env)
      if (found) {
        const { spawn } = await import('node:child_process')
        spawn(found, [p], { env, detached: true, stdio: 'ignore' }).unref()
        return bin
      }
    }
    await shell.openPath(p)
    return 'finder'
  })
}

function rebuildMenu() {
  buildMenu(
    () => win,
    (cmd) => {
      if (!win) showWindow()
      send('app:command', cmd)
    }
  )
}

// ---------------------------------------------------------------------------
// app lifecycle

app.on('second-instance', () => showWindow())

// The preview panel is a <webview>. Lock it down: no preload, no Node, its own
// session, http(s) only, and links that open new windows go to the browser.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (event, prefs, params) => {
    delete prefs.preload
    prefs.nodeIntegration = false
    prefs.nodeIntegrationInSubFrames = false
    prefs.contextIsolation = true
    prefs.sandbox = true
    const src = params.src || 'about:blank'
    if (src !== 'about:blank' && !/^https?:/i.test(src)) event.preventDefault()
  })
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) contents.loadURL(url).catch(() => undefined)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (e, url) => {
      if (!/^(https?:|about:blank)/i.test(url)) e.preventDefault()
    })
  }
})

app.whenReady().then(() => {
  if (BACKGROUND && process.platform === 'darwin') app.setActivationPolicy('accessory')
  else if (!app.isPackaged && process.platform === 'darwin') app.dock?.setIcon(join(__dirname, '../../resources/icon.png'))
  protocol.handle('hdfile', (req) => {
    const url = new URL(req.url)
    const p = url.searchParams.get('p') ?? ''
    const ext = extname(p).slice(1).toLowerCase()
    // Images anywhere (chat attachments, agent screenshots); videos only from
    // the app's own backgrounds folder.
    const isVideo = VIDEO_BG.includes(ext) && p.startsWith(backgroundsDir() + '/')
    if (!p.startsWith('/') || p.includes('/../') || (!IMAGE_EXTS.has(ext) && !isVideo && !['avif', 'heic'].includes(ext)) || !existsSync(p)) {
      return new Response('not found', { status: 404 })
    }
    if (isVideo) return fileResponse(p, req.headers.get('range'))
    return net.fetch(pathToFileURL(p).toString())
  })

  applyTheme(settings.get())
  setMainLanguage(settings.get().language)
  registerIpc()
  rebuildMenu()
  createWindow()
  void service.start(settings.get().session)
  limits.start()
  void cleanupAttachments()

  app.on('activate', () => showWindow())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  saveWindowState()
  settings.flush()
  bridges.closeAll()
  transcripts.dispose()
  limits.stop()
  service.stop()
})
