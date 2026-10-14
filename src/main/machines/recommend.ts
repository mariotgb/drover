import type { Machine, MachineMethodAnswer, MachineMethodRecommendation, MachineNextAction } from '@shared/machines'
import { MachinesFailure } from './ssh'

export function recommendMachineMethod(answer: MachineMethodAnswer, hasBridge: boolean): MachineMethodRecommendation {
  if (!answer || !['lan', 'public', 'behind_router'].includes(answer.location)) throw new MachinesFailure('invalid_options', 'Choose where this machine is reachable.')
  const route = answer.location === 'public' ? 'direct' : answer.location === 'lan' ? 'lan' : 'bridge'
  const ssh = (answer.hasSsh === true || !!answer.host) && answer.hasSsh !== false && answer.location !== 'behind_router'
  return { method: ssh ? 'direct' : 'installer', route, nextAction: ssh ? 'confirm_host_key' : route === 'bridge' && !hasBridge ? 'setup_bridge' : 'run_installer', reason: ssh ? 'existing_ssh' : route === 'bridge' && !hasBridge ? 'needs_bridge' : 'needs_installer' }
}
export function machineNextActions(machine: Machine): MachineNextAction[] {
  if (machine.enabled === false) return ['enable']
  if (machine.herdrSyncError) return ['sync_herdr']
  if (machine.bridgeSetup?.error || machine.bridgeSetup?.state === 'failed') return ['repair_bridge']
  if (machine.status.state === 'online') return ['open_agents', 'check']
  if (machine.status.error?.code === 'host_key_unconfirmed' || machine.status.error?.code === 'key_not_installed' || machine.origin === 'herdr' && !machine.status.checks?.auth) return ['confirm_host_key', 'install_key']
  if (machine.needsReinstall || machine.status.state === 'waiting') return ['run_installer', 'check']
  return ['check']
}
