import { chmod, unlink } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MachinesFailure, privateWrite, quote } from './ssh'
import type { AgentInfo } from '@shared/types'
import type { MachinesService } from './service'

const SOURCE = String.raw`const fs=require('node:fs'),net=require('node:net'),path=require('node:path');
const config=JSON.parse(fs.readFileSync(path.join(__dirname,'runtime.json'),'utf8'));
const [action,...args]=process.argv.slice(2);
if(!['list','set-purpose','add-route','remove-route','set-enabled','rename'].includes(action)){console.error('Usage: drover-machines list | set-purpose <id> "purpose" | add-route <id> "JSON" | remove-route <id> <lan|internet|bridge> | set-enabled <id> <true|false> | rename <id> <name>');process.exit(2)}
const client=net.createConnection(config.socket);let output='';client.setTimeout(180000,()=>{console.error('Drover request timed out');client.destroy();process.exitCode=1});
client.on('error',()=>{console.error('Open Drover to configure machines');process.exitCode=1});
client.on('connect',()=>client.write(JSON.stringify({token:config.token,action,args,paneId:process.env.HERDR_PANE_ID,session:process.env.HERDR_SESSION||config.session})+'\n'));
client.on('data',bytes=>{output+=bytes;if(output.length>1024*1024){client.destroy();process.exitCode=1;return}if(!output.includes('\n'))return;try{const response=JSON.parse(output.split('\n')[0]);if(response.ok)console.log(JSON.stringify(response.result,null,2));else{console.error(response.error);process.exitCode=1}}catch{process.exitCode=1}client.end()});
`
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
      socket.on('error', () => undefined); socket.setTimeout(180_000, () => socket.destroy())
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
    if (request.action === 'list') return this.options.service.status()
    if (!this.options.writable()) throw new MachinesFailure('desktop_only', 'Machine configuration requires the writable desktop app.')
    const role = await this.options.role(agent), policy = await this.options.service.projectMachinePolicy(agent.cwd)
    if (!role || !policy.configureRoles.includes(role)) throw new MachinesFailure('role_denied', 'This project role cannot configure machines. Ask its lead or DevOps agent.')
    const args = request.args
    if (!Array.isArray(args) || args.length !== 2 || args.some(a => typeof a !== 'string' || /[\r\n\0]/.test(a) || a.length > 2048) || !['set-purpose','rename','set-enabled','add-route','remove-route'].includes(String(request.action))) throw new MachinesFailure('invalid_options', 'Invalid machine helper operation.')
    const identity = JSON.stringify([agent.terminal_id, agent.agent_session, agent.name, agent.cwd])
    if (!await this.options.confirm(`${agent.name || agent.agent} (${role}) requests ${request.action} for machine ${args[0]}:\n${args[1]}`)) throw new MachinesFailure('confirmation_required', 'The desktop user declined this machine change.')
    const current = await this.options.agent(agent.pane_id)
    if (!current || JSON.stringify([current.terminal_id, current.agent_session, current.name, current.cwd]) !== identity || !this.options.writable() || await this.options.role(current) !== role) throw new MachinesFailure('unauthorized', 'The agent changed while confirmation was open.')
    if (!(await this.options.service.projectMachinePolicy(current.cwd!)).configureRoles.includes(role)) throw new MachinesFailure('role_denied', 'The project machine policy changed while confirmation was open.')
    const service = this.options.service, confirmed = { confirmed: true } as const
    switch (request.action) {
      case 'set-purpose': return service.setPurpose(args[0], args[1])
      case 'rename': return service.rename(args[0], args[1], confirmed)
      case 'set-enabled': if (!['true','false'].includes(args[1])) throw new MachinesFailure('invalid_options', 'Choose true or false.'); return service.setEnabled(args[0], args[1] === 'true', confirmed)
      case 'add-route': return service.addRoute(args[0], JSON.parse(args[1]), confirmed)
      case 'remove-route': if (!['lan','internet','bridge'].includes(args[1])) throw new MachinesFailure('invalid_route', 'Choose a route.'); return service.removeRoute(args[0], args[1], confirmed)
    }
  }
  dispose(): void { this.disposed = true; this.server?.close(); void unlink(this.socket).catch(() => undefined) }
}
