/** Desktop machine management. The phone may only read MachinesStatus. */
export type MachineKind = 'direct' | 'bridged'
export type MachineOs = 'linux' | 'macos' | 'windows'
export type MachineAccess = 'full' | 'read-only' | 'projects'
export type MachineState = 'online' | 'offline' | 'checking' | 'waiting' | 'unknown'

export interface MachineError { code: string; detail?: string }
export interface BridgeCleanupState { state: 'pending' | 'running' | 'blocked'; attempts: number; nextAttemptAt: number; error?: MachineError }
export interface SessionCleanupResult { terminated: number; incomplete: boolean; error?: MachineError }
export interface SessionCleanupReport extends SessionCleanupResult { machineId: string; name: string }
export type SessionCleanupReason = 'permissions' | 'revoke' | 'remove'
export interface MachinePermissions { mode: MachineAccess; projects: string[] }
export interface MachineChecks {
  tcp: boolean
  auth: boolean
  diskAvailableBytes?: number
  memoryTotalBytes?: number
  memoryAvailableBytes?: number
  docker?: boolean
  herdr?: boolean
}
export interface Machine {
  id: string
  name: string
  kind: MachineKind
  /** Managed SSH Host alias. Use `ssh -F <managed config> <alias>`. */
  alias: string
  host?: string
  port?: number
  user: string
  os?: MachineOs
  osLabel?: string
  publicIp: boolean
  bridgeMachineId?: string
  /** Reverse SSH listener on bridge loopback only. */
  bridgePort?: number
  needsReinstall?: boolean
  /** Authenticated installer completion; host trust still needs confirmation. */
  installReport?: { reportedAt: number; fingerprint: string }
  sessionCleanup?: { account: 'dedicated' | 'supplied'; last?: SessionCleanupResult & { at: number; reason: SessionCleanupReason } }
  permissions: MachinePermissions
  status: { state: MachineState; latencyMs?: number; checkedAt?: number; error?: MachineError; checks?: MachineChecks }
  bridgeSetup?: { state: 'none' | 'running' | 'ready' | 'failed'; step?: string; checkedAt?: number; error?: MachineError; caddy?: boolean; cleanup?: BridgeCleanupState }
}
export interface MachinesState {
  machines: Machine[]
  bridgeMachineId: string | null
  agentsKey: { fingerprint: string; createdAt: number; publicKey: string } | null
  sshInclude: { installed: boolean; line: string; configPath: string }
}
/** Safe read-only projection; no key, Include action or install commands. */
export type MachinesStatus = Pick<MachinesState, 'machines' | 'bridgeMachineId'>
export interface HostKey { algorithm: string; fingerprint: string; known: boolean }
export interface DirectDraft { kind: 'direct'; name: string; host: string; port: number; user: string }
export interface BridgedDraft { kind: 'bridged'; name: string; os: MachineOs }
export type MachineDraft = DirectDraft | BridgedDraft
export interface InstallCommand { command: string; expiresAt: number }
export interface MachinesApi {
  state(): Promise<MachinesState>
  onChange(cb: (state: MachinesState) => void): () => void
  probeHostKey(host: string, port: number): Promise<HostKey>
  add(draft: MachineDraft): Promise<Machine>
  /** One-time password for bootstrap only; never persisted or logged. */
  installKey(id: string, options: { password?: string; acceptedFingerprint: string }): Promise<Machine>
  check(id: string): Promise<Machine>
  remove(id: string): Promise<SessionCleanupResult>
  setPermissions(id: string, permissions: MachinePermissions): Promise<void>
  setBridge(id: string): Promise<void>
  setupBridge(id: string, options: { caddy: boolean }): Promise<void>
  installCommand(id: string, os: MachineOs): Promise<InstallCommand>
  revokeAgentsKey(): Promise<SessionCleanupReport[]>
  /** Invoke only after a separate explicit desktop UI confirmation. */
  addSshInclude(): Promise<void>
}
