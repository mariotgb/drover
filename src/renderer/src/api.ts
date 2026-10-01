import { t } from './i18n'
import type { DroverApi } from '../../preload/api'

export const api: DroverApi = window.herdr

export class CallError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message)
  }
}

/** Calls a raw herdr socket API method; throws CallError on failure. */
export async function call<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number
): Promise<T> {
  const res = await api.request<T>(method, params, timeoutMs)
  if (!res.ok) throw new CallError(res.code, res.error)
  return res.result
}

export function errorText(e: unknown): string {
  if (e instanceof CallError) return humanizeError(e.code, e.message)
  if (e instanceof Error) return e.message
  return String(e)
}

export function humanizeError(code: string | undefined, message: string | undefined): string {
  switch (code) {
    case 'agent_blocked':
      return t('The agent is waiting for your answer (approval or question). Answer it in the terminal panel first.')
    case 'agent_not_ready':
      return t('The agent is still starting. Try again in a few seconds.')
    case 'agent_prompt_stalled':
      return t('The agent did not react to the message. Check the terminal panel — the text may still be in its input box.')
    case 'agent_start_failed':
      return t('The agent exited right after starting. See the terminal panel for details.')
    case 'agent_name_taken':
      return t('An agent with this name already exists. Pick another name.')
    case 'invalid_agent_name':
      return t('Agent names must start with a letter and use only a–z, 0–9, "-" or "_" (max 32).')
    case 'agent_pane_busy':
      return t('That pane is busy (not at a shell prompt). Use a new tab instead.')
    case 'unsupported_agent_kind':
      return t('herdr does not support this agent kind.')
    case 'server_not_running':
      return t('The herdr server is not running.')
    case 'confirmation_required':
      return t('Closing this would close a worktree group. Close the project instead.')
    case 'workspace_group_close_required':
      return t('This project has linked worktrees open. Close them first, or close the whole group.')
    default:
      return message || code || 'Unknown error'
  }
}
