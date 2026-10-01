import type {
  AgentKindInfo,
  AppSettings,
  ClaudeStatuslineState,
  ConnectionState,
  HerdrSessionInfo,
  HerdrSnapshot,
  LimitsState,
  LocalServer,
  NewAgentRequest,
  NewAgentResult,
  RoleTemplate,
  SendPromptRequest,
  SendPromptResult,
  TerminalFrame,
  TranscriptUpdate
} from '../shared/types'

export type ApiResult<T> = { ok: true; result: T } | { ok: false; code: string; error: string }

export interface InitPayload {
  settings: AppSettings
  connection: ConnectionState
  snapshot: HerdrSnapshot | null
  home: string
  attachmentsDir: string
  platform: string
  appVersion: string
}

export interface CliResult {
  code: number
  stdout: string
  stderr: string
}

type Unsub = () => void

export interface DroverApi {
  init(): Promise<InitPayload>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>

  request<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<ApiResult<T>>
  sessions(): Promise<HerdrSessionInfo[]>
  startServer(): Promise<boolean>
  reconnect(): Promise<void>
  herdrVersion(): Promise<string | null>
  cli(args: string[]): Promise<CliResult>
  agentKinds(): Promise<AgentKindInfo[]>
  limits(): Promise<LimitsState>
  refreshLimits(): Promise<LimitsState>
  claudeStatusline(): Promise<ClaudeStatuslineState>
  previewServers(): Promise<LocalServer[]>
  discoverRoles(cwd: string): Promise<RoleTemplate[]>
  pickBackground(kind: 'image' | 'video'): Promise<string | null>
  exportTheme(json: string, name: string): Promise<boolean>
  importTheme(): Promise<string | null>
  capturePreview(webContentsId: number, rect: { x: number; y: number; width: number; height: number }): Promise<string | null>
  setClaudeStatusline(enable: boolean): Promise<ClaudeStatuslineState>
  sendPrompt(req: SendPromptRequest): Promise<SendPromptResult>
  createAgent(req: NewAgentRequest): Promise<NewAgentResult>

  termOpen(id: string, target: string, cols: number, rows: number): Promise<{ ok: boolean; error?: string }>
  termInput(id: string, text: string): void
  termInputBytes(id: string, b64: string): void
  termResize(id: string, cols: number, rows: number): void
  termScroll(id: string, dir: 'up' | 'down', lines: number, source?: 'wheel' | 'page_key'): void
  termClose(id: string): void

  transcriptSubscribe(paneId: string): Promise<TranscriptUpdate>
  transcriptUnsubscribe(paneId: string): void

  setSelectedPane(paneId: string | null): void

  saveImage(bytes: Uint8Array, mime: string, name?: string): Promise<string>
  stageFile(path: string): Promise<string>
  pickFiles(): Promise<string[]>
  pickFolder(defaultPath?: string): Promise<string | null>
  pathForFile(file: File): string

  openPath(p: string): Promise<string>
  reveal(p: string): Promise<void>
  openExternal(url: string): Promise<void>
  openInEditor(p: string): Promise<string>

  on: {
    snapshot(fn: (s: HerdrSnapshot) => void): Unsub
    connection(fn: (c: ConnectionState) => void): Unsub
    termFrames(fn: (id: string, frames: TerminalFrame[]) => void): Unsub
    termClosed(fn: (id: string, reason: string) => void): Unsub
    transcript(fn: (u: TranscriptUpdate) => void): Unsub
    selectPane(fn: (paneId: string) => void): Unsub
    command(fn: (cmd: string) => void): Unsub
    windowFocus(fn: (focused: boolean) => void): Unsub
    limits(fn: (s: LimitsState) => void): Unsub
  }
}

declare global {
  interface Window {
    herdr: DroverApi
  }
}
