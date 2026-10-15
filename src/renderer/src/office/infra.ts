import type { OfficeExternalNode } from '@shared/office'
import { deviceKind, type DeviceKind } from '../devices'
import type { Point, Rect } from './layout'

/** The machines room ("Infrastructure"): this computer, the bridge, the device shelf and one station per machine.
 * Pure geometry, so the room never moves things around between frames.
 */
export type CableKind = 'lan' | 'internet' | 'bridge' | 'standby' | 'down'
export interface InfraCable { id: string; kind: CableKind; points: Point[]; machineId?: string }
export interface InfraMachine { id: string; node: OfficeExternalNode; anchor: Point; label: Point; tone: CableKind; offline: boolean; agents: Point[] }
export interface InfraDevice { id: string; name: string; kind: DeviceKind; online: boolean; anchor: Point }
export interface InfraScene {
  room: Rect; home: Point; homeLabel: Point; bridge: Point | null; bridgeLabel: Point | null
  shelf: Rect | null; devices: InfraDevice[]; hiddenDevices: number
  machines: InfraMachine[]; cables: InfraCable[]; legend: Point; legendKinds: CableKind[]
}
export interface InfraCounts { machines: number; devices: number }
type Device = { id: string; name: string; online: boolean; kind?: string; lastSeenAt?: number }

export const INFRA = { columnWidth: 104, rowHeight: 112, firstRow: 136, left: 152, shelfSlot: 34, maxShelf: 4, agentsPerMachine: 3 } as const

export function infraMachines(nodes: OfficeExternalNode[]) { return nodes.filter(n => n.kind === 'machine') }
/** Devices may arrive as `devices` (0.8.5) or `phones` (older main); never show one twice. */
export function infraDevices(nodes: OfficeExternalNode[]): Device[] {
  const seen = new Set<string>(), out: Device[] = []
  for (const n of nodes) for (const d of (n.devices ?? n.phones ?? []) as Device[]) if (!seen.has(d.id)) { seen.add(d.id); out.push(d) }
  return out
}
export function infraCounts(nodes: OfficeExternalNode[]): InfraCounts { return { machines: infraMachines(nodes).length, devices: infraDevices(nodes).length } }

export function infraColumns(machines: number) { return machines <= 1 ? 1 : machines <= 4 ? 2 : 3 }
/** Room size grows with machines: new stations join in rows. Null when there is nothing to show. */
export function infraSize({ machines, devices }: InfraCounts): { width: number; height: number } | null {
  if (!machines && !devices) return null
  const cols = infraColumns(machines), rows = Math.max(1, Math.ceil(machines / cols))
  const width = Math.max(240, Math.ceil((INFRA.left + cols * INFRA.columnWidth + 24) / 16) * 16)
  return { width, height: Math.max(224, Math.ceil((INFRA.firstRow + (rows - 1) * INFRA.rowHeight + 88) / 16) * 16) }
}
const usesBridge = (n: OfficeExternalNode) => n.activeRoute === 'bridge' || !!n.routes?.some(r => r.kind === 'bridge')
/** The route in use right now; a machine not connected yet is a quiet line, not a broken one. */
export function machineTone(n: OfficeExternalNode): CableKind {
  return n.state === 'offline' ? 'down' : n.activeRoute ?? 'standby'
}

export function infraScene(room: Rect, nodes: OfficeExternalNode[]): InfraScene {
  const machinesIn = infraMachines(nodes), devicesIn = infraDevices(nodes)
  const cols = infraColumns(machinesIn.length)
  // Clear of the doorway (room.x + 32..64) and the legend along the bottom wall.
  const home = { x: room.x + 72, y: room.y + room.height - 76 }
  const hasBridge = machinesIn.some(usesBridge) || devicesIn.length > 0
  const bridge = hasBridge ? { x: room.x + room.width - 44, y: room.y + 86 } : null
  const shown = devicesIn.slice(0, Math.min(INFRA.maxShelf, Math.floor((room.width - 120) / INFRA.shelfSlot)))
  const shelf = devicesIn.length ? { x: room.x + 24, y: room.y + 46, width: shown.length * INFRA.shelfSlot + 8, height: 4 } : null
  const devices: InfraDevice[] = shown.map((d, i) => ({ id: d.id, name: d.name, kind: deviceKind(d), online: d.online, anchor: { x: room.x + 28 + i * INFRA.shelfSlot + INFRA.shelfSlot / 2, y: room.y + 46 } }))
  const cables: InfraCable[] = []
  // Wall-side cable lanes run below the shelf's device names.
  const lanes = room.y + 72
  if (bridge) cables.push({ id: 'home-bridge', kind: 'bridge', points: [{ x: home.x - 30, y: home.y - 30 }, { x: home.x - 30, y: lanes }, { x: bridge.x - 6, y: lanes }, { x: bridge.x - 6, y: bridge.y - 4 }] })
  if (shelf && bridge) cables.push({ id: 'devices-bridge', kind: 'bridge', points: [{ x: shelf.x + shelf.width - 4, y: shelf.y + 2 }, { x: shelf.x + shelf.width - 4, y: lanes - 4 }, { x: bridge.x + 6, y: lanes - 4 }, { x: bridge.x + 6, y: bridge.y - 4 }] })
  const machines: InfraMachine[] = machinesIn.map((node, i) => {
    const col = i % cols, row = Math.floor(i / cols)
    const anchor = { x: room.x + INFRA.left + 20 + col * INFRA.columnWidth, y: room.y + INFRA.firstRow + row * INFRA.rowHeight }
    const tone = machineTone(node), offline = tone === 'down'
    const count = Math.min(INFRA.agentsPerMachine, node.remoteAgents?.length ?? 0)
    const agents = Array.from({ length: count }, (_, k) => ({ x: anchor.x - (count - 1) * 9 + k * 18, y: anchor.y + 16 }))
    const lane = anchor.y + 22 + (i % 4) * 2, end = { x: anchor.x + 12, y: anchor.y - 4 }
    if (tone === 'bridge' && bridge) {
      const drop = bridge.x + 2 + (i % 4) * 2
      cables.push({ id: `m:${node.id}`, machineId: node.id, kind: 'bridge', points: [{ x: drop, y: bridge.y }, { x: drop, y: lane }, { x: end.x, y: lane }, end] })
    } else {
      const trunk = room.x + INFRA.left - 24 + (i % 6) * 3, start = { x: home.x + 38, y: home.y - 14 + (i % 6) * 2 }
      cables.push({ id: `m:${node.id}`, machineId: node.id, kind: tone === 'bridge' ? 'standby' : tone, points: [start, { x: trunk, y: start.y }, { x: trunk, y: lane }, { x: end.x, y: lane }, end] })
    }
    // A bridge route kept in reserve: a quiet dotted line from the bridge.
    if (bridge && tone !== 'bridge' && (node.fallback || node.routes?.some(r => r.kind === 'bridge'))) {
      const drop = bridge.x - 2 - (i % 4) * 2, side = anchor.x - 12
      cables.push({ id: `s:${node.id}`, machineId: node.id, kind: 'standby', points: [{ x: drop, y: bridge.y }, { x: drop, y: anchor.y - 52 }, { x: side, y: anchor.y - 52 }, { x: side, y: anchor.y - 4 }] })
    }
    return { id: node.id, node, anchor, label: { x: anchor.x, y: anchor.y - 48 }, tone, offline, agents }
  })
  const legendKinds = [...new Set(cables.map(c => c.kind))].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
  return { room, home, homeLabel: { x: home.x, y: home.y + 6 }, bridge, bridgeLabel: bridge && { x: bridge.x, y: room.y + 34 }, shelf, devices, hiddenDevices: devicesIn.length - shown.length, machines, cables, legend: { x: room.x + 20, y: room.y + room.height - 28 }, legendKinds }
}
const ORDER: CableKind[] = ['lan', 'internet', 'bridge', 'standby', 'down']
