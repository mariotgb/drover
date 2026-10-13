// Settings > Machines: the UI's view of the machines store. Desktop only.
// Types come from the backend contract; this module adds UI helpers.

import { api } from './api'
import { t, tp } from './i18n'

import type { Machine, MachineError, MachineOs, MachinesApi } from '@shared/machines'
export type { SessionCleanupReport, SessionCleanupResult } from '@shared/machines'
export type { HostKey, InstallCommand, Machine, MachineAccess, MachineDraft, MachineError, MachineKind, MachineOs, MachinesApi, MachinesState } from '@shared/machines'

export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/

export function validName(name: string, taken: string[]): string | null {
  if (!name) return null
  if (!NAME_PATTERN.test(name)) return t('Use lowercase letters, digits and dashes.')
  if (taken.includes(name)) return t('A machine with this name already exists.')
  return null
}

/** Plain-language reason for a machine error code. */
export function machineErrorText(error: MachineError | undefined, machine?: Pick<Machine, 'name'> & Partial<Pick<Machine, 'kind' | 'bridgeMachineId'>>, bridge?: string): string {
  if (!error) return ''
  const name = machine?.name ?? t('the machine')
  switch (error.code) {
    case 'auth_failed': return t('The machine refused the agents key. Install it again with a one-time password.')
    case 'password_rejected': return t('Wrong password, or this user cannot sign in with a password.')
    case 'host_unreachable': return t('No route to the machine. Check the address and that it is turned on.')
    case 'timeout': return t('The machine did not answer in time. It may be off, asleep or behind a firewall.')
    case 'refused': return t('The machine answered but no SSH server is listening on this port.')
    case 'dns': return t('This address does not resolve. Check for typos.')
    case 'host_key_changed': return t('The machine’s key changed since you confirmed it. This can mean a reinstall — or someone in the middle. Drover will not connect until you check it.')
    // Backend details carry facts the generic line cannot (e.g. cleanup still pending on a retired bridge).
    case 'no_bridge': return withDetail(t('Home machines need a bridge: a server with a public IP. Add one and set it up as the bridge.'), error.detail)
    case 'bridge_down': return t('The bridge {bridge} is not reachable, so home machines cannot connect.', { bridge: bridge ?? t('server') })
    case 'tunnel_down': return t('{name} has not connected to the bridge. Check that it is on and online.', { name })
    case 'host_key_unconfirmed': return machine?.kind === 'bridged' && !machine.bridgeMachineId
      ? t('{name} answers on your home network: its SSH port is reachable. Confirm its key to finish.', { name })
      : t('{name} reached the bridge. Confirm its key to finish.', { name })
    case 'revocation_pending': return withDetail(t('The new agents key is in use, but the old one is still on {name} because it is offline. Drover removes it when {name} is back.', { name }), error.detail)
    case 'key_not_installed': return t('The agents key is not on this machine yet.')
    case 'permission_denied': return t('This user lacks the rights needed. Use an administrator account.')
    case 'unsupported_os': return t('This operating system is not supported for a bridge. Use Debian 12+ or Ubuntu 22.04+.')
    default: return error.detail || t('Something went wrong. Try again.')
  }
}

function withDetail(text: string, detail: string | undefined): string {
  return detail && !text.includes(detail) ? `${text} ${detail}` : text
}

export function osName(os: MachineOs | undefined): string {
  return os === 'macos' ? 'macOS' : os === 'windows' ? 'Windows' : os === 'linux' ? 'Linux' : ''
}

export function ago(ts: number | undefined, now = Date.now()): string {
  if (!ts) return t('never checked')
  const sec = Math.max(0, Math.round((now - ts) / 1000))
  if (sec < 60) return t('just now')
  if (sec < 3600) return t('{n} min ago', { n: Math.round(sec / 60) })
  if (sec < 86400) return t('{n} h ago', { n: Math.round(sec / 3600) })
  return t('{n} d ago', { n: Math.round(sec / 86400) })
}

/** Preload's window.herdr.machines on desktop; absent in the phone build. A test page may install a fake. */
export function machinesApi(): MachinesApi | null {
  return (window as unknown as { __droverMachinesApi?: MachinesApi }).__droverMachinesApi ?? (api as { machines?: MachinesApi }).machines ?? null
}

/** A bridged machine's tunnel is up but its host key has not been confirmed yet. */
/** A home machine with no bridge: reached directly on the home network (LAN), port 22. */
export function isLan(m: Machine): boolean {
  return m.kind === 'bridged' && !m.bridgeMachineId
}

/** Port to scan for a home machine's host key: its bridge port, or 22 on the LAN. */
export function homePort(m: Machine): number | undefined {
  return isLan(m) ? m.port ?? 22 : m.bridgePort
}

export function needsHostKey(m: Machine): boolean {
  return m.kind === 'bridged' && homePort(m) !== undefined && (m.status.error?.code === 'host_key_unconfirmed' || (!!m.status.checks?.tcp && !m.status.checks.auth))
}

/** The machine uses an account the user supplied: Drover will not end its open sessions. */
export function suppliedAccount(m: Machine): boolean {
  return m.sessionCleanup?.account === 'supplied'
}

export interface CleanupNote { tone: 'ok' | 'warn' | 'bad'; text: string }

/** Plain report after a permission change, key revoke or removal. */
export function cleanupNote(result: { terminated: number; incomplete: boolean; error?: MachineError }, name: string, supplied: boolean): CleanupNote {
  if (result.error) return { tone: 'bad', text: t('Drover could not end every agent session on {name}: {reason} Sessions already open may keep their access until they end.', { name, reason: machineErrorText(result.error, { name }) }) }
  if (result.incomplete && supplied) return { tone: 'warn', text: t('{name} uses an account you supplied, so Drover did not end its open sessions. Sessions already open may keep their access until they end. A dedicated account for agents makes this immediate.', { name }) }
  if (result.incomplete) return { tone: 'warn', text: t('Drover could not end every agent session on {name}. Sessions already open may keep their access until they end.', { name }) }
  if (!result.terminated) return { tone: 'ok', text: t('No agent sessions were open on {name}.', { name }) }
  return { tone: 'ok', text: tp({ one: 'Ended {n} agent session on {name}.', other: 'Ended {n} agent sessions on {name}.' }, result.terminated, { name }) }
}
