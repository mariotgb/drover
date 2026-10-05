import type { OfficeState, OfficeUpdate } from '@shared/office'
import type { BossBroadcastRequest, BossDelivery, BossOpenRequest, BossSettings } from '@shared/boss'
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { TranscriptCursor } from '@shared/types'
import type { CodexIntegrationStatus, CodexIntegrationInstallResult, CodexDaemonRestartPlan, CodexDaemonRestartResult } from '@shared/codexIntegration'
import type {
  RemoteAccessSettings, RemoteDevice, RemotePairingCode, RemoteStatus,
  RemotePushStatus, RemotePushPreferences, RemotePushSubscription
} from '@shared/remote'

type Listener = (...args: any[]) => void // eslint-disable-line @typescript-eslint/no-explicit-any

function on(channel: string, fn: Listener): () => void {
  const wrapped = (_e: IpcRendererEvent, ...args: unknown[]) => fn(...args)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const api = {
  init: () => ipcRenderer.invoke('app:init'),
  officeInit: (): Promise<OfficeState | null> => ipcRenderer.invoke('office:init'),
  officeStop: (): void => ipcRenderer.send('office:stop'),
  bossRoster: () => ipcRenderer.invoke('boss:roster'),
  bossSettings: () => ipcRenderer.invoke('boss:settings'),
  setBossSettings: (patch: Partial<BossSettings>) => ipcRenderer.invoke('boss:configure', patch),
  openBoss: (req: BossOpenRequest) => ipcRenderer.invoke('boss:open', req),
  broadcastBoss: (req: BossBroadcastRequest) => ipcRenderer.invoke('boss:broadcast', req),
  setSettings: (patch: unknown) => ipcRenderer.invoke('settings:set', patch),
  remoteStatus: (): Promise<RemoteStatus> => ipcRenderer.invoke('remote:status'),
  setRemoteAccess: (patch: Partial<RemoteAccessSettings>): Promise<RemoteStatus> => ipcRenderer.invoke('remote:configure', patch),
  createRemotePairingCode: (): Promise<RemotePairingCode> => ipcRenderer.invoke('remote:pair-code'),
  remoteDevices: (): Promise<RemoteDevice[]> => ipcRenderer.invoke('remote:devices'),
  revokeRemoteDevice: (id: string): Promise<void> => ipcRenderer.invoke('remote:revoke', id),
  pushPublicKey: (): Promise<string> => ipcRenderer.invoke('push:key'),
  pushStatus: (): Promise<RemotePushStatus> => ipcRenderer.invoke('push:status'),
  savePushSubscription: (subscription: RemotePushSubscription): Promise<RemotePushStatus> => ipcRenderer.invoke('push:subscribe', subscription),
  deletePushSubscription: (endpoint?: string): Promise<RemotePushStatus> => ipcRenderer.invoke('push:unsubscribe', endpoint),
  setPushPreferences: (patch: Partial<RemotePushPreferences>): Promise<RemotePushStatus> => ipcRenderer.invoke('push:preferences', patch),

  request: (method: string, params?: unknown, timeoutMs?: number) =>
    ipcRenderer.invoke('herdr:request', method, params ?? {}, timeoutMs),
  sessions: () => ipcRenderer.invoke('herdr:sessions'),
  startServer: () => ipcRenderer.invoke('herdr:start-server'),
  reconnect: () => ipcRenderer.invoke('herdr:reconnect'),
  herdrVersion: () => ipcRenderer.invoke('herdr:version'),
  cli: (args: string[]) => ipcRenderer.invoke('herdr:cli', args),
  codexIntegrationStatus: (): Promise<CodexIntegrationStatus> => ipcRenderer.invoke('codex:integration-status'),
  codexIntegrationInstall: (): Promise<CodexIntegrationInstallResult> => ipcRenderer.invoke('codex:integration-install'),
  codexDaemonRestartPlan: (): Promise<CodexDaemonRestartPlan> => ipcRenderer.invoke('codex:daemon-restart-plan'),
  codexDaemonRestart: (token: string): Promise<CodexDaemonRestartResult> => ipcRenderer.invoke('codex:daemon-restart', token),
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
  planAgentRestart: (selection: unknown) => ipcRenderer.invoke('agent:restart-plan', selection),
  restartAgents: (token: string) => ipcRenderer.invoke('agent:restart', token),
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

  transcriptSubscribe: (paneId: string, cursor?: TranscriptCursor) => ipcRenderer.invoke('transcript:subscribe', paneId, cursor),
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
    office: (fn: (update: OfficeUpdate) => void) => on('office:update', fn),
    bossDelivery: (fn: (delivery: BossDelivery) => void) => on('boss:delivery', fn),
    snapshot: (fn: Listener) => on('herdr:snapshot', fn),
    connection: (fn: Listener) => on('herdr:connection', fn),
    termFrames: (fn: Listener) => on('term:frames', fn),
    termClosed: (fn: Listener) => on('term:closed', fn),
    transcript: (fn: Listener) => on('transcript:update', fn),
    tasks: (fn: Listener) => on('tasks:changed', fn),
    selectPane: (fn: Listener) => on('app:select-pane', fn),
    command: (fn: Listener) => on('app:command', fn),
    windowFocus: (fn: Listener) => on('app:window-focus', fn),
    limits: (fn: Listener) => on('limits:update', fn),
    settings: (fn: Listener) => on('settings:changed', fn)
  }
}

contextBridge.exposeInMainWorld('herdr', api)

export type PreloadApi = typeof api
