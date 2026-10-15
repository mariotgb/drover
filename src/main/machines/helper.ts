import { chmod, unlink } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MachinesFailure, privateWrite, quote, sshError } from './ssh'
import type { AgentInfo } from '@shared/types'
import type { HostKey, MachineConnectResult } from '@shared/machines'
import type { ApprovedMachineConnect, MachinesService } from './service'
import { machineInProject, machineUsable, type MachineAgent } from './awareness'

const SOURCE = String.raw`const fs=require('node:fs'),net=require('node:net'),path=require('node:path');
const config=JSON.parse(fs.readFileSync(path.join(__dirname,'runtime.json'),'utf8'));
const [action,...args]=process.argv.slice(2);
if(!['list','set-purpose','add-route','remove-route','set-enabled','rename','connect','connect-all'].includes(action)){console.error('Usage: drover-machines list | set-purpose <id> "purpose" | add-route <id> "JSON" | remove-route <id> <lan|internet|bridge> | set-enabled <id> <true|false> | rename <id> <name> | connect <id> | connect-all');process.exit(2)}
const client=net.createConnection(config.socket);let output='';client.setTimeout(900000,()=>{console.error('Drover request timed out');client.destroy();process.exitCode=1});
client.on('error',()=>{console.error('Open Drover to configure machines');process.exitCode=1});
client.on('connect',()=>client.write(JSON.stringify({token:config.token,action,args,paneId:process.env.HERDR_PANE_ID,session:process.env.HERDR_SESSION||config.session})+'\n'));
client.on('data',bytes=>{output+=bytes;if(output.length>1024*1024){client.destroy();process.exitCode=1;return}if(!output.includes('\n'))return;try{const response=JSON.parse(output.split('\n')[0]);if(response.ok){console.log(JSON.stringify(response.result,null,2));if(action.startsWith('connect')&&[].concat(response.result).some(r=>r&&r.state&&r.state!=='connected'))process.exitCode=1}else{console.error(response.error);process.exitCode=1}}catch{process.exitCode=1}client.end()});
`
interface ConnectPlan { ready: ApprovedMachineConnect[]; order: string[]; results: MachineConnectResult[]; lines: string[] }
export interface MachineHelperOptions {
  root: string; runtime: string; session(): string
  service: MachinesService
  agent(paneId: string): Promise<AgentInfo | null>
  role(agent: AgentInfo): Promise<string | null>
  confirm(detail: string): Promise<boolean>
  writable(): boolean
}
/** Shared-account authorization is advisory, like project scope. The caller's
 * live pane/role is resolved by Drover; requests cannot supply their own role.
 */
export class MachineHelper {
  private server: Server | null = null
  private socket = join(tmpdir(), 'dv-machines-' + randomBytes(8).toString('hex') + '.sock')
  private token = randomBytes(32).toString('hex')
  private starting: Promise<void> | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private disposed = false
  constructor(private options: MachineHelperOptions) {}
  async start(): Promise<string> {
    if (this.disposed) throw new MachinesFailure('closed', 'Machine helper is closed.')
    await (this.starting ??= this.listen())
    const folder = join(this.options.root, 'helper')
    await privateWrite(join(folder, 'runtime.json'), JSON.stringify({ socket: this.socket, token: this.token, session: this.options.session() }))
    await privateWrite(join(folder, 'cli.cjs'), SOURCE)
    const path = join(folder, 'drover-machines')
    await privateWrite(path, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(this.options.runtime)} ${quote(join(folder, 'cli.cjs'))} "$@"\n`, 0o700)
    return path
  }
  private async listen(): Promise<void> {
    const server = this.server = createServer(socket => {
      let input = '', handled = false
      socket.on('error', () => undefined); socket.setTimeout(900_000, () => socket.destroy())
      socket.on('data', bytes => {
        if (handled) return
        input += bytes
        if (input.length > 16_384) { socket.destroy(); return }
        if (!input.includes('\n')) return
        handled = true
        const action = this.tail.then(async () => {
          try { socket.end(JSON.stringify({ ok: true, result: await this.dispatch(JSON.parse(input.split('\n')[0])) }) + '\n') }
          catch (error) { socket.end(JSON.stringify({ ok: false, error: error instanceof MachinesFailure ? `[${error.code}] ${error.message}` : 'Machine request failed.' }) + '\n') }
        })
        this.tail = action.catch(() => undefined)
      })
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.socket, resolve) })
    await chmod(this.socket, 0o600); server.unref()
  }
  async dispatch(request: Record<string, unknown>): Promise<unknown> {
    if (!request || request.token !== this.token || typeof request.paneId !== 'string' || request.session !== this.options.session()) throw new MachinesFailure('unauthorized', 'Run the helper in a live Drover agent pane.')
    const agent = await this.options.agent(request.paneId)
    if (!agent || agent.pane_id !== request.paneId || !agent.cwd) throw new MachinesFailure('unauthorized', 'The requesting agent is no longer running.')
    // "Who can use it" is advisory: list and connect only show/offer machines this agent may use.
    if (request.action === 'list') return this.options.service.statusFor({ project: agent.cwd, name: agent.name ?? undefined, role: await this.options.role(agent) })
    if (!this.options.writable()) throw new MachinesFailure('desktop_only', 'Machine configuration requires the writable desktop app.')
    const role = await this.options.role(agent), policy = await this.options.service.projectMachinePolicy(agent.cwd)
    if (!role || !policy.configureRoles.includes(role)) throw new MachinesFailure('role_denied', 'This project role cannot configure machines. Ask its lead or DevOps agent.')
    const args = request.args, action = String(request.action)
    const arity: Record<string, number> = { 'set-purpose': 2, rename: 2, 'set-enabled': 2, 'add-route': 2, 'remove-route': 2, connect: 1, 'connect-all': 0 }
    if (!Object.hasOwn(arity, action) || !Array.isArray(args) || args.length !== arity[action] || args.some(a => typeof a !== 'string' || /[\r\n\0]/.test(a) || a.length > 2048)) throw new MachinesFailure('invalid_options', 'Invalid machine helper operation.')
    const service = this.options.service, who = `${agent.name || agent.agent} (${role})`
    let detail: string, plan: ConnectPlan | undefined
    if (action === 'connect' || action === 'connect-all') {
      plan = await this.connectPlan(action === 'connect' ? args[0] : undefined, { project: agent.cwd, name: agent.name ?? undefined, role })
      // Nothing would be changed (no machine with a trusted key): report without a dialog.
      if (!plan.ready.length) return action === 'connect' ? plan.results[0] : plan.results
      detail = `${who} requests ${action === 'connect' ? 'connect' : 'connect-all'} using your existing SSH login. Drover installs its revocable agents key on each machine marked "will connect".\n\n${plan.lines.join('\n')}`
    } else detail = `${who} requests ${action} for machine ${args[0]}:\n${args[1]}`
    const identity = JSON.stringify([agent.terminal_id, agent.agent_session, agent.name, agent.cwd])
    if (!await this.options.confirm(detail)) throw new MachinesFailure('confirmation_required', 'The desktop user declined this machine change.')
    const current = await this.options.agent(agent.pane_id)
    if (!current || JSON.stringify([current.terminal_id, current.agent_session, current.name, current.cwd]) !== identity || !this.options.writable() || await this.options.role(current) !== role) throw new MachinesFailure('unauthorized', 'The agent changed while confirmation was open.')
    if (!(await this.options.service.projectMachinePolicy(current.cwd!)).configureRoles.includes(role)) throw new MachinesFailure('role_denied', 'The project machine policy changed while confirmation was open.')
    const confirmed = { confirmed: true } as const
    if (plan) {
      // Keep the displayed tuple/fingerprint and recheck the live caller and
      // machine eligibility inside the service's serialized mutation boundary.
      const results = [...plan.results]
      const caller = async (): Promise<MachineAgent> => {
        const live = await this.options.agent(agent.pane_id)
        if (!live || JSON.stringify([live.terminal_id, live.agent_session, live.name, live.cwd]) !== identity || !this.options.writable() || await this.options.role(live) !== role) throw new MachinesFailure('unauthorized', 'The requesting agent changed after approval.')
        return { project: live.cwd!, name: live.name ?? undefined, role }
      }
      for (const entry of plan.ready) results.push(await service.connectTrusted(entry.machineId, confirmed, entry, caller))
      results.sort((a, b) => plan!.order.indexOf(a.machineId) - plan!.order.indexOf(b.machineId))
      return action === 'connect' ? results[0] : results
    }
    switch (action) {
      case 'set-purpose': return service.setPurpose(args[0], args[1])
      case 'rename': return service.rename(args[0], args[1], confirmed)
      case 'set-enabled': if (!['true','false'].includes(args[1])) throw new MachinesFailure('invalid_options', 'Choose true or false.'); return service.setEnabled(args[0], args[1] === 'true', confirmed)
      case 'add-route': return service.addRoute(args[0], JSON.parse(args[1]), confirmed)
      case 'remove-route': if (!['lan','internet','bridge'].includes(args[1])) throw new MachinesFailure('invalid_route', 'Choose a route.'); return service.removeRoute(args[0], args[1], confirmed)
    }
  }
  /** Probes each candidate's host key before the dialog. Only keys already trusted
   * (known_hosts or Drover's pins) are connected; new keys need the user in Drover's
   * Machines screen, and a changed key is a hard stop. */
  private async connectPlan(id: string | undefined, agent: MachineAgent): Promise<ConnectPlan> {
    const all = await this.options.service.connectCandidates()
    const candidates = all.filter(m => machineInProject(m, agent.project) && machineUsable(m, agent))
    const machines = id === undefined ? candidates : candidates.filter(m => m.id === id)
    if (id !== undefined && !machines.length && all.some(m => m.id === id)) throw new MachinesFailure('usage_denied', 'This machine is not available to you. Ask the lead.')
    if (id !== undefined && !machines.length) throw new MachinesFailure('not_connectable', 'This machine is unknown, disabled, already connected, or needs the installer.')
    const plan: ConnectPlan = { ready: [], order: machines.map(m => m.id), results: [], lines: [] }
    for (const m of machines) {
      let entry: ApprovedMachineConnect, hostKey: HostKey
      try { entry = await this.options.service.prepareConnect(m.id); hostKey = entry.hostKey }
      catch (error) {
        const reason = sshError(error)
        if (id !== undefined && reason.code === 'host_key_changed') throw error
        plan.results.push({ machineId: m.id, state: 'failed', error: reason })
        plan.lines.push(`- Machine ${m.id}: ${reason.code === 'host_key_changed' ? 'HOST KEY CHANGED — blocked' : `host key check failed (${reason.code}) — skipped`}`)
        continue
      }
      const label = `- ${entry.name} (${entry.user}@${entry.host}:${entry.port})`
      if (hostKey.known) { plan.ready.push(entry); plan.lines.push(`${label}: host key ${hostKey.fingerprint} matches known_hosts — will connect`) }
      else {
        plan.results.push({ machineId: m.id, state: 'host_key_confirmation', hostKey })
        plan.lines.push(`${label}: new host key ${hostKey.fingerprint} — will NOT connect; confirm the key in Drover's Machines screen`)
      }
    }
    return plan
  }
  dispose(): void { this.disposed = true; this.server?.close(); void unlink(this.socket).catch(() => undefined) }
}
