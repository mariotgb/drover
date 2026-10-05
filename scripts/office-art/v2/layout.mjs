// Office v2 layout: one project = one hall that grows by bench rows, halls in one
// building along a shared corridor, lobby with «Вы» on the left, server room on the right.
// Reference implementation for the engine (see ~/remote-mac/OFFICE-V2-LAYOUT.md). Units: px, tile = 16.

export const T = 16
export const COL = 48           // one workstation column (3 tiles)
export const ROW_PITCH = 112    // one bench row (7 tiles): plaques, faces, desks, chairs, aisle
export const HEAD = 128         // wall (3 tiles) + head zone (5 tiles): board, lead desk, meeting corner
export const LOUNGE = 64        // 4 tiles: sofa, coffee, plants, by the door
export const FRONT = 16         // bottom wall (cap.front) with the door
export const AISLE = 48         // side aisles (3 tiles)
export const MID_AISLE = 32     // between two benches in the widest hall (2 tiles)
export const CORRIDOR = 80      // 5 tiles under all rooms: 2 wall face + 3 floor
export const MARGIN = 48        // outside strip around the building (3 tiles)

/** Hall size class from the number of agents (one optional lead sits at the head desk). */
export function hallShape(count, hasLead) {
  const workers = Math.max(0, count - (hasLead ? 1 : 0))
  const cols = workers <= 4 ? 2 : 4            // desk columns per bench side
  const benches = workers > 16 ? 2 : 1         // benches side by side
  const perRow = 2 * cols * benches            // north (facing you) + south (back to you)
  const rows = workers ? Math.ceil(workers / perRow) : 0
  const inner = benches * cols * COL + (benches - 1) * MID_AISLE + 2 * AISLE
  return { workers, cols, benches, perRow, rows, width: inner + 2 * T, height: HEAD + rows * ROW_PITCH + LOUNGE + FRONT }
}

/** Seat geometry inside a hall at (hx, hy). Index order: row by row, north side left→right, then south. */
export function seatAt(shape, hx, hy, index) {
  const row = Math.floor(index / shape.perRow), inRow = index % shape.perRow
  const perSide = shape.cols * shape.benches
  const south = inRow >= perSide
  const col = inRow % perSide
  const bench = Math.floor(col / shape.cols), c = col % shape.cols
  const x = hx + T + AISLE + bench * (shape.cols * COL + MID_AISLE) + c * COL
  const deskTop = hy + HEAD + 40 + row * ROW_PITCH   // north edge of the north desk surface
  return { row, col: c, bench, side: south ? 'south' : 'north', x, deskTop, center: x + COL / 2 }
}

/**
 * Campus: rooms left→right on one corridor, bottom-aligned (halls grow upwards, the
 * corridor never moves). projects: [{ name, agents: [{ name, kind, role, status, lead }] }]
 */
export function campus(projects, { machines = [] } = {}) {
  const rooms = []
  const lobby = { kind: 'lobby', name: 'Вы', width: 12 * T, height: 13 * T }
  rooms.push(lobby)
  for (const p of projects) {
    const lead = p.agents.find((a) => a.lead)
    const shape = hallShape(p.agents.length, Boolean(lead))
    rooms.push({ kind: 'hall', project: p, lead, shape, width: shape.width, height: shape.height, name: p.name })
  }
  if (machines.length) rooms.push({ kind: 'server', name: 'server', width: Math.max(10, 4 + machines.length * 3) * T, height: 13 * T, machines })
  const tallest = Math.max(...rooms.map((r) => r.height))
  const top = MARGIN
  const corridorY = top + tallest
  let x = MARGIN
  for (const r of rooms) {
    r.x = x; r.y = corridorY - r.height
    x += r.width - T // neighbours share a wall
  }
  const width = x + T + MARGIN
  const corridor = { x: MARGIN, y: corridorY, width: x + T - MARGIN, height: CORRIDOR }
  const height = corridorY + CORRIDOR + T + 24 + MARGIN // + bottom wall + facade
  // Seats, agents, nodes.
  const seats = [], nodes = {}
  for (const r of rooms.filter((r) => r.kind === 'hall')) {
    const { shape } = r
    const workers = r.project.agents.filter((a) => a !== r.lead)
    const total = shape.rows * shape.perRow
    for (let i = 0; i < total; i++) {
      const s = seatAt(shape, r.x, r.y, i)
      const agent = workers[i] ?? null
      seats.push({ ...s, room: r, agent })
      if (agent) nodes[agent.name] = { ...s, room: r, agent }
    }
    r.headDesk = { x: r.x + r.width / 2 - 32, deskTop: r.y + 92, center: r.x + r.width / 2 }
    if (r.lead) nodes[r.lead.name] = { side: 'head', center: r.headDesk.center, deskTop: r.headDesk.deskTop, room: r, agent: r.lead }
    r.board = { x: r.x + 2 * T, y: r.y + T + 2 }
    r.door = { x: r.x + T + T, y: r.y + r.height - FRONT, width: 2 * T }
  }
  lobby.door = { x: lobby.x + lobby.width - 4 * T, y: lobby.y + lobby.height - FRONT, width: 2 * T }
  const user = { x: lobby.x + 6 * T, y: lobby.y + 8 * T + 4 }
  lobby.user = user
  nodes['Вы'] = { side: 'user', center: user.x, deskTop: user.y - 8, room: lobby, user: true }
  const server = rooms.find((r) => r.kind === 'server')
  if (server) server.door = { x: server.x + 2 * T, y: server.y + server.height - FRONT, width: 2 * T }
  if (server) machines.forEach((m, i) => { nodes[m] = { side: 'machine', center: server.x + (3 + i * 3) * T, deskTop: server.y + 7 * T, room: server, machine: m } })
  return { rooms, corridor, seats, nodes, width, height, top, corridorY }
}
