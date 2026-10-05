// v2 data for the engine: lighting, palette (procedural lines/arcs) and compositions —
// what stands where inside each zone. Keys are the same in both sets; contents differ.
// Item: { sprite, state?, x | xr | xc, y, sortY? }  (anchor position; xr = from the right edge,
// xc = from the centre; sortY overrides the draw order). Region: { tiles: 'tile.rug', x, y, w, h }.
const T = 16
const neon = (P) => P.id === 'neon'

export function lighting(P) {
  const warm = [1, 0.86, 0.62]
  return neon(P)
    ? {
        ambient: P.ambient, steps: P.steps, dither: 'bayer4',
        window: { kind: 'pool', color: [0.45, 0.55, 1], k: 0.25, rx: 22, ry: 10, dx: 14, dy: 6, byTime: { day: 0.6, evening: 0.9, night: 1 } },
        pendant: { color: warm, k: 0.55, rxPerColumn: 30, ry: 40, dy: 12 },
        headDesk: { color: warm, k: 0.75, rx: 56, ry: 30, dy: 4 },
        corridor: { color: warm, k: 0.75, every: 96, startX: 48, rx: 44, ry: 22, dy: 52 },
        lounge: { color: [1, 0.8, 0.6], k: 0.35, ry: 40, dy: 30 },
        lobby: [{ x: 96, y: 122, rx: 60, ry: 40, color: warm, k: 0.8 }, { x: 64, y: 160, rx: 40, ry: 20, color: warm, k: 0.5 }],
        server: { color: [0.4, 0.7, 1], k: 0.45, ry: 50, dy: 112 },
        boss: [{ x: 112, y: 100, rx: 70, ry: 46, color: warm, k: 1.05 }, { x: 112, y: 70, rx: 30, ry: 22, color: [0.45, 0.8, 1], k: 0.5 }],
        glowSprites: true
      }
    : {
        ambient: P.ambient, steps: P.steps, dither: 'bayer4',
        window: { kind: 'sun', color: [1, 0.92, 0.72], k: 0.2, depth: 56, shift: 34, width: 28, byTime: { day: 1, evening: 0.6, night: 0 } },
        pendant: { color: [1, 0.95, 0.8], k: 0.05, rxPerColumn: 30, ry: 40, dy: 12 },
        headDesk: null, corridor: null, lounge: null, lobby: [], server: null, boss: [],
        night: { ambient: [0.62, 0.66, 0.9], lampK: 0.6 },
        glowSprites: false
      }
}

export function palette(P) {
  return {
    status: { ...P.status },
    link: P.link, linkShade: P.linkShade, user: P.user, attempt: P.attempt, board: P.board, boss: neon(P) ? '#ffd36b' : '#d9a441',
    cable: [...P.cable], packet: P.packet,
    plaqueText: P.plaque.text, plaqueFill: P.plaque.fill, plaqueEdge: P.plaque.edge,
    signText: P.sign.text, labelText: '#fffaf0',
    beam: neon(P) ? '#5ef2ff' : null, shadow: '#1a1220',
    // link rendering: dotted (cozy) or beam (neon)
    linkStyle: neon(P) ? 'beam' : 'dotted', linkLift: 22, carrierLift: 24
  }
}

export function compositions(P) {
  const n = neon(P)
  const lounge = n
    ? {
        narrow: [{ sprite: 'object.beanbag', state: 'a', x: 7 * T, y: 30 }, { sprite: 'object.beanbag', state: 'b', x: 9 * T, y: 44 }, { sprite: 'object.coffee', xr: 38, y: 30 }, { sprite: 'object.lamp.floor', x: 5 * T + 8, y: 40 }, { sprite: 'object.plant.big', xr: 26, y: 62 }],
        wide: [{ sprite: 'object.arcade', x: 13 * T, y: 40 }, { sprite: 'object.vending', x: 15 * T, y: 40 }, { sprite: 'object.beanbag', state: 'c', x: 11 * T, y: 30 }],
        widest: [{ sprite: 'object.pingpong', x: 22 * T, y: 50 }, { sprite: 'object.arcade', x: 27 * T, y: 40 }]
      }
    : {
        narrow: [{ tiles: 'tile.rug', x: 6 * T, y: 0, w: 6 * T, h: 3 * T }, { sprite: 'object.sofa.small', x: 9 * T, y: 30 }, { sprite: 'object.table.coffee', x: 9 * T, y: 58 }, { sprite: 'object.coffee', xr: 38, y: 30 }, { sprite: 'object.plant.big', xr: 26, y: 62 }],
        wide: [{ tiles: 'tile.rug', x: 6 * T, y: 0, w: 9 * T, h: 3 * T, replaces: 'narrow' }, { sprite: 'object.sofa', x: 10 * T, y: 30, replaces: 'object.sofa.small' }, { sprite: 'object.armchair', x: 14 * T, y: 56 }, { sprite: 'object.lamp.floor', x: 6 * T + 4, y: 34 }, { sprite: 'object.bookshelf', x: 16 * T, y: 36 }],
        widest: [{ sprite: 'object.armchair', x: 21 * T, y: 56 }, { sprite: 'object.bookshelf', x: 26 * T, y: 36 }, { sprite: 'object.plant.monstera', x: 29 * T, y: 60 }]
      }
  return {
    // Hall lounge: origin (hall.x, hall.y + 128 + rows·112). wide/widest add to narrow.
    lounge,
    // Hall head zone extras besides the lead desk: origin (hall.x, hall.y).
    head: {
      narrow: [{ sprite: 'object.plant.monstera', x: 30, y: 124 }],
      noLead: [{ sprite: 'object.table.meeting', xc: 0, y: 122 }],
      wide: [{ sprite: 'object.bookshelf', x: 96, y: 98 }, { sprite: 'object.table.meeting', xr: 80, y: 122 }]
    },
    // Hall north wall: origin (hall.x, hall.y). Sign: top-left = (centre − w/2, 15), nine-slice sign.x2 when hall ≥ 20 tiles and text ≤ 40 px.
    wall: {
      board: { sprite: 'object.board', x: 51, y: 46 },
      clock: { sprite: 'object.clock', narrow: { xc: 30, y: 35 }, wide: { xc: -64, y: 35 } },
      picture: { sprite: 'object.picture', wideOnly: true, xc: -33, y: 37, hideWithRank: true },
      windows: { sprite: 'object.window', from: 'signRight', gap: 10, step: 52, width: 30, end: 'wallRight', endGap: 4, anchorDx: 14, y: 45 },
      sign: { top: 15, scale2MinWidth: 20 * T, scale2MaxText: 40 }
    },
    // Lobby «Вы»: origin (lobby.x, lobby.y); lobby is 12 × 13 tiles.
    lobby: [
      { sprite: 'object.rug.round', x: 96, y: 160 }, { sprite: 'object.directory', x: 44, y: 51 },
      { sprite: 'object.window', x: 152, y: 45 }, { sprite: 'object.reception', x: 96, y: 146 }, { sprite: 'agent.user', state: 'idle:front', x: 96, y: 132 },
      { sprite: 'object.bell', state: 'idle', x: 118, y: 138, sortY: 147 }, { sprite: 'object.plant.monstera', x: 30, y: 70 }, { sprite: 'object.sofa.small', x: 64, y: 174 },
      { sprite: 'object.plant.big', x: 166, y: 190 }, { sprite: 'object.cooler', x: 166, y: 80 },
      { sign: 'ПРИЁМНАЯ', xc: 6, y: 15 }, { plaque: 'you', text: 'ВЫ', x: 96, y: 82 }, { label: 'warn', when: 'blocked', x: 118, y: 114, text: '{n} ЖДУТ' }
    ],
    // Server room: origin (server.x, server.y); machines at ((3 + 3i)·16, 144), label under at +4.
    server: [{ sprite: 'object.rack', x: 30, y: 86 }, { sprite: 'object.rack', x: 50, y: 86 }, { sprite: 'object.rack', x: 70, y: 86 }, { sprite: 'object.plant.small', xr: 26, yb: 20 }, { sign: 'СЕРВЕРНАЯ', xc: 0, y: 15 }],
    machine: { sprite: 'object.machine', x0: 48, step: 48, y: 144, label: { dy: 4 } },
    // Boss office: origin (boss.x, boss.y); room 14 × 13 tiles, on the corridor next to the lobby.
    boss: [
      { sprite: 'object.rug.boss', x: 112, y: 182 }, { sprite: 'object.window', x: 60, y: 45 }, { sprite: 'object.window', x: 164, y: 45 },
      { sprite: 'object.flag', x: 34, y: 128 }, { sprite: 'object.trophy', x: 190, y: 120 }, { sprite: 'object.chair.boss', x: 112, y: 99 },
      { sprite: 'agent.boss', state: 'sit:front', x: 112, y: 100 }, { sprite: 'object.desk.boss', x: 112, y: 132 }, { sprite: 'object.phone', state: 'idle', x: 140, y: 110, sortY: 133 },
      { sprite: 'object.plant.big', x: 26, y: 190 }, { sprite: 'object.plant.big', x: 198, y: 190 }, { sprite: 'object.bookshelf', x: 190, y: 86 },
      { sign: 'ГЛАВНЫЙ', xc: 0, y: 15 }, { plaque: 'lead', text: 'БОСС', x: 112, y: 40 }
    ],
    bossSlots: { hand: { x: 124, y: 70 }, head: { x: 112, y: 64 }, plaque: { x: 112, y: 40 }, bubble: { x: 112, y: 39 } },
    // Flat layers (floor, floor-shade, rug) are drawn before the Y-sorted pass.
    flatLayers: ['floor', 'floor-shade', 'rug'],
    // Corridor: wall face (2 tiles) + runner on the 3rd tile row; doorways at each room door.
    corridor: { doorway: { sprite: 'object.doorway', dx: 16, dy: 32 }, doorLabel: { label: 'light', dx: 36, dy: 10 }, every: 144, startX: 48, picture: { sprite: 'object.picture', dx: 7, dy: 17 }, plant: { sprite: 'object.plant.small', dx: 20, dy: 46 }, runnerRow: 2 },
    // Outside: trees on a jittered 3-tile grid, flowerbed above each room, hedge along the top.
    outside: {
      ground: n ? ['tile.ground.0', 'tile.ground.1', 'tile.ground.2'] : ['tile.ground.0', 'tile.ground.1', 'tile.ground.2', 'tile.ground.3'],
      decals: { tiles: ['tile.ground.decal.0', 'tile.ground.decal.1', 'tile.ground.decal.2', 'tile.ground.decal.3'], density: n ? 0.03 : 0.08 },
      grid: 3 * T, tree: { sprites: ['object.tree.big', 'object.tree.small'], p: 0.55 }, bush: { sprite: 'object.bush', p: 0.2 }, lamp: n ? { sprite: 'object.lamp.post', p: 0.07 } : null,
      bedAboveRooms: 'object.flowerbed', hedge: 'object.hedge',
      sidewalk: n ? null : 'tile.ground.path', entrancePath: n ? null : 'tile.ground.path',
      street: { every: 7 * T, lamp: 'object.lamp.post', bench: 'object.bench.park', bikes: 'object.bikes', entrance: 'object.entrance' }
    },
    // Project importance (0.7.2): primary | important | normal | background. Normal draws nothing.
    // rank: left of the hall sign (x = sign left − gap, bottom y from hall.y); banner: corridor wall left of the hall door;
    // mat: corridor floor in front of the door. Background halls: lights × dim, neon sign unlit, plaques at plaqueAlpha.
    importance: {
      rank: { sprite: 'object.rank', states: ['primary', 'important', 'background'], signGap: 2, y: 34 },
      banner: { sprite: 'object.banner', states: ['primary', 'important'], doorDx: -10, corridorY: 29 },
      mat: { sprite: 'object.mat', states: ['primary', 'important'], doorDx: 16, corridorY: 46 },
      background: { dim: n ? 0.7 : 0.82, signGlow: false, plaqueAlpha: 0.75 },
      primary: { signScale: 2 }
    },
    // Decorative pet: never touches desks, walks aisles and the lounge only.
    pet: n ? { sprite: 'object.robot', rest: 'charge', move: 'move', speed: 18 } : { sprite: 'object.cat', rest: 'sleep', move: 'walk:side', speed: 14, restOn: 'object.sofa' },
    timeOfDay: { day: [7, 17], evening: [17, 21], night: [21, 7], default: n ? 'night' : 'day' }
  }
}
