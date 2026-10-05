/** Drover browser/main contract. RPC method names match the preload API names.
 * JSON only: Uint8Array terminal frame data is sent as number[] on the wire.
 * Native/local-only calls fail with error.code = not_available_remotely.
 */
export const REMOTE_DEFAULT_PORT = 7780
export const REMOTE_WS_PATH = '/ws'
/** transcriptSubscribe(paneId, cursor?): full reset when unknown; otherwise a
 * delta with baseRevision=cursor.revision. Omit cursor for a cold client.
 * Stream changes on manager restart; /clear, truncation and an expired warm
 * cache invalidate old revisions. The browser adapter supplies its cursor. */
export type { TranscriptCursor } from './types'
/** Relative to the packaged out/ directory; frontend owns both web builds. */
export const REMOTE_WEB_DIRECTORY = 'web'
export const REMOTE_WEB_ENTRY = 'index.html'
/** Separate login build: only auth/** assets are served without a session. */
export const REMOTE_AUTH_ENTRY = 'auth/index.html'
export const REMOTE_SESSION_DAYS = 30
export const REMOTE_PAIRING_TTL_MS = 10 * 60 * 1000

export interface RemoteAccessSettings {
  remoteEnabled: boolean
  remotePort: number
  /** HTTPS origin, e.g. https://1-2-3-4.sslip.io; empty means http://localhost:<port>. */
  remotePublicUrl: string
  /** Trust the local Caddy tunnel's single-client X-Forwarded-For header.
   * Unset defaults to true for a public HTTPS address; explicit false persists. */
  remoteBehindProxy?: boolean
}
export const DEFAULT_REMOTE_SETTINGS: RemoteAccessSettings = {
  remoteEnabled: false, remotePort: REMOTE_DEFAULT_PORT, remotePublicUrl: ''
}

/** Pairing a phone needs a saved HTTPS hostname, not a Mac loopback URL. */
export function remotePhoneOrigin(address: string): string | null {
  try {
    const url = new URL(address.trim())
    const host = url.hostname.toLowerCase()
    if (url.protocol !== 'https:' || url.username || url.password || url.origin !== address.trim().replace(/\/$/, '') ||
        host === 'localhost' || host.endsWith('.localhost') || /^[\d.]+$/.test(host) || host.includes(':')) return null
    return url.origin
  } catch { return null }
}

export function remoteUsesProxy(settings: Pick<RemoteAccessSettings, 'remotePublicUrl' | 'remoteBehindProxy'>): boolean {
  return settings.remoteBehindProxy ?? settings.remotePublicUrl.startsWith('https://')
}

/** Explicit allowlist. Includes send-style preload calls: browser invokes them as RPC. */
export const REMOTE_METHOD_CHANNELS = {
  init: 'app:init', setSettings: 'settings:set',
  request: 'herdr:request', sessions: 'herdr:sessions', startServer: 'herdr:start-server',
  reconnect: 'herdr:reconnect', herdrVersion: 'herdr:version', agentKinds: 'agents:kinds',
  limits: 'limits:get', refreshLimits: 'limits:refresh', previewServers: 'preview:servers',
  discoverRoles: 'roles:discover', sendPrompt: 'agent:send', createAgent: 'agent:create',
  modelCatalog: 'models:catalog', watchTasks: 'tasks:watch', unwatchTasks: 'tasks:unwatch',
  ensureBoard: 'tasks:ensure', addTask: 'tasks:add', updateTask: 'tasks:update', removeTask: 'tasks:remove',
  setAgentModel: 'agent:set-model', termOpen: 'term:open', termInput: 'term:input',
  termInputBytes: 'term:input-bytes', termResize: 'term:resize', termScroll: 'term:scroll', termClose: 'term:close',
  transcriptSubscribe: 'transcript:subscribe', transcriptUnsubscribe: 'transcript:unsubscribe',
  setSelectedPane: 'app:selected-pane', remoteStatus: 'remote:status',
  pushPublicKey: 'push:key', pushStatus: 'push:status', savePushSubscription: 'push:subscribe',
  deletePushSubscription: 'push:unsubscribe', setPushPreferences: 'push:preferences',
  previewLink: 'preview:link'
} as const
export type RemoteMethod = keyof typeof REMOTE_METHOD_CHANNELS
/** request is further restricted to the renderer's explicit herdr action allowlist
 * and validated field schemas. Raw pane.read/process_info/list/snapshot are not
 * exposed: terminal content arrives only through this connection's termOpen.
 * pane.send_keys additionally requires an active terminal subscription for its pane.
 */
/** Must not be circumvented by setSettings: remote* setting keys are desktop-only. */
export const REMOTE_LOCAL_ONLY_METHODS = [
  'planAgentRestart', 'restartAgents',
  'officeInit', 'officeStop',
  'bossRoster', 'bossSettings', 'setBossSettings', 'openBoss', 'broadcastBoss',
  'cli', 'claudeStatusline', 'setClaudeStatusline', 'pickBackground', 'exportTheme', 'importTheme',
  'codexIntegrationStatus', 'codexIntegrationInstall',
  'codexDaemonRestartPlan', 'codexDaemonRestart',
  'capturePreview', 'pickPreviewFile', 'saveImage', 'stageFile', 'pickFiles', 'pickFolder',
  'pathForFile', 'openPath', 'reveal', 'openExternal', 'openInEditor',
  'setRemoteAccess', 'createRemotePairingCode', 'remoteDevices', 'revokeRemoteDevice'
] as const

export const REMOTE_EVENT_CHANNELS = [
  'herdr:snapshot', 'herdr:connection', 'term:frames', 'term:closed', 'transcript:update',
  'tasks:changed', 'app:select-pane', 'app:command', 'app:window-focus', 'limits:update', 'remote:status',
  'settings:changed'
] as const
export type RemoteEventChannel = typeof REMOTE_EVENT_CHANNELS[number]
/** Includes transport time; long backend operations keep a larger budget. */
export function remoteRpcDeadline(method: unknown, args: unknown): number {
  if (method === 'request' && Array.isArray(args) && typeof args[2] === 'number' && Number.isFinite(args[2]) && args[2] >= 100 && args[2] <= 120_000) return args[2] + 15_000
  if (method === 'createAgent') return 180_000
  return 60_000
}
export interface RemoteCall { t: 'call'; id: string; method: string; args: unknown[] }
export interface RemoteError { code: string; message: string }
/** init carries the event revision at capture time, to reject late snapshots. */
export type RemoteResult =
  | { t: 'result'; id: string; ok: true; value: unknown; stateRevision?: number }
  | { t: 'result'; id: string; ok: false; error: RemoteError; stateRevision?: number }
export interface RemoteEvent { t: 'event'; channel: RemoteEventChannel; args: unknown[]; stateRevision?: number }
/** Diagnostic only: reports a client deadline, never cancels/replays the command. */
export interface RemoteTimeout { t: 'timeout'; id: string }
export type RemoteClientMessage = RemoteCall | RemoteTimeout
export type RemoteServerMessage = RemoteResult | RemoteEvent
/** termOpen(id, ...) subscribes this WS to id; termClose(id) releases it.
 * Terminal IDs are owned per connection; other connections cannot write/close them.
 * No global subscription is needed for the other allowlisted event channels.
 */

export interface RemoteStatus extends RemoteAccessSettings {
  running: boolean
  origin: string
  localUrl: string
  connectedDevices: number
  error?: string
}
export interface RemoteDevice {
  id: string
  name: string
  createdAt: number
  lastUsedAt: number
}
export interface RemotePairingCode { code: string; expiresAt: number; url: string }
/** Additional methods exposed by desktop window.herdr; management is desktop-only. */
export interface RemoteManagementApi {
  remoteStatus(): Promise<RemoteStatus>
  setRemoteAccess(patch: Partial<RemoteAccessSettings>): Promise<RemoteStatus>
  createRemotePairingCode(): Promise<RemotePairingCode>
  remoteDevices(): Promise<RemoteDevice[]>
  revokeRemoteDevice(id: string): Promise<void>
}
export const REMOTE_MANAGEMENT_CHANNELS = {
  remoteStatus: 'remote:status', setRemoteAccess: 'remote:configure',
  createRemotePairingCode: 'remote:pair-code', remoteDevices: 'remote:devices', revokeRemoteDevice: 'remote:revoke'
} as const

/** All POST endpoints require exact allowed Origin and application/json.
 * WebAuthn response is the JSON returned by @simplewebauthn/browser (or native browser API).
 * POST success envelopes below; errors use {error:{code,message}} and HTTP 4xx.
 * challengeId identifies an expiring, single-use server-side challenge.
 * Pair code is consumed only after successful verification, expires after 10 minutes.
 * Session cookie: drover_session; HttpOnly, SameSite=Strict, Path=/, 30 days;
 * Secure on public HTTPS. No tokens belong in localStorage or WS URLs.
 */
export const REMOTE_AUTH_ROUTES = {
  session: '/auth/session', logout: '/auth/logout',
  registerOptions: '/auth/register/options', registerVerify: '/auth/register/verify',
  loginOptions: '/auth/login/options', loginVerify: '/auth/login/verify'
} as const
export interface RemoteAuthSession { authenticated: boolean; device?: RemoteDevice; expiresAt?: number }
export interface RemoteRegisterOptionsRequest { code: string; name?: string }
export interface RemoteRegisterVerifyRequest { challengeId: string; response: unknown }
export interface RemoteLoginVerifyRequest { challengeId: string; response: unknown }
export interface RemoteAuthOptionsResponse { challengeId: string; options: unknown }
export interface RemoteAuthVerifyResponse { ok: true; device: RemoteDevice }

/** Web push is opt-in per passkey device; a browser's device ID comes from its
 * authenticated session, never from request arguments. Removing a passkey
 * device removes its subscriptions/preferences. Preference changes never
 * create a subscription or request notification permission.
 */
export interface RemotePushPreferences { finished: boolean; blocked: boolean }
export const DEFAULT_PUSH_PREFERENCES: RemotePushPreferences = { finished: true, blocked: true }
/** JSON from PushSubscription.toJSON(); browser passes keys as base64url. */
export interface RemotePushSubscription {
  endpoint: string
  expirationTime?: number | null
  keys: { p256dh: string; auth: string }
}
export interface RemotePushStatus {
  subscribed: boolean
  subscriptionCount: number
  preferences: RemotePushPreferences
}
export interface RemotePushApi {
  pushPublicKey(): Promise<string>
  pushStatus(): Promise<RemotePushStatus>
  savePushSubscription(subscription: RemotePushSubscription): Promise<RemotePushStatus>
  /** No endpoint means remove all subscriptions of this authenticated device. */
  deletePushSubscription(endpoint?: string): Promise<RemotePushStatus>
  setPushPreferences(patch: Partial<RemotePushPreferences>): Promise<RemotePushStatus>
}
/** Authenticated HTTP alternatives for PWA/service worker: same cookie, exact
 * Origin and JSON rules as auth POSTs. Responses are the direct API values.
 * GET key/status, POST subscribe/unsubscribe/preferences. Unsubscribe body:
 * {endpoint?:string}; preferences body: {finished?:boolean,blocked?:boolean}.
 * Errors: {error:{code,message}}. Subscriptions require genuine browser push
 * provider HTTPS endpoints; arbitrary URLs are rejected.
 */
export const REMOTE_PUSH_ROUTES = {
  key: '/push/key', status: '/push/status', subscribe: '/push/subscribe',
  unsubscribe: '/push/unsubscribe', preferences: '/push/preferences'
} as const
/** SW receives event.data.json(); showNotification(payload.title, {body,tag,data}).
 * notificationclick should open/focus data.url (relative, same origin) and select
 * data.paneId, e.g. through ?pane=<id>. No chat/transcript content is included.
 * iOS web push requires an installed Home Screen PWA and user-initiated permission.
 */
export interface RemotePushPayload {
  title: string
  body: string
  tag: string
  data: { url: string; paneId: string; kind: 'finished' | 'blocked' }
}

/** Raw file body; POST requires the session cookie and an exact allowed Origin.
 * X-Drover-Filename is encodeURIComponent(original filename). Never accepts a path.
 * Returned paths are on the Mac and can be passed to sendPrompt.
 * GET/HEAD previewPrefix + id also requires an authenticated session.
 */
/** GET/HEAD with a session: the Mac's current image/video background (Range
 * requests supported for video). 404 when the background is a gradient or none.
 * Only files inside Drover's own backgrounds folder are ever served. */
export const REMOTE_APPEARANCE_ROUTES = { background: '/appearance/background' } as const
export const REMOTE_ATTACHMENT_ROUTES = { upload: '/attachments/upload', previewPrefix: '/attachments/files/' } as const
export const REMOTE_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024
export const REMOTE_ATTACHMENT_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/bmp,image/heic,image/heif,image/tiff,image/avif,.txt,.md,.log,.csv,.json,.yaml,.yml,.xml,.ts,.tsx,.js,.jsx,.css,.py,.sh,.toml,.ini'
export interface RemoteAttachment {
  id: string
  name: string
  path: string
  isImage: boolean
  previewUrl: string
}
/** GET /login and /pair?code=… render auth/index.html, GET /auth/assets/*
 * serves web/auth/assets/*. GET / serves web/index.html after auth (otherwise redirects
 * to /login). Remaining static files require auth. Upgrade /ws requires auth AND
 * Origin === configured public origin OR http://localhost:<remotePort>.
 * localhost is allowed for ordinary local testing; 127.0.0.1 is the bind address only.
 */

/** Phone previews of agents' pages (pane token `preview=`), served by Drover only
 * through capability links /preview/<256-bit token>/… issued by previewLink to a
 * paired device. A link is bound to one target taken from the agent's token: the
 * folder of a local HTML page, or one loopback port (HTTP and WebSocket), and
 * expires. No cookie is needed or forwarded; every answer is an opaque-origin
 * sandbox (no allow-same-origin), so a page cannot reach the Drover API. */
export const REMOTE_PREVIEW_PREFIX = '/preview/'
export const REMOTE_PREVIEW_TTL_MS = 30 * 60 * 1000
export const REMOTE_PREVIEW_CSP = 'sandbox allow-scripts allow-forms allow-popups'
export type RemotePreviewRequest = { paneId: string } | { recentId: string }
export type RemotePreviewError = 'no_preview' | 'too_long' | 'not_local' | 'unsupported' | 'not_found'
export interface RemotePreviewRecent { id: string; label: string; kind: 'http' | 'file'; at: number }
export type RemotePreviewLink =
  | { ok: true; url: string; label: string; kind: 'http' | 'file'; reachable: boolean; expiresAt: number; recent: RemotePreviewRecent[] }
  | { ok: false; code: RemotePreviewError; recent: RemotePreviewRecent[] }
export interface RemotePreviewApi {
  previewLink(request: RemotePreviewRequest): Promise<RemotePreviewLink>
}
