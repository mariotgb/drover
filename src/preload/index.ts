import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'

type Listener = (...args: any[]) => void // eslint-disable-line @typescript-eslint/no-explicit-any

function on(channel: string, fn: Listener): () => void {
  const wrapped = (_e: IpcRendererEvent, ...args: unknown[]) => fn(...args)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const api = {
  init: () => ipcRenderer.invoke('app:init'),
  setSettings: (patch: unknown) => ipcRenderer.invoke('settings:set', patch),

  request: (method: string, params?: unknown, timeoutMs?: number) =>
    ipcRenderer.invoke('herdr:request', method, params ?? {}, timeoutMs),
  sessions: () => ipcRenderer.invoke('herdr:sessions'),
  startServer: () => ipcRenderer.invoke('herdr:start-server'),
  reconnect: () => ipcRenderer.invoke('herdr:reconnect'),
  herdrVersion: () => ipcRenderer.invoke('herdr:version'),
  cli: (args: string[]) => ipcRenderer.invoke('herdr:cli', args),
  agentKinds: () => ipcRenderer.invoke('agents:kinds'),
  limits: () => ipcRenderer.invoke('limits:get'),
  refreshLimits: () => ipcRenderer.invoke('limits:refresh'),
  claudeStatusline: () => ipcRenderer.invoke('claude-statusline:state'),
  previewServers: () => ipcRenderer.invoke('preview:servers'),
  discoverRoles: (cwd: string) => ipcRenderer.invoke('roles:discover', cwd),
  pickBackground: (kind: 'image' | 'video') => ipcRenderer.invoke('appearance:pick-background', kind),
  exportTheme: (json: string, name: string) => ipcRenderer.invoke('appearance:export-theme', json, name),
  importTheme: () => ipcRenderer.invoke('appearance:import-theme'),
  capturePreview: (webContentsId: number, rect: unknown) => ipcRenderer.invoke('preview:capture', webContentsId, rect),
  setClaudeStatusline: (enable: boolean) => ipcRenderer.invoke('claude-statusline:set', enable),
  sendPrompt: (req: unknown) => ipcRenderer.invoke('agent:send', req),
  createAgent: (req: unknown) => ipcRenderer.invoke('agent:create', req),
  modelCatalog: () => ipcRenderer.invoke('models:catalog'),
  pickPreviewFile: (defaultPath?: string) => ipcRenderer.invoke('preview:pick-file', defaultPath),
  watchTasks: (cwd: string) => ipcRenderer.invoke('tasks:watch', cwd),
  unwatchTasks: (cwd: string) => ipcRenderer.send('tasks:unwatch', cwd),
  ensureBoard: (cwd: string) => ipcRenderer.invoke('tasks:ensure', cwd),
  addTask: (cwd: string, title: string, assignee?: string) => ipcRenderer.invoke('tasks:add', cwd, title, assignee),
  updateTask: (cwd: string, id: string, patch: unknown) => ipcRenderer.invoke('tasks:update', cwd, id, patch),
  removeTask: (cwd: string, id: string) => ipcRenderer.invoke('tasks:remove', cwd, id),
  setAgentModel: (paneId: string, kind: string, choice: unknown) => ipcRenderer.invoke('agent:set-model', paneId, kind, choice),

  termOpen: (id: string, target: string, cols: number, rows: number) =>
    ipcRenderer.invoke('term:open', id, target, cols, rows),
  termInput: (id: string, text: string) => ipcRenderer.send('term:input', id, text),
  termInputBytes: (id: string, b64: string) => ipcRenderer.send('term:input-bytes', id, b64),
  termResize: (id: string, cols: number, rows: number) => ipcRenderer.send('term:resize', id, cols, rows),
  termScroll: (id: string, dir: 'up' | 'down', lines: number, source?: 'wheel' | 'page_key') =>
    ipcRenderer.send('term:scroll', id, dir, lines, source),
  termClose: (id: string) => ipcRenderer.send('term:close', id),

  transcriptSubscribe: (paneId: string) => ipcRenderer.invoke('transcript:subscribe', paneId),
  transcriptUnsubscribe: (paneId: string) => ipcRenderer.send('transcript:unsubscribe', paneId),

  setSelectedPane: (paneId: string | null) => ipcRenderer.send('app:selected-pane', paneId),

  saveImage: (bytes: Uint8Array, mime: string, name?: string) => ipcRenderer.invoke('attach:save-image', bytes, mime, name),
  stageFile: (path: string) => ipcRenderer.invoke('attach:stage', path),
  pickFiles: () => ipcRenderer.invoke('attach:pick'),
  pickFolder: (defaultPath?: string) => ipcRenderer.invoke('dialog:pick-folder', defaultPath),
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  openPath: (p: string) => ipcRenderer.invoke('shell:open-path', p),
  reveal: (p: string) => ipcRenderer.invoke('shell:reveal', p),
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
  openInEditor: (p: string) => ipcRenderer.invoke('shell:open-in-editor', p),

  on: {
    snapshot: (fn: Listener) => on('herdr:snapshot', fn),
    connection: (fn: Listener) => on('herdr:connection', fn),
    termFrames: (fn: Listener) => on('term:frames', fn),
    termClosed: (fn: Listener) => on('term:closed', fn),
    transcript: (fn: Listener) => on('transcript:update', fn),
    tasks: (fn: Listener) => on('tasks:changed', fn),
    selectPane: (fn: Listener) => on('app:select-pane', fn),
    command: (fn: Listener) => on('app:command', fn),
    windowFocus: (fn: Listener) => on('app:window-focus', fn),
    limits: (fn: Listener) => on('limits:update', fn)
  }
}

contextBridge.exposeInMainWorld('herdr', api)

export type PreloadApi = typeof api
