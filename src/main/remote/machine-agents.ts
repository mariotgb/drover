import { createHash } from 'node:crypto'
import type { HerdrMachine } from '@shared/machines'
import type { RemoteMachineAgents } from '@shared/remote'
import { boardTaskTitle } from '../office/hud'

/** Project only safe display metadata from the cached, connected roster. No SSH or registry writes. */
export function remoteMachineAgents(rows: HerdrMachine[]): RemoteMachineAgents[] {
  const clean = (name: string) => boardTaskTitle(name) ?? 'Machine'
  return rows.filter(row => row.enabled !== false && row.status.state === 'online').map(row => ({
    id: row.id, name: clean(row.label), state: 'online',
    agents: row.workspaces.flatMap(workspace => workspace.agents.map(agent => ({
      id: createHash('sha256').update(JSON.stringify([row.id, row.session, agent.paneId])).digest('hex'),
      name: clean(agent.name || agent.agent), kind: agent.agent, status: agent.status
    })))
  }))
}
