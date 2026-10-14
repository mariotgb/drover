import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import type { Machine } from '@shared/machines'
import { privateRead, privateWrite, quote } from './ssh'
import { orderedRoutes } from './routes'

const START = '<!-- DROVER MACHINES START -->', END = '<!-- DROVER MACHINES END -->'
export function mergeMachinesPointer(current: string, pointer: string): string {
  const block = `${START}\n${pointer}\n${END}`
  const start = current.indexOf(START), end = current.indexOf(END)
  if (start >= 0 && end > start) return current.slice(0, start) + block + current.slice(end + END.length)
  return current.trimEnd() + (current.trim() ? '\n\n' : '') + block + '\n'
}
export function machineGuide(machines: Machine[], config: string): string {
  const rows = machines.map(m => `- **${m.name}**: alias \`${m.alias}\`; ${m.osLabel ?? m.os ?? 'OS not checked'}; ${m.status.state}; routes: ${orderedRoutes(m).map(r => `${r.kind} (${r.state})`).join(' → ')}; active: ${m.activeRoute ?? 'not connected yet'}${m.fallback ? ' (fallback)' : ''}; ${m.purpose ? `purpose: ${m.purpose}; ` : ''}permission: ${m.permissions.mode === 'projects' ? 'full SSH with advisory project scope' : m.permissions.mode}${m.herdrId ? `; herdr machine: ${m.herdrId}` : ''}${m.needsReinstall ? '; reinstall required' : ''}.`)
  return `# Drover machines

Use only the machines listed here for the current project. Check their status before work.
SSH uses a dedicated revocable agents key. Never use or read management or tunnel keys, bypass host-key checks, change access controls, or copy private keys to a machine.
Use \`ssh -F ${quote(config)} <alias> <command>\`. Aliases also work without -F after the user installs the managed SSH Include.
Drover tries LAN first with a short timeout, then internet, then bridge through its jump. Check active route and fallback before work. Use \`ssh drover-<name>\` after the SSH Include is installed, or \`herdr --machine <saved-id> agent list\` for saved Herdr machines.
Configuration roles default to lead/orchestrator/DevOps; the project's policy may narrow them. Configuration requests use the local \`drover-machines\` helper supplied in your launch instructions. Drover resolves the live bound/project role and requires a native desktop confirmation. Never change the registry directly or claim a role through CLI arguments.
Read-only access is enforced by a Linux filesystem/network sandbox. Selected-project scope is advisory, not a security boundary between agents sharing the same desktop account.

${rows.join('\n') || 'No machines are available to this project.'}
`
}
export async function writeAwareness(home: string, root: string, machines: Machine[]): Promise<void> {
  const guide = join(root, 'MACHINES.md')
  await privateWrite(guide, machineGuide(machines.filter(m => m.permissions.mode !== 'projects'), join(root, 'ssh_config')))
  const pointer = `Before using SSH machines, read ${guide}. Use only machines listed there or in the project-specific guide supplied by Drover. Respect their permissions. Selected-project scope is advisory. Never inspect private or management keys.`
  for (const file of [join(home, '.codex', 'AGENTS.md'), join(home, '.claude', 'CLAUDE.md')]) {
    const old = await privateRead(file) ?? ''
    const next = mergeMachinesPointer(old, pointer)
    if (next !== old) await privateWrite(file, next)
  }
}
export async function projectMachineInstructions(root: string, machines: Machine[], cwd: string, config?: (visible: Machine[]) => Promise<string>): Promise<string> {
  const project = resolve(cwd)
  const visible = machines.filter(m => m.permissions.mode !== 'projects' || m.permissions.projects.some(p => resolve(p) === project))
  const guide = join(root, 'projects', createHash('sha256').update(project).digest('hex') + '.md')
  const configPath = config ? guide + '.ssh_config' : join(root, 'ssh_config')
  if (config) await privateWrite(configPath, await config(visible))
  await privateWrite(guide, machineGuide(visible, configPath))
  return `Before using remote machines for this project, read ${guide}. Use only its listed aliases and respect permissions. Do not read or use management/tunnel keys. Selected-project scope is advisory.`
}
