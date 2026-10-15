import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { MACHINE_USAGE_ROLES, type Machine } from '@shared/machines'
import { privateRead, privateWrite, quote } from './ssh'
import { orderedRoutes } from './routes'

const START = '<!-- DROVER MACHINES START -->', END = '<!-- DROVER MACHINES END -->'
export function mergeMachinesPointer(current: string, pointer: string): string {
  const block = `${START}\n${pointer}\n${END}`
  const start = current.indexOf(START), end = current.indexOf(END)
  if (start >= 0 && end > start) return current.slice(0, start) + block + current.slice(end + END.length)
  return current.trimEnd() + (current.trim() ? '\n\n' : '') + block + '\n'
}
/** The agent a guide or helper answer is for. Identity is project folder + herdr name. */
export interface MachineAgent { project: string; name?: string; role?: string | null }
const folder = (path: string) => resolve(path).replace(/\/+$/, '') || '/'
/** Project scope (full/projects). */
export function machineInProject(m: Pick<Machine, 'permissions'>, project: string): boolean {
  return m.permissions.mode !== 'projects' || m.permissions.projects.some(p => folder(p) === folder(project))
}
/** Advisory "who can use it". No agent (the shared global guide) only gets unrestricted machines. */
export function machineUsable(m: Pick<Machine, 'usage'>, agent?: MachineAgent): boolean {
  const usage = m.usage
  if (!usage || usage.mode === 'all') return true
  if (!agent) return false
  if (usage.mode === 'roles') return !!agent.role && MACHINE_USAGE_ROLES.includes(agent.role)
  return !!agent.name && usage.agents.some(a => a.name === agent.name && folder(a.project) === folder(agent.project))
}
export function machineGuide(machines: Machine[], config: string, denied: Machine[] = [], global = false): string {
  const rows = machines.map(m => `- **${m.name}**: alias \`${m.alias}\`; ${m.osLabel ?? m.os ?? 'OS not checked'}; ${m.status.error?.code === 'key_not_installed' ? 'not connected yet — ask the user to Connect in Drover before SSH' : m.status.state}; routes: ${orderedRoutes(m).map(r => `${r.kind} (${r.state})`).join(' → ')}; active: ${m.activeRoute ?? 'not connected yet'}${m.fallback ? ' (fallback)' : ''}; ${m.purpose ? `purpose: ${m.purpose}; ` : ''}permission: ${m.permissions.mode === 'projects' ? 'full SSH with advisory project scope' : m.permissions.mode}${m.herdrId ? `; herdr machine: ${m.herdrId}` : ''}${m.needsReinstall ? '; reinstall required' : ''}.`)
  const unavailable = denied.map(m => global
    ? `- **${m.name}**: limited to selected agents — not available to you unless your Drover project guide lists it (ask the lead).`
    : `- **${m.name}**: not available to you (ask the lead).`)
  return `# Drover machines

Use only the machines listed here for the current project. Check their status before work.
SSH uses a dedicated revocable agents key. Never use or read management or tunnel keys, bypass host-key checks, change access controls, or copy private keys to a machine.
Use \`ssh -F ${quote(config)} <alias> <command>\`. Aliases also work without -F after the user installs the managed SSH Include.
Drover tries LAN first with a short timeout, then internet, then bridge through its jump. Check active route and fallback before work. Use \`ssh drover-<name>\` after the SSH Include is installed, or \`herdr --machine <saved-id> agent list\` for saved Herdr machines.
Configuration roles default to lead/orchestrator/DevOps; the project's policy may narrow them. Configuration requests use the local \`drover-machines\` helper supplied in your launch instructions. Drover resolves the live bound/project role and requires a native desktop confirmation. Never change the registry directly or claim a role through CLI arguments.
Helper commands: \`list\`, \`set-purpose <id> "purpose"\`, \`rename <id> <name>\`, \`set-enabled <id> <true|false>\`, \`add-route <id> "JSON"\`, \`remove-route <id> <lan|internet|bridge>\`, \`connect <id>\` \`connect-all\`, and \`set-address <id> <json>\` (JSON: kind, host, port, user). Connect uses the user's existing SSH login to install the agents key, only for machines whose host key already matches known_hosts; a new key returns \`host_key_confirmation\` (ask the user to confirm it in Drover's Machines screen) and a changed key is blocked. Never work around either.
Read-only access is enforced by a Linux filesystem/network sandbox. Selected-project scope is advisory, not a security boundary between agents sharing the same desktop account.
The user also chooses who can use each machine (all agents, only lead/orchestrator/DevOps, or selected agents). This is a rule you must follow, not a technical lock: never use a machine marked "not available to you", even if its alias works.

${[...rows, ...unavailable].join('\n') || 'No machines are available to this project.'}
`
}
export async function writeAwareness(home: string, root: string, machines: Machine[]): Promise<void> {
  const guide = join(root, 'MACHINES.md')
  const shared = machines.filter(m => m.permissions.mode !== 'projects')
  await privateWrite(guide, machineGuide(shared.filter(m => machineUsable(m)), join(root, 'ssh_config'), shared.filter(m => !machineUsable(m)), true))
  const pointer = `Before using SSH machines, read ${guide}. Use only machines listed there or in the project-specific guide supplied by Drover. Respect their permissions. Selected-project scope is advisory. Never inspect private or management keys.`
  for (const file of [join(home, '.codex', 'AGENTS.md'), join(home, '.claude', 'CLAUDE.md')]) {
    const old = await privateRead(file) ?? ''
    const next = mergeMachinesPointer(old, pointer)
    if (next !== old) await privateWrite(file, next)
  }
}
/** With an agent, the guide is per agent (project + name + role) so each launch gets the rows that match it. */
export function agentGuidePath(root: string, cwd: string, agent?: Omit<MachineAgent, 'project'>): string {
  const project = resolve(cwd)
  const key = agent ? [project, agent.name ?? '', agent.role ?? ''].join('\0') : project
  return join(root, agent ? 'agents' : 'projects', createHash('sha256').update(key).digest('hex') + '.md')
}
export async function projectMachineInstructions(root: string, machines: Machine[], cwd: string, config?: (visible: Machine[], denied: Machine[]) => Promise<string>, agent?: Omit<MachineAgent, 'project'>): Promise<string> {
  const project = resolve(cwd)
  const visible = machines.filter(m => machineInProject(m, project))
  const target = agent ? { ...agent, project } : undefined
  const allowed = visible.filter(m => machineUsable(m, target)), denied = visible.filter(m => !machineUsable(m, target))
  const guide = agentGuidePath(root, cwd, agent)
  const configPath = config ? guide + '.ssh_config' : join(root, 'ssh_config')
  if (config) await privateWrite(configPath, await config(allowed, denied))
  await privateWrite(guide, machineGuide(allowed, configPath, denied))
  return `Before using remote machines for this project, read ${guide}. Use only its listed aliases and respect permissions and who may use each machine. Do not read or use management/tunnel keys. Selected-project scope and machine usage rules are advisory.`
}
