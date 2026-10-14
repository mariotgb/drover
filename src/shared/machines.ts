/** Desktop machine management. The phone may only read MachinesStatus. */
export type MachineKind = 'direct' | 'bridged'
export type MachineOs = 'linux' | 'macos' | 'windows'
export type MachineAccess = 'full' | 'read-only' | 'projects'
export type MachineState = 'online' | 'offline' | 'checking' | 'waiting' | 'unknown'

export interface MachineError { code: string; detail?: string }
export type MachineRouteKind = 'lan' | 'internet' | 'bridge'
export interface MachineRoute {
  kind: MachineRouteKind
  address?: string
  host?: string
  port?: number
  /** Login is per route: an installer uses its dedicated account. */
  user?: string
  bridgeMachineId?: string
  state: 'ok' | 'down' | 'checking' | 'setup' | 'unknown'
  latencyMs?: number
  checkedAt?: number
  error?: MachineError
}
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
  purpose?: string
  routes?: MachineRoute[]
  activeRoute?: MachineRouteKind
  fallback?: boolean
  hostKeyPinnedAt?: number
  discoveredFrom?: 'existing' | 'scratch' | 'manual'
  origin?: 'drover' | 'herdr'
  enabled?: boolean
  route?: 'direct' | 'lan' | 'bridge'
  herdrId?: string
  herdrLabel?: string
  herdrTarget?: string
  herdrSession?: string
  herdrSynced?: boolean
  herdrSyncError?: MachineError
  nextActions?: MachineNextAction[]
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
  /** Existing local tunnel/phone route mapped without replacing credentials. */
  bridgeConnection?: { source: 'existing' | 'scratch'; users: string[]; publicUrl?: string; macTunnel: 'running' | 'stopped' | 'missing'; forwards: BridgeForward[]; managed?: boolean }
}
export interface MachinesState {
  machines: Machine[]
  bridgeMachineId: string | null
  agentsKey: { fingerprint: string; createdAt: number; publicKey: string } | null
  sshInclude: { installed: boolean; line: string; configPath: string }
}
/** Safe read-only projection; no key, Include action or install commands. */
export type MachinesStatus = Pick<MachinesState, 'machines' | 'bridgeMachineId'>
export interface HostKey { algorithm: string; fingerprint: string; known: boolean; passwordAllowed?: boolean }
export interface BridgeKeyCandidate { path: string; name: string; fingerprint: string; algorithm: string; comment: string }
export type BridgeStepId = 'connect' | 'users' | 'firewall' | 'mac_tunnel' | 'phone_site' | 'check'
export interface BridgeProgress { step: BridgeStepId; state: 'pending' | 'running' | 'done' | 'failed' | 'skipped'; error?: MachineError }
export interface BridgeForward { listenHost: string; listenPort: number; targetHost: string; targetPort: number }
/** Local metadata only. No private key contents, passwords, or network probing. */
export interface ExistingBridge {
  host: string
  port: number
  users: string[]
  publicUrl?: string
  phoneUrl?: string
  tunnelRunning: boolean
  macTunnel: 'running' | 'stopped' | 'missing'
  adminKey: boolean
  adminKeyPath?: string
  adminKeyCandidates?: BridgeKeyCandidate[]
  machineId?: string
  hostKey?: HostKey
  evidence?: { signal: 'launchagent' | 'phone_launchagent' | 'phone_url' | 'host_pin' | 'admin_reference'; detail: string }[]
}
export interface BridgeSetupReport { machineId: string; steps: BridgeProgress[]; repairSteps?: BridgeProgress[] }
export interface BridgeScratchOptions {
  host: string; port?: number; user: string; password: string; caddy: boolean; acceptedFingerprint: string
}
export interface BridgeRepairOptions {
  machineId: string; acceptedFingerprint: string; password?: string; confirmed: true
}
export interface BridgeAdoptOptions {
  acceptedFingerprint: string
  /** Administrator login for an existing key or password bootstrap; defaults to root. */
  user?: string
  /** Existing administrator private key. Mutually exclusive with password. */
  keyPath?: string
  /** One-time bootstrap only. Never persisted or logged. */
  password?: string
}
export interface DirectDraft { kind: 'direct'; name: string; host: string; port: number; user: string }
export interface BridgedDraft { kind: 'bridged'; name: string; os: MachineOs }
export interface RoutedMachineDraft { name: string; firstRoute: MachineRouteKind; host?: string; port?: number; user?: string; os?: MachineOs; alsoBridge?: boolean }
export type MachineDraft = DirectDraft | BridgedDraft | RoutedMachineDraft
export interface AddMachineRoute { kind: MachineRouteKind; host?: string; port?: number; acceptedFingerprint?: string; os?: MachineOs }
export interface MachineKeyInstallOptions { password?: string; keyPath?: string; acceptedFingerprint: string }
export interface MachinePhone { id: string; name: string; lastSeenAt: number; online: boolean }
export interface InstallCommand { command: string; expiresAt: number }
/** Checked as an exact boolean by the main process before any side effect. */
export interface MachineConfirmationOptions { confirmed: true }
export interface MachinesApi {
  state(): Promise<MachinesState>
  onChange(cb: (state: MachinesState) => void): () => void
  herdrMachines(): Promise<HerdrMachine[]>
  onHerdrMachines(cb: (machines: HerdrMachine[]) => void): () => void
  startHerdrAgent(options: StartHerdrAgentRequest): Promise<{ paneId: string }>
  openHerdrAgent(machineId: string, paneId: string): Promise<void>
  rename(id: string, name: string, options: MachineConfirmationOptions): Promise<void>
  setPurpose(id: string, purpose: string): Promise<void>
  addRoute(id: string, route: AddMachineRoute, options: MachineConfirmationOptions): Promise<HostKey | InstallCommand>
  removeRoute(id: string, kind: MachineRouteKind, options: MachineConfirmationOptions): Promise<void>
  syncHerdr(options: MachineConfirmationOptions): Promise<void>
  loginKeyCandidates(host: string): Promise<BridgeKeyCandidate[]>
  phones(): Promise<MachinePhone[]>
  movePhoneToBridge(id: string, options: MachineConfirmationOptions): Promise<void>
  setEnabled(id: string, enabled: boolean, options: MachineConfirmationOptions): Promise<void>
  enableBridgeRoute(id: string, os: MachineOs, options: MachineConfirmationOptions): Promise<Machine>
  recommendMethod(answer: MachineMethodAnswer): Promise<MachineMethodRecommendation>
  projectMachinePolicy(cwd: string): Promise<ProjectMachinePolicy>
  setProjectMachinePolicy(cwd: string, policy: ProjectMachinePolicy): Promise<void>
  /** Authentication methods can vary by login; omitted login uses the saved account or root. */
  probeHostKey(host: string, port: number, user?: string): Promise<HostKey>
  add(draft: MachineDraft): Promise<Machine>
  /** One-time password for bootstrap only; never persisted or logged. */
  installKey(id: string, options: MachineKeyInstallOptions): Promise<Machine>
  check(id: string): Promise<Machine>
  remove(id: string, options: MachineConfirmationOptions): Promise<SessionCleanupResult>
  setPermissions(id: string, permissions: MachinePermissions): Promise<void>
  setBridge(id: string, options: MachineConfirmationOptions): Promise<void>
  setupBridge(id: string, options: MachineConfirmationOptions & { caddy: boolean }): Promise<void>
  detectExistingBridge(): Promise<ExistingBridge | null>
  /** Native desktop picker; returns only the selected path, never file contents. */
  chooseBridgeKeyFile(): Promise<string | null>
  /** A fresh host-key probe and explicit desktop confirmation are required. */
  adoptExistingBridge(options?: BridgeAdoptOptions): Promise<BridgeSetupReport>
  setupBridgeFromScratch(options: BridgeScratchOptions): Promise<BridgeSetupReport>
  /** Explicitly add missing Drover grants/routes while retaining the phone bridge. */
  repairExistingBridge(options: BridgeRepairOptions): Promise<BridgeSetupReport>
  onBridgeProgress(cb: (progress: BridgeProgress) => void): () => void
  installCommand(id: string, os: MachineOs): Promise<InstallCommand>
  revokeAgentsKey(options: MachineConfirmationOptions): Promise<SessionCleanupReport[]>
  /** Invoke only after a separate explicit desktop UI confirmation. */
  addSshInclude(): Promise<void>
}

export type MachineNextAction = 'check' | 'confirm_host_key' | 'install_key' | 'run_installer' | 'setup_bridge' | 'repair_bridge' | 'enable' | 'sync_herdr' | 'open_agents'
export interface HerdrMachineAgent { paneId: string; name?: string; agent: string; status: 'working' | 'blocked' | 'idle' | 'done' | 'unknown'; title?: string; bypass?: boolean }
export interface HerdrMachineWorkspace { id: string; label: string; cwd?: string; agents: HerdrMachineAgent[] }
export interface HerdrMachine {
  id: string; label: string; target: string; host: string; enabled?: boolean; session?: string
  status: { state: 'online' | 'offline' | 'checking' | 'unknown'; latencyMs?: number; checkedAt?: number; error?: MachineError }
  herdrVersion?: string; route: 'direct' | 'lan' | 'bridge'; droverMachineId?: string; workspaces: HerdrMachineWorkspace[]
}
export interface StartHerdrAgentRequest { machineId: string; cwd?: string; agent: string; name?: string; args?: string[] }
export interface ProjectMachinePolicy { configureRoles: string[] }
export interface MachineMethodAnswer { location: 'lan' | 'public' | 'behind_router'; host?: string; hasSsh?: boolean; os?: MachineOs }
export interface MachineMethodRecommendation { method: 'direct' | 'installer'; route: 'lan' | 'direct' | 'bridge'; nextAction: MachineNextAction; reason: 'existing_ssh' | 'needs_installer' | 'needs_bridge' }
export interface HerdrSavedMachine { id: string; label: string; target: string; session: string; enabled: boolean; host?: string; port?: number; user?: string }
export interface HerdrSavedMachineStatus { id: string; label?: string; status: string; error?: string | null }
