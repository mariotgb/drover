import { mergeTranscript, type TranscriptState } from './transcript-state'
export type { TranscriptState } from './transcript-state'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { structuralShare } from './structural-share'
import type {
  TaskBoard,
  AgentKindInfo,
  AgentStatus,
  AppSettings,
  ConnectionState,
  HerdrSnapshot,
  LimitsState,
  LocalServer,
  PickedElement,
  TranscriptUpdate
} from '@shared/types'
import type { ModelCatalog, ModelChoice } from '@shared/models'
import { DEFAULT_SETTINGS } from '@shared/types'
import { api, call, errorText, humanizeError } from './api'
import { resolveLang, setLanguage, t } from './i18n'
import { applyAppearance } from './appearance'
import { displayTarget, isLocalTarget, previewTarget } from './preview/target'
import { attentionSort, buildModel, type Thread, type ThreadModel } from './model'

export interface Attachment {
  id: string
  path: string
  name: string
  isImage: boolean
  previewUrl?: string
}

export interface Draft {
  text: string
  attachments: Attachment[]
  elements?: PickedElement[]
}

export interface PendingMessage {
  id: string
  text: string
  images: string[]
  at: number
  state: 'sending' | 'sent' | 'error'
  error?: string
}


export interface Toast {
  id: number
  kind: 'info' | 'error' | 'success'
  text: string
  action?: { label: string; run: () => void }
}

export type DialogState =
  | { type: 'new-agent'; workspaceId?: string | null; folder?: string | null; kind?: string | null; pickFolder?: boolean; splitTarget?: string | null; paneId?: string | null }
  | { type: 'settings'; tab?: string }
  | { type: 'team'; workspaceId: string }
  | { type: 'broadcast'; workspaceId: string }
  | { type: 'boss' }
  | { type: 'boss-broadcast' }
  | { type: 'prompt'; title: string; label?: string; value: string; placeholder?: string; confirm: string; validate?: (v: string) => string | null; onSubmit: (v: string) => Promise<void> | void }
  | { type: 'confirm'; title: string; message: string; confirm: string; danger?: boolean; onConfirm: () => Promise<void> | void }

export type ViewMode = 'chat' | 'terminal'

interface State {
  ready: boolean
  mobileScreen: 'list' | 'detail'
  /** Phone web layout: left drawer, terminal sheet (pane id) and settings screen. */
  mobileDrawer: boolean
  mobileTerminal: string | null
  mobileSettings: boolean
  /** Preview sheet: the agent whose page is shown (or one of its project's recent pages). */
  mobilePreview: { paneId: string; recentId?: string } | null
  settings: AppSettings
  connection: ConnectionState
  snapshot: HerdrSnapshot | null
  home: string
  appVersion: string
  kinds: AgentKindInfo[]
  selectedPaneId: string | null
  viewMode: Record<string, ViewMode>
  drawer: Record<string, boolean>
  transcripts: Record<string, TranscriptState>
  drafts: Record<string, Draft>
  pending: Record<string, PendingMessage[]>
  workingSince: Record<string, number>
  sidebarHidden: boolean
  collapsed: Record<string, boolean>
  windowFocused: boolean
  dialog: DialogState | null
  paletteOpen: boolean
  toasts: Toast[]
  limits: LimitsState
  /** Preview panel open per workspace id (this run only: nothing opens by itself at launch). */
  previewOpen: Record<string, boolean>
  /** Page shown in each project's preview (this run only). */
  previewUrl: Record<string, string>
  servers: LocalServer[]
  /** Models each agent can run with. */
  models: ModelCatalog | null
  /** A model switch is driving the agent's menu: keep the composer from typing into it. */
  modelSwitching: Record<string, boolean>
  /** Model picked in the chat, shown until the agent's next turn reports its model. */
  modelShown: Record<string, { label: string; effort?: string; base: string | null }>
  /** Task boards by project folder. */
  boards: Record<string, TaskBoard>
  /** Workspace whose task board fills the main area. */
  boardWorkspace: string | null
}

export const useStore = create<State>(() => ({
  ready: false,
  mobileScreen: 'list',
  mobileDrawer: false,
  mobileTerminal: null,
  mobileSettings: false,
  mobilePreview: null,
  settings: DEFAULT_SETTINGS,
  connection: { status: 'connecting', session: 'default' },
  snapshot: null,
  home: '',
  appVersion: '',
  kinds: [],
  selectedPaneId: null,
  viewMode: {},
  drawer: {},
  transcripts: {},
  drafts: {},
  pending: {},
  workingSince: {},
  sidebarHidden: false,
  collapsed: loadJson('collapsed', {}),
  windowFocused: true,
  dialog: null,
  paletteOpen: false,
  toasts: [],
  limits: { claude: null, codex: null },
  previewOpen: {},
  previewUrl: {},
  servers: [],
  models: null,
  modelSwitching: {},
  modelShown: {},
  boards: {},
  boardWorkspace: null
}))

const set = useStore.setState
const get = useStore.getState

function loadJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`drover:${key}`)
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}

function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(`drover:${key}`, JSON.stringify(value))
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// derived model (memoized on snapshot identity)

let modelCache: { snap: HerdrSnapshot | null; model: ReturnType<typeof buildModel> } | null = null
function modelFor(snap: HerdrSnapshot | null) {
  if (!modelCache || modelCache.snap !== snap) modelCache = { snap, model: buildModel(snap, modelCache?.model) }
  return modelCache.model
}
export function getModel() { return modelFor(get().snapshot) }
const wholeModel = (model: ThreadModel) => model
export function useModel<T = ThreadModel>(selector: (model: ThreadModel) => T = wholeModel as (model: ThreadModel) => T): T {
  return useStore(useShallow((s) => selector(modelFor(s.snapshot))))
}
/** Pane-scoped subscriptions: another agent's snapshot keeps this value stable. */
export function useThread(paneId: string | null) { return useModel(model => paneId ? model.byPane.get(paneId) ?? null : null) }
export function useSelectedThread() { return useStore(s => s.selectedPaneId ? modelFor(s.snapshot).byPane.get(s.selectedPaneId) ?? null : null) }
export function useWorkspace(workspaceId: string | null) { return useModel(model => workspaceId ? model.groups.find(g => g.workspace.workspace_id === workspaceId) ?? null : null) }
const emptyModel = buildModel(null)
/** Closed/hidden consumers need no model updates; opening reads the latest model. */
export function useVisibleModel(visible: boolean) { return useStore(s => visible ? modelFor(s.snapshot) : emptyModel) }

export function selectedThread(): Thread | null {
  const id = get().selectedPaneId
  return id ? getModel().byPane.get(id) ?? null : null
}

// ---------------------------------------------------------------------------
// toasts

let toastSeq = 0
export function toast(kind: Toast['kind'], text: string, action?: Toast['action']) {
  const id = ++toastSeq
  set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text, action }] }))
  setTimeout(() => dismissToast(id), kind === 'error' ? 8000 : 4500)
}
export function dismissToast(id: number) {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

export async function guard<T>(p: Promise<T>, success?: string): Promise<T | undefined> {
  try {
    const r = await p
    if (success) toast('success', success)
    return r
  } catch (e) {
    toast('error', errorText(e))
    return undefined
  }
}

// ---------------------------------------------------------------------------
// settings & theme

// Our own writes answer with the saved settings; their echoes must not undo a newer optimistic value.
let settingsWrites = 0

export async function updateSettings(patch: Partial<AppSettings>) {
  const previous = get().settings
  settingsWrites++
  try {
    if (patch.language) {
      setLanguage(resolveLang(patch.language))
      modelCache = null
    }
    const optimistic = { ...get().settings, ...patch }
    set({ settings: optimistic })
    applyAppearance(optimistic)
    const next = await api.setSettings(patch)
    set({ settings: next })
    applyAppearance(next)
  } catch (error) {
    set({ settings: previous })
    setLanguage(resolveLang(previous.language))
    applyAppearance(previous)
    toast('error', t('Could not save settings: {error}', { error: error instanceof Error ? error.message : String(error) }))
  } finally {
    settingsWrites--
  }
}

/** Settings saved by another window (the Mac or a phone). */
function onSettingsChanged(next: AppSettings) {
  if (settingsWrites > 0) return
  const prev = get().settings
  if (next.language !== prev.language) {
    setLanguage(resolveLang(next.language))
    modelCache = null
  }
  set({ settings: next })
  applyAppearance(next)
}

// ---------------------------------------------------------------------------
// selection & view

export function defaultViewMode(t: Thread | null | undefined): ViewMode {
  return t && (t.kind === 'claude' || t.kind === 'codex') ? 'chat' : 'terminal'
}

export function viewModeFor(paneId: string): ViewMode {
  const explicit = get().viewMode[paneId]
  if (explicit) return explicit
  return defaultViewMode(getModel().byPane.get(paneId))
}

export function select(paneId: string | null, navigate = true) {
  if (navigate) set({ mobileScreen: paneId ? 'detail' : 'list' })
  if (get().boardWorkspace) set({ boardWorkspace: null })
  if (paneId === get().selectedPaneId) return
  set({ selectedPaneId: paneId })
  saveJson('selected', paneId)
  api.setSelectedPane(paneId)
  if (!paneId) return
  markSeen(paneId)
  // An agent that is already waiting for an answer: show its terminal right away.
  const t = getModel().byPane.get(paneId)
  if (!window.matchMedia('(max-width: 480px)').matches && t?.status === 'blocked' && viewModeFor(paneId) === 'chat') toggleDrawer(paneId, true)
}

export function markSeen(paneId: string) {
  const t = getModel().byPane.get(paneId)
  if (!t) return
  if (get().settings.syncFocus || t.status === 'done') {
    void call('pane.focus', { pane_id: paneId }).catch(() => undefined)
  }
}

export function setViewMode(paneId: string, mode: ViewMode) {
  set((s) => ({ viewMode: { ...s.viewMode, [paneId]: mode } }))
}

export function toggleDrawer(paneId: string, open?: boolean) {
  set((s) => ({ drawer: { ...s.drawer, [paneId]: open ?? !s.drawer[paneId] } }))
}

export function toggleCollapsed(key: string) {
  set((s) => {
    const collapsed = { ...s.collapsed, [key]: !s.collapsed[key] }
    saveJson('collapsed', collapsed)
    return { collapsed }
  })
}

export function orderedThreads(): Thread[] {
  const { threads } = getModel()
  return get().settings.sidebarMode === 'status' ? attentionSort(threads) : threads
}

export function stepThread(delta: number) {
  const list = orderedThreads()
  if (!list.length) return
  const cur = list.findIndex((t) => t.paneId === get().selectedPaneId)
  const next = list[(cur + delta + list.length) % list.length]
  select(next.paneId)
}

export function nextAttention() {
  const list = attentionSort(getModel().threads).filter((t) => t.status === 'blocked' || t.status === 'done')
  if (!list.length) {
    toast('info', t('No agents need attention'))
    return
  }
  const cur = list.findIndex((t) => t.paneId === get().selectedPaneId)
  select(list[(cur + 1) % list.length].paneId)
}

// ---------------------------------------------------------------------------
// drafts & pending messages

export function setDraft(paneId: string, patch: Partial<Draft>) {
  set((s) => {
    const prev = s.drafts[paneId] ?? { text: '', attachments: [] }
    return { drafts: { ...s.drafts, [paneId]: { ...prev, ...patch } } }
  })
}

export function addPending(paneId: string, msg: PendingMessage) {
  set((s) => ({ pending: { ...s.pending, [paneId]: [...(s.pending[paneId] ?? []), msg] } }))
}

export function updatePending(paneId: string, id: string, patch: Partial<PendingMessage>) {
  set((s) => ({
    pending: { ...s.pending, [paneId]: (s.pending[paneId] ?? []).map((m) => (m.id === id ? { ...m, ...patch } : m)) }
  }))
}

export function removePending(paneId: string, id: string) {
  set((s) => ({ pending: { ...s.pending, [paneId]: (s.pending[paneId] ?? []).filter((m) => m.id !== id) } }))
}

const norm = (t: string) => t.replace(/\s+/g, ' ').trim()

function reconcilePending(paneId: string, newUserTexts: string[], reset = false) {
  if (!newUserTexts.length) return
  const list = get().pending[paneId]
  if (!list?.length) return
  let rest = [...list]
  for (const text of newUserTexts) {
    const i = rest.findIndex((m) => norm(m.text) === norm(text))
    if (i >= 0) rest.splice(i, 1)
    else if (!reset) {
      const j = rest.findIndex((m) => m.state !== 'error')
      if (j >= 0) rest.splice(j, 1)
    }
  }
  if (rest.length !== list.length) set((s) => ({ pending: { ...s.pending, [paneId]: rest } }))
}

// ---------------------------------------------------------------------------
// transcripts


export function applyTranscript(u: TranscriptUpdate) {
  const previous = get().transcripts[u.paneId]
  const { next, newUsers } = mergeTranscript(previous, u)
  if (next === previous) return
  set((s) => ({ transcripts: { ...s.transcripts, [u.paneId]: next } }))
  reconcilePending(u.paneId, newUsers, u.reset)
}

// ---------------------------------------------------------------------------
// snapshot bookkeeping

function onSnapshot(snap: HerdrSnapshot) {
  snap = structuralShare(get().snapshot ?? undefined, snap)
  const prev = get().workingSince
  const workingSince: Record<string, number> = {}
  const now = Date.now()
  for (const p of snap.panes) {
    if (p.agent_status === 'working') workingSince[p.pane_id] = prev[p.pane_id] ?? now
  }
  const prevSnap = get().snapshot
  set({ snapshot: snap, workingSince: structuralShare(prev, workingSince) })
  previewTokens(prevSnap, snap)

  const selected = get().selectedPaneId
  const panes = new Set(snap.panes.map((p) => p.pane_id))
  if (!selected || !panes.has(selected)) {
    const model = getModel()
    const fallback =
      (selected && prevSnap ? neighborAfterClose(prevSnap, selected, model.threads) : null) ??
      model.threads.find((t) => t.pane.focused)?.paneId ??
      model.threads[0]?.paneId ??
      null
    if (fallback !== selected) select(fallback, false)
  }

  // Open the terminal panel when the selected agent needs an answer.
  const sel = get().selectedPaneId
  if (sel) {
    const before = prevSnap?.panes.find((p) => p.pane_id === sel)?.agent_status
    const now = snap.panes.find((p) => p.pane_id === sel)?.agent_status
    if (now === 'blocked' && before !== 'blocked' && viewModeFor(sel) === 'chat') toggleDrawer(sel, true)
    // Work that finished while the user was looking at it is already seen.
    if (now === 'done' && before !== 'done' && get().windowFocused) markSeen(sel)
  }
}

function neighborAfterClose(prev: HerdrSnapshot, closed: string, threads: Thread[]): string | null {
  const old = prev.panes.find((p) => p.pane_id === closed)
  if (!old) return null
  const sameTab = threads.find((t) => t.tabId === old.tab_id)
  if (sameTab) return sameTab.paneId
  const sameWs = threads.find((t) => t.workspaceId === old.workspace_id)
  return sameWs?.paneId ?? null
}

// ---------------------------------------------------------------------------
// preview panel

export function togglePreview(workspaceId: string, open?: boolean) {
  set((s) => ({ previewOpen: { ...s.previewOpen, [workspaceId]: open ?? !s.previewOpen[workspaceId] } }))
}

/** Shows a page in a project's preview and remembers it among the recent ones. */
export function setPreviewUrl(projectKey: string, url: string) {
  if (get().previewUrl[projectKey] === url) return
  set((s) => ({ previewUrl: { ...s.previewUrl, [projectKey]: url } }))
  const recent = get().settings.previewRecent[projectKey] ?? []
  if (recent[0] === url) return
  const next = [url, ...recent.filter((u) => u !== url)].slice(0, 8)
  void updateSettings({ previewRecent: { ...get().settings.previewRecent, [projectKey]: next } })
}

export function addElement(paneId: string, el: PickedElement) {
  const cur = get().drafts[paneId]?.elements ?? []
  setDraft(paneId, { elements: [...cur, el] })
}

export function removeElement(paneId: string, id: string) {
  const cur = get().drafts[paneId]?.elements ?? []
  setDraft(paneId, { elements: cur.filter((e) => e.id !== id) })
}

let serverTimer: ReturnType<typeof setInterval> | null = null
async function pollServers() {
  if (!get().windowFocused) return
  try {
    const servers = await api.previewServers()
    const prev = get().servers
    if (JSON.stringify(prev) !== JSON.stringify(servers)) set({ servers })
  } catch {
    /* ignore */
  }
}

/**
 * Agents open the preview by tagging their pane through herdr:
 *   herdr pane report-metadata "$HERDR_PANE_ID" --source drover --token preview=<url>
 */
function previewTokens(prevSnap: HerdrSnapshot | null, snap: HerdrSnapshot) {
  const before = new Map((prevSnap?.panes ?? []).map((p) => [p.pane_id, p.tokens?.preview]))
  for (const p of snap.panes) {
    const url = p.tokens?.preview
    if (!url || before.get(p.pane_id) === url || !prevSnap) continue
    const group = getModel().groups.find((g) => g.workspace.workspace_id === p.workspace_id)
    if (!group) continue
    const who = getModel().byPane.get(p.pane_id)?.name ?? p.pane_id
    // herdr keeps 80 characters of a token: a longer path arrives cut off.
    if ([...url].length >= 80 && !/^https?:\/\//i.test(url)) {
      toast('info', t('{agent} sent a path that is too long for herdr (80 characters at most). Ask it for a path relative to its folder.', { agent: who }))
      continue
    }
    const target = previewTarget(url, { cwd: p.foreground_cwd ?? p.cwd ?? group.cwd, home: get().home })
    if (!target) continue
    const shown = displayTarget(target).replace(/^https?:\/\//, '')
    const key = group.cwd ?? group.workspace.workspace_id
    // Local dev servers and files open right away; pages on the internet only on request.
    if (!isLocalTarget(target)) {
      toast('info', t('{agent} wants to show {url}', { agent: who, url: shown }), {
        label: t('Open'),
        run: () => {
          setPreviewUrl(key, target)
          togglePreview(p.workspace_id, true)
        }
      })
      continue
    }
    setPreviewUrl(key, target)
    togglePreview(p.workspace_id, true)
    toast('info', t('{agent} opened {url} in the preview', { agent: who, url: shown }), {
      label: t('Show'),
      run: () => select(p.pane_id)
    })
  }
}

// ---------------------------------------------------------------------------
// bootstrap

export async function refreshKinds() {
  try {
    set({ kinds: await api.agentKinds() })
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// task boards

const boardRefs = new Map<string, number>()

/** Follows a project's task board while something on screen shows it. */
export function watchBoard(cwd: string): () => void {
  const n = boardRefs.get(cwd) ?? 0
  boardRefs.set(cwd, n + 1)
  if (n === 0) {
    void api.watchTasks(cwd).then((b) => {
      if (b) set((s) => ({ boards: { ...s.boards, [cwd]: b } }))
    })
  }
  return () => {
    const left = (boardRefs.get(cwd) ?? 1) - 1
    if (left > 0) boardRefs.set(cwd, left)
    else {
      boardRefs.delete(cwd)
      api.unwatchTasks(cwd)
    }
  }
}

export function openBoard(workspaceId: string) {
  set({ boardWorkspace: workspaceId, mobileScreen: 'detail' })
}

export function closeBoard() {
  set({ boardWorkspace: null, mobileScreen: 'list' })
}

export async function refreshModels() {
  try {
    set({ models: await api.modelCatalog() })
  } catch {
    /* ignore */
  }
}

/** Switches a running agent's model for this chat only (its defaults stay as they are). */
export async function switchModel(thread: Thread, choice: ModelChoice, shown: { label: string; effort?: string }): Promise<boolean> {
  const paneId = thread.paneId
  if (!thread.kind || get().modelSwitching[paneId]) return false
  set((s) => ({ modelSwitching: { ...s.modelSwitching, [paneId]: true } }))
  try {
    const r = await api.setAgentModel(paneId, thread.kind, choice)
    if (!r.ok) {
      toast('error', t('Could not switch the model: {error}', { error: humanizeError(r.code, r.error) }))
      return false
    }
    const base = get().transcripts[paneId]?.meta?.model ?? null
    // Claude Code confirms with the exact model behind an alias ("Set model to Opus 5.5 …").
    const exact = r.message?.match(/^Set model to (.+?) for this session only/)?.[1]
    if (exact && !/^default\b/i.test(exact)) shown = { ...shown, label: exact }
    set((s) => ({ modelShown: { ...s.modelShown, [paneId]: { ...shown, base } } }))
    toast('success', t('This chat now uses {model}', { model: shown.effort ? `${shown.label} · ${shown.effort}` : shown.label }))
    return true
  } finally {
    set((s) => ({ modelSwitching: { ...s.modelSwitching, [paneId]: false } }))
  }
}

export async function bootstrap() {
  const init = await api.init()
  setLanguage(resolveLang(init.settings.language))
  applyAppearance(init.settings)
  set({
    settings: init.settings,
    connection: init.connection,
    snapshot: init.snapshot,
    home: init.home,
    appVersion: init.appVersion,
    selectedPaneId: loadJson<string | null>('selected', null),
    ready: true
  })
  api.setSelectedPane(get().selectedPaneId)
  if (init.snapshot) onSnapshot(init.snapshot)

  api.on.snapshot((s) => onSnapshot(s))
  api.on.connection((c) => {
    const prev = get().connection
    const was = prev.status
    if (c.session !== prev.session) {
      // Pane ids like w1:p1 repeat across herdr sessions: drop per-pane state.
      set({ snapshot: null, selectedPaneId: null, transcripts: {}, pending: {}, drafts: {}, viewMode: {}, drawer: {}, workingSince: {}, modelSwitching: {}, modelShown: {}, boardWorkspace: null })
      saveJson('selected', null)
      api.setSelectedPane(null)
    }
    set({ connection: c })
    if (c.status !== was && c.status !== 'connecting' && c.status !== 'starting-server') void refreshKinds()
  })
  api.on.transcript((u) => applyTranscript(u))
  api.on.selectPane((id) => {
    select(id)
  })
  api.on.limits((l) => set({ limits: l }))
  api.on.settings((next) => onSettingsChanged(next))
  void refreshModels()
  api.on.tasks((b) => set((s) => ({ boards: { ...s.boards, [b.cwd]: b } })))
  void api.limits().then((l) => set({ limits: l }))
  api.on.windowFocus((focused) => {
    set({ windowFocused: focused })
    if (focused) void pollServers()
    const sel = get().selectedPaneId
    if (focused && sel) {
      const t = getModel().byPane.get(sel)
      if (t?.status === 'done') markSeen(sel)
    }
  })
  void refreshKinds()
  void pollServers()
  if (!serverTimer) serverTimer = setInterval(() => void pollServers(), 10_000)
}

export function statusCounts(): Record<AgentStatus, number> {
  const counts: Record<AgentStatus, number> = { working: 0, blocked: 0, done: 0, idle: 0, unknown: 0 }
  for (const t of getModel().threads) if (t.kind) counts[t.status]++
  return counts
}
