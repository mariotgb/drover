import { basename } from 'node:path'
import {
  HerdrApiError,
  type NewAgentRequest,
  type NewAgentResult,
  type PaneInfo,
  type SendPromptRequest,
  type SendPromptResult
} from '@shared/types'
import { AGENT_NAME_RE, toAgentName } from '@shared/agents'
import type { HerdrService } from './herdr/service'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Agents that turn a pasted image path into an image attachment. */
const IMAGE_PASTE_AGENTS = new Set(['claude', 'codex'])

function errResult(e: unknown): SendPromptResult {
  if (e instanceof HerdrApiError) return { ok: false, code: e.code, error: e.message }
  return { ok: false, code: 'error', error: (e as Error)?.message ?? String(e) }
}

/**
 * With `confirm`, herdr also waits until the agent visibly picks the message up
 * (working or blocked) and fails with agent_prompt_stalled otherwise. Not used
 * for chat messages: slash commands like /clear never start working.
 */
export async function sendPrompt(
  service: HerdrService,
  req: SendPromptRequest,
  opts: { confirm?: boolean; onAccepted?: () => void; requireAgent?: boolean } = {}
): Promise<SendPromptResult> {
  const paneId = req.paneId
  const text = req.text.replace(/\r\n/g, '\n')
  try {
    if (req.isShell) {
      // Plain terminal: type the command and press Enter.
      const body = [...req.imagePaths, text].filter(Boolean).join(' ')
      await service.request('pane.send_input', { pane_id: paneId, text: body, keys: ['enter'] })
      return { ok: true }
    }

    let body = text
    if (req.imagePaths.length) {
      if (req.agentKind && IMAGE_PASTE_AGENTS.has(req.agentKind)) {
        // One bracketed paste per image path, exactly like dropping a file
        // onto the terminal. The agent converts each into an [Image #N] chip.
        for (const path of req.imagePaths) {
          await service.request('pane.send_text', { pane_id: paneId, text: `\x1b[200~${path}\x1b[201~` })
          await sleep(220)
        }
        await sleep(300)
        if (body.trim()) body = ' ' + body
      } else {
        body = `${req.imagePaths.join('\n')}\n\n${body}`.trim()
      }
    }

    if (!body.trim()) {
      await service.request('agent.send_keys', { target: req.target || paneId, keys: ['enter'] })
      return { ok: true }
    }

    try {
      const wait = opts.confirm ? { until: ['working', 'blocked'], timeout_ms: 15000 } : undefined
      await service.request('agent.prompt', { target: req.target || paneId, text: body, ...(wait ? { wait } : {}) }, wait ? 30000 : 20000)
      opts.onAccepted?.()
    } catch (e) {
      if (!opts.requireAgent && e instanceof HerdrApiError && (e.code === 'agent_not_found' || e.code === 'not_found')) {
        // herdr no longer recognizes an agent here; type into the pane directly.
        await service.request('pane.send_text', { pane_id: paneId, text: `\x1b[200~${body}\x1b[201~` })
        await sleep(120)
        await service.request('pane.send_keys', { pane_id: paneId, keys: ['enter'] })
        return { ok: true }
      }
      throw e
    }
    return { ok: true }
  } catch (e) {
    const r = errResult(e)
    if (r.code === 'agent_blocked') {
      r.error = 'The agent is waiting for an answer (approval or question). Answer it first — see the terminal panel.'
    }
    return r
  }
}

function uniqueName(service: HerdrService, wanted: string): string {
  const taken = new Set((service.snapshot?.agents ?? []).map((a) => a.name).filter(Boolean) as string[])
  let base = AGENT_NAME_RE.test(wanted) ? wanted : toAgentName(wanted)
  if (!base) base = 'agent'
  if (!taken.has(base)) return base
  for (let i = 2; i < 1000; i++) {
    const cand = `${base.slice(0, 28)}-${i}`
    if (!taken.has(cand)) return cand
  }
  return `${base.slice(0, 20)}-${Date.now().toString(36)}`
}

type Readiness = 'ready' | 'blocked' | 'exited' | 'pending'

interface AgentProbe {
  agent?: string
  agent_status?: string
  launch_pending?: boolean
  interactive_ready?: boolean
}

/**
 * agent.start returns as soon as the launch command is typed. herdr keeps the
 * agent "launch pending" until it settles at its input prompt (3 s at least)
 * and rejects prompts with agent_not_ready until then, so poll agent.get the
 * same way `herdr agent start` does.
 */
export async function waitUntilInteractive(
  service: Pick<HerdrService, 'request'>,
  paneId: string,
  timeoutMs: number,
  intervalMs = 150
): Promise<Readiness> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const { agent: a } = await service.request<{ agent: AgentProbe }>('agent.get', { target: paneId }, 5000)
      if (a?.agent_status === 'blocked') return 'blocked'
      if (a?.agent_status === 'idle' || a?.agent_status === 'done') {
        if (a.interactive_ready) return 'ready'
        // No longer managed: either still running as a detected agent or gone.
        if (!a.launch_pending) return a.agent ? 'ready' : 'exited'
      }
    } catch (e) {
      if (e instanceof HerdrApiError && (e.code === 'restart_session_changed' || e.code === 'session_changed')) throw e
      /* not resolvable yet */
    }
    if (Date.now() >= deadline) return 'pending'
    await sleep(intervalMs)
  }
}

/** Sends a new agent its first message and checks that it was picked up. */
async function deliverFirstPrompt(service: HerdrService, paneId: string, kind: string | null, text: string) {
  for (let attempt = 1; ; attempt++) {
    const r = await sendPrompt(service, { paneId, target: paneId, agentKind: kind, text, imagePaths: [], isShell: false }, { confirm: true })
    // agent_not_ready means nothing was typed (e.g. a late startup dialog): safe to retry.
    if (r.ok || r.code !== 'agent_not_ready' || attempt >= 3) return r
    if ((await waitUntilInteractive(service, paneId, 30_000)) !== 'ready') return r
  }
}

function paneExists(service: HerdrService, paneId: string): boolean {
  return !service.snapshot || service.snapshot.panes.some((p) => p.pane_id === paneId)
}

/** Sends the first message once the agent gets past its startup dialog or slow start. */
function deliverWhenReady(service: HerdrService, paneId: string, kind: string | null, prompt: string) {
  void (async () => {
    const giveUp = Date.now() + 20 * 60_000
    while (Date.now() < giveUp && paneExists(service, paneId)) {
      const state = await waitUntilInteractive(service, paneId, 60_000, 1000)
      if (state === 'exited') return
      if (state === 'ready') {
        await deliverFirstPrompt(service, paneId, kind, prompt)
        return
      }
      if (state === 'blocked') {
        // Someone has to answer the dialog (folder trust, login…) first.
        const left = Math.max(1000, giveUp - Date.now())
        await service
          .request('agent.wait', { target: paneId, until: ['idle', 'done'], timeout_ms: left }, left + 10_000)
          .catch(() => sleep(1000))
      }
    }
  })().catch(() => undefined)
}

/** Pin retries, readiness probes and deferred prompts to the original connection. */
function agentConnection(service: HerdrService): HerdrService {
  const client = service.client, generation = service.connectionGeneration, session = service.sessionName
  const check = () => {
    if (client !== service.client || generation !== service.connectionGeneration || session !== service.sessionName) {
      throw new HerdrApiError('session_changed', 'The herdr connection changed during agent launch')
    }
  }
  const request: HerdrService['request'] = async (method, params, timeout) => {
    check()
    try {
      const result = await service.request(method, params, timeout)
      check()
      return result as never
    } catch (error) { check(); throw error }
  }
  return new Proxy(service, { get(target, property) {
    if (property === 'request') return request
    if (property === 'snapshot') check()
    return Reflect.get(target, property, target)
  } })
}

export async function createAgent(service: HerdrService, req: NewAgentRequest): Promise<NewAgentResult> {
  try { return await createAgentConnected(agentConnection(service), req) }
  catch (error) { const result = errResult(error); return { ok: false, code: result.code, error: result.error } }
}

async function createAgentConnected(service: HerdrService, req: NewAgentRequest): Promise<NewAgentResult> {
  let paneId: string
  let cwd = req.folder ?? undefined
  try {
    if (req.placement === 'existing' && req.splitTarget) {
      paneId = req.splitTarget
    } else if (req.worktreeBranch && req.workspaceId) {
      const res = await service.request<{ root_pane: PaneInfo; tab?: { tab_id: string } }>('worktree.create', {
        workspace_id: req.workspaceId,
        branch: req.worktreeBranch,
        focus: false
      }, 60000)
      paneId = res.root_pane.pane_id
      cwd = res.root_pane.cwd ?? cwd
    } else if (!req.workspaceId) {
      if (!req.folder) return { ok: false, error: 'Choose a project folder' }
      const res = await service.request<{ root_pane: PaneInfo; tab: { tab_id: string } }>('workspace.create', {
        cwd: req.folder,
        label: req.workspaceLabel || basename(req.folder),
        focus: false
      })
      if (!res.root_pane?.pane_id) throw new HerdrApiError('pane_creation_failed', 'herdr created the workspace but did not return a shell pane. Refresh the connection and try again.')
      paneId = res.root_pane.pane_id
      const tabLabel = req.tabLabel || req.name
      if (tabLabel) {
        await service.request('tab.rename', { tab_id: res.tab.tab_id, label: tabLabel }).catch(() => undefined)
      }
    } else if ((req.placement === 'split-right' || req.placement === 'split-down') && req.splitTarget) {
      const res = await service.request<{ pane: PaneInfo }>('pane.split', {
        target_pane_id: req.splitTarget,
        direction: req.placement === 'split-right' ? 'right' : 'down',
        ...(cwd ? { cwd } : {}),
        focus: false
      })
      paneId = res.pane.pane_id
    } else {
      const res = await service.request<{ root_pane: PaneInfo }>('tab.create', {
        workspace_id: req.workspaceId,
        ...(cwd ? { cwd } : {}),
        ...(req.tabLabel || req.name ? { label: req.tabLabel || req.name } : {}),
        focus: false
      })
      if (!res.root_pane?.pane_id) throw new HerdrApiError('pane_creation_failed', 'herdr did not return a shell pane for the new tab. Refresh the connection and try again.')
      paneId = res.root_pane.pane_id
    }
  } catch (e) {
    const r = errResult(e)
    return { ok: false, error: r.error, code: r.code }
  }

  if (!req.kind) return { ok: true, paneId }

  const name = uniqueName(service, req.name || req.kind)
  const deadline = Date.now() + 12000
  for (;;) {
    try {
      // timeout_ms is how long herdr keeps the name reserved while the agent
      // loads (MCP servers, updates); a startup dialog pauses that clock.
      await service.request(
        'agent.start',
        { name, kind: req.kind, pane_id: paneId, args: req.args, timeout_ms: 120000 },
        60000
      )
      break
    } catch (e) {
      if (e instanceof HerdrApiError) {
        if ((e.code === 'agent_pane_busy' || e.code === 'agent_start_input_failed') && Date.now() < deadline) {
          // A fresh pane's shell is still loading its rc files.
          await sleep(600)
          continue
        }
        return { ok: false, paneId, error: e.message, code: e.code }
      }
      return { ok: false, paneId, error: String(e) }
    }
  }

  const prompt = req.prompt?.trim() ? req.prompt : null
  if (!prompt) return { ok: true, paneId }
  const state = await waitUntilInteractive(service, paneId, 25000)
  if (state === 'exited') {
    return { ok: true, paneId, needsAttention: true, code: 'agent_start_failed', error: 'The agent exited right after starting.' }
  }
  if (state !== 'ready') {
    deliverWhenReady(service, paneId, req.kind, prompt)
    return { ok: true, paneId, needsAttention: state === 'blocked' }
  }
  const r = await deliverFirstPrompt(service, paneId, req.kind, prompt)
  if (!r.ok) return { ok: true, paneId, error: r.error, code: r.code, needsAttention: true }
  return { ok: true, paneId }
}
