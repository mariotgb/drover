import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'
import { GRADIENTS, MONO_FONTS, THEMES } from '@shared/themes'
import { RemoteFailure } from './security'
import { validatePushPreferences, validatePushSubscription } from './push-subscription'
import { PROJECT_IMPORTANCE } from '@shared/projects'

type Check = (v: unknown) => boolean
const invalid = (): never => { throw new RemoteFailure('invalid_args', 'Invalid RPC arguments') }
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v))
const str = (max = 200, min = 0): Check => v => typeof v === 'string' && v.length >= min && v.length <= max && !v.includes('\0')
const bool: Check = v => typeof v === 'boolean'
const number = (min: number, max: number, integer = true): Check => v => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && (!integer || Number.isInteger(v))
const oneOf = (...values: unknown[]): Check => v => values.includes(v)
const nullable = (check: Check): Check => v => v === null || check(v)
const optional = (check: Check): Check => v => v === undefined || v === null || check(v)
const array = (check: Check, max = 100): Check => v => Array.isArray(v) && v.length <= max && v.every(check)
const id: Check = v => str(200, 1)(v) && /^[A-Za-z0-9:_-]+$/.test(v as string)
const terminalId: Check = v => str(200, 1)(v) && /^[A-Za-z0-9:_#-]+$/.test(v as string)
const path: Check = v => str(4096, 1)(v) && isAbsolute(v as string)
const label = str(200, 1)
const kind: Check = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v)
const name: Check = v => typeof v === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(v)
const record = (check: Check, max = 1000): Check => v => plain(v) && Object.keys(v).length <= max && Object.entries(v).every(([k, val]) => k.length <= 4096 && !['__proto__', 'prototype', 'constructor'].includes(k) && check(val))
const projectOrder: Check = v => array(path, 500)(v) && new Set(v as string[]).size === (v as string[]).length
const projectImportance: Check = v => record(oneOf(...PROJECT_IMPORTANCE), 500)(v) && Object.keys(v as object).every(path)
const shape = (fields: Record<string, Check>, required: string[] = []): Check => v => plain(v) && required.every(k => Object.hasOwn(v, k)) && Object.entries(v).every(([k, val]) => Object.hasOwn(fields, k) && fields[k](val))
const model = shape({ model: nullable(str(200)), effort: nullable(str(64)) })
const hex: Check = v => typeof v === 'string' && /^#[\da-f]{6}([\da-f]{2})?$/i.test(v)
const paletteFields = Object.fromEntries('bg surface sidebar text muted accent green red yellow blue purple cyan'.split(' ').map(k => [k, hex]))
const palette = shape({ ...paletteFields, base: oneOf('light', 'dark'), termBg: hex }, [...Object.keys(paletteFields), 'base'])
const appearance = shape({
  theme: str(100, 1), accent: nullable(hex),
  customThemes: array(shape({ id: str(100, 1), name: label, palette, custom: bool }, ['id', 'name', 'palette']), 100),
  background: shape({ kind: oneOf('none', 'gradient', 'image', 'video'), gradient: str(100), path, blur: number(0, 40), dim: number(0, 90), fit: oneOf('cover', 'contain') }, ['kind', 'blur', 'dim', 'fit']),
  glass: number(0.3, 1, false), radius: oneOf('sharp', 'default', 'round'), density: oneOf('comfortable', 'compact'), uiFont: oneOf('system', 'rounded', 'serif', 'mono'), monoFont: str(100, 1)
}, ['theme', 'accent', 'customThemes', 'background', 'glass', 'radius', 'density', 'uiFont', 'monoFont'])
const roleFields = { id: str(4096, 1), name, label, kind, args: str(8192), instructions: str(256 * 1024), source: oneOf('project', 'custom'), file: str(4096), orchestrator: bool, model: str(200), effort: str(64) }
const settingsFields: Record<string, Check> = {
  session: id, theme: oneOf('system', 'light', 'dark'), accent: oneOf('orange', 'blue', 'green', 'violet', 'graphite'),
  notifications: bool, notificationSound: bool, autoStartServer: bool, stopServerOnQuit: bool, syncFocus: bool,
  defaultAgentKind: kind, terminalFontSize: number(10, 22), chatFontSize: number(12, 20), sendWithEnter: bool,
  recentFolders: array(path, 100), sidebarWidth: number(160, 800), sidebarMode: oneOf('workspaces', 'status'),
  agentArgs: record(str(8192)), showLimits: bool, previewRecent: record(array(str(8192), 100)),
  language: oneOf('system', 'en', 'ru', 'es', 'de', 'zh'), roles: array(shape(roleFields, ['id', 'name', 'label', 'kind', 'args', 'instructions', 'source'])),
  roleOverrides: record(shape({ kind, args: str(8192), instructions: str(256 * 1024), model: str(200), effort: str(64) })),
  agentModels: record(model), agentBypass: record(bool), teamBypass: bool, agentPreviewHint: bool, appearance,
  leadOnly: bool, projectLeads: record(str(200, 1), 500),
  projectOrder, projectImportance,
  remoteEnabled: bool, remotePort: number(1024, 65535), remotePublicUrl: str(2048), remoteBehindProxy: bool
}
/** Phone settings only. Never derive this list from the desktop schema. */
const remoteSettingsFields: Record<string, Check> = {
  notifications: bool, notificationSound: bool,
  terminalFontSize: number(10, 22), chatFontSize: number(12, 20),
  language: oneOf('system', 'en', 'ru', 'es', 'de', 'zh'),
  leadOnly: bool, projectLeads: record(str(200, 1), 500),
  projectOrder, projectImportance,
  appearance: shape({
    theme: str(100, 1), accent: nullable(hex),
    background: shape({ kind: oneOf('none', 'gradient', 'image', 'video'), gradient: oneOf(...GRADIENTS.map(g => g.id)), path, blur: number(0, 40), dim: number(0, 90), fit: oneOf('cover', 'contain') }),
    glass: number(0.3, 1, false), radius: oneOf('sharp', 'default', 'round'), density: oneOf('comfortable', 'compact'),
    uiFont: oneOf('system', 'rounded', 'serif', 'mono'), monoFont: oneOf(...MONO_FONTS)
  })
}
export function validateSettingsPatch(patch: unknown, remote = false): void {
  if (!plain(patch)) return invalid()
  if (remote && Object.keys(patch).some(k => !Object.hasOwn(remoteSettingsFields, k))) throw new RemoteFailure('not_available_remotely', 'These settings are desktop-only')
  if (!shape(remote ? remoteSettingsFields : settingsFields)(patch)) invalid()
}

/** Merge only validated phone fields; resolve file selections on the Mac. */
export function remoteSettingsPatch(patch: unknown, current: AppSettings, backgroundsDir: string): Partial<AppSettings> {
  validateSettingsPatch(patch, true)
  const next = patch as Partial<AppSettings>
  if (!next.appearance) return next
  const selected = next.appearance
  const background = { ...current.appearance.background, ...selected.background }
  if (selected.theme !== undefined && selected.theme !== 'system' &&
      !THEMES.some(t => t.id === selected.theme) && !current.appearance.customThemes.some(t => t.id === selected.theme)) invalid()
  if (selected.background && (selected.background.path !== undefined || background.kind === 'image' || background.kind === 'video')) {
    try {
      const file = background.path
      if (!file || !resolve(file).startsWith(resolve(backgroundsDir) + sep) ||
          !realpathSync(file).startsWith(realpathSync(backgroundsDir) + sep) || !statSync(file).isFile()) throw new Error('outside backgrounds')
    } catch { throw new RemoteFailure('not_available_remotely', 'Select an existing Drover background') }
  }
  return { ...next, appearance: { ...current.appearance, ...selected,
    background } }
}
/** Discard corrupt persisted fields before the renderer/native theme sees them. */
export function validStoredSettings(value: unknown): Record<string, unknown> {
  if (!plain(value)) return {}
  const safe = Object.fromEntries(Object.entries(value).filter(([key, v]) => key === 'previewUrls' ? record(str(8192))(v) : settingsFields[key]?.(v) && (Object.hasOwn(DEFAULT_SETTINGS, key) || key.startsWith('remote'))))
  if (plain(value.appearance) && (value.appearance.background === undefined || plain(value.appearance.background))) {
    const migrated = { ...DEFAULT_SETTINGS.appearance, ...value.appearance, background: { ...DEFAULT_SETTINGS.appearance.background, ...(value.appearance.background as object ?? {}) } }
    if (appearance(migrated)) safe.appearance = migrated
  }
  return safe
}

const requestFields: Record<string, [Record<string, Check>, string[]]> = {
  'agent.rename': [{ target: id, name: nullable(name) }, ['target', 'name']],
  'agent.send_keys': [{ target: id, keys: array(oneOf('enter', 'esc', '1', '2', '3', 'ctrl+c'), 16) }, ['target', 'keys']],
  'pane.send_keys': [{ pane_id: id, keys: array(oneOf('enter', 'esc', '1', '2', '3', 'ctrl+c'), 16) }, ['pane_id', 'keys']],
  'pane.focus': [{ pane_id: id }, ['pane_id']], 'pane.close': [{ pane_id: id }, ['pane_id']],
  'pane.rename': [{ pane_id: id, label: nullable(label) }, ['pane_id', 'label']],
  'pane.zoom': [{ pane_id: id, mode: oneOf('toggle') }, ['pane_id', 'mode']],
  'pane.split': [{ target_pane_id: id, direction: oneOf('right', 'down'), cwd: path, focus: bool }, ['target_pane_id', 'direction']],
  'pane.move': [{ pane_id: id, destination: shape({ type: oneOf('new_tab'), workspace_id: id }, ['type', 'workspace_id']), focus: bool }, ['pane_id', 'destination']],
  'tab.rename': [{ tab_id: id, label }, ['tab_id', 'label']], 'tab.close': [{ tab_id: id }, ['tab_id']],
  'tab.create': [{ workspace_id: id, cwd: path, focus: bool }, ['workspace_id']],
  'workspace.rename': [{ workspace_id: id, label }, ['workspace_id', 'label']],
  'workspace.close': [{ workspace_id: id, close_group: bool }, ['workspace_id']],
  'worktree.create': [{ workspace_id: id, branch: v => str(200, 1)(v) && /^[\w./-]+$/.test(v as string) && !(v as string).startsWith('-') && !(v as string).includes('..'), focus: bool }, ['workspace_id', 'branch']]
}
export const REMOTE_HERDR_METHODS = Object.keys(requestFields)
export function validateHerdrRequest(args: unknown[]): void {
  const method = args[0]
  if (typeof method !== 'string' || !Object.hasOwn(requestFields, method)) throw new RemoteFailure('not_available_remotely', 'Herdr method not available remotely')
  const [fields, required] = requestFields[method]
  if (!shape(fields, required)(args[1]) || !optional(number(100, 120_000))(args[2])) invalid()
}
function positional(args: unknown[], checks: Check[], min = checks.length) {
  if (args.length < min || args.length > checks.length || !args.every((v, i) => checks[i](v))) invalid()
}
export function validateRpcArgs(method: string, args: unknown[]): void {
  switch (method) {
    case 'request': positional(args, [str(100, 1), v => plain(v), optional(number(100, 120_000))], 2); validateHerdrRequest(args); return
    case 'setSettings': positional(args, [v => plain(v)]); validateSettingsPatch(args[0], true); return
    case 'termOpen': positional(args, [terminalId, id, number(1, 1000), number(1, 500)]); return
    case 'termInput': positional(args, [terminalId, str(256 * 1024)]); return
    case 'termInputBytes': positional(args, [terminalId, v => str(256 * 1024)(v) && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v as string)]); return
    case 'termResize': positional(args, [terminalId, number(1, 1000), number(1, 500)]); return
    case 'termScroll': positional(args, [terminalId, oneOf('up', 'down'), number(1, 10000), optional(oneOf('wheel', 'page_key'))], 3); return
    case 'termClose': positional(args, [terminalId]); return
    case 'transcriptSubscribe': positional(args, [id, optional(shape({ stream: str(100, 1), revision: number(0, Number.MAX_SAFE_INTEGER) }, ['stream', 'revision']))], 1); return
    case 'transcriptUnsubscribe': positional(args, [id]); return
    case 'setSelectedPane': positional(args, [nullable(id)]); return
    case 'discoverRoles': case 'watchTasks': case 'unwatchTasks': case 'ensureBoard': positional(args, [path]); return
    case 'addTask': positional(args, [path, str(4096, 1), optional(str(200))], 2); return
    case 'updateTask': positional(args, [path, str(200, 1), shape({ status: oneOf('todo', 'in_progress', 'review', 'done', 'blocked'), assignee: str(200), title: str(4096, 1), notes: str(256 * 1024) })]); return
    case 'removeTask': positional(args, [path, str(200, 1)]); return
    case 'setAgentModel': positional(args, [id, oneOf('claude', 'codex'), model]); return
    case 'sendPrompt': positional(args, [shape({ paneId: id, target: id, agentKind: nullable(kind), text: str(256 * 1024), imagePaths: array(path, 32), isShell: bool }, ['paneId', 'target', 'agentKind', 'text', 'imagePaths', 'isShell'])]); if ((args[0] as { paneId: string }).paneId !== (args[0] as { target: string }).target) invalid(); return
    case 'createAgent': positional(args, [shape({ roleId: v => str(200, 1)(v) && /^(?:project|custom|starter):[A-Za-z0-9._/-]+$/.test(v as string) && !(v as string).includes('..'), workspaceId: nullable(id), folder: nullable(path), workspaceLabel: label, kind: nullable(kind), name: nullable(name), placement: oneOf('tab', 'split-right', 'split-down', 'workspace-root', 'existing'), splitTarget: nullable(id), tabLabel: nullable(label), args: array(str(8192), 100), prompt: str(256 * 1024), worktreeBranch: nullable(str(200, 1)) }, ['workspaceId', 'folder', 'kind', 'name', 'placement', 'args'])]); return
    case 'savePushSubscription': positional(args, [v => plain(v)]); validatePushSubscription(args[0]); return
    case 'deletePushSubscription': positional(args, [optional(str(4096, 1))], 0); return
    case 'setPushPreferences': positional(args, [v => plain(v)]); validatePushPreferences(args[0]); return
    case 'previewLink': positional(args, [shape({ paneId: id, recentId: v => str(64, 1)(v) && /^[A-Za-z0-9_-]+$/.test(v as string) })]); if (Object.keys(args[0] as object).length !== 1) invalid(); return
    case 'init': case 'sessions': case 'startServer': case 'reconnect': case 'herdrVersion': case 'agentKinds': case 'limits': case 'refreshLimits': case 'previewServers': case 'modelCatalog': case 'remoteStatus': case 'pushPublicKey': case 'pushStatus': positional(args, []); return
    default: throw new RemoteFailure('not_available_remotely', 'Method not available remotely')
  }
}
