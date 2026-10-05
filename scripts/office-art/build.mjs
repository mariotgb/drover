// Generates the "Общий зал" art: tiles/agents/roles/effects atlases, manifest.json
// (OfficeArtManifestV1, src/shared/office.ts) and preview.png. Deterministic.
// Usage: node scripts/office-art/build.mjs [--out <dir>]
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pix } from './canvas.mjs'
import { encodePng } from './png.mjs'
import { text } from './font.mjs'
import { DIRECTIONS, FRAME, KINDS, ROLES, STATES, STATE_NAMES, drawBody, drawRole } from './characters.mjs'
import { buildTiles } from './tiles.mjs'
import { buildEffects } from './effects.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const outArg = process.argv.indexOf('--out')
const OUT = resolve(outArg > 0 ? process.argv[outArg + 1] : join(here, '../../src/renderer/src/office/assets'))
const GAP = 2
export const LAYERS = ['floor', 'floor-shade', 'rug', 'wall', 'wall-decor', 'furniture-back', 'body', 'role', 'furniture', 'wall-front', 'effect']
const AGENT_HIT = { x: 6, y: 4, width: 20, height: 42 }

/** Character atlases: one row per (kind|role, direction), frames in state order. */
function characterAtlas(names, draw, prefix, layer) {
  const cols = STATE_NAMES.reduce((n, s) => n + STATES[s].poses.length, 0)
  const pitchX = FRAME.w + GAP, pitchY = FRAME.h + GAP
  const pix = new Pix(cols * pitchX - GAP, names.length * DIRECTIONS.length * pitchY - GAP)
  const sprites = {}
  let row = 0
  for (const name of names) {
    const states = {}
    for (const dir of DIRECTIONS) {
      let col = 0
      for (const state of STATE_NAMES) {
        const plan = STATES[state]
        const frames = plan.poses.map((pose) => {
          const x = col * pitchX, y = row * pitchY
          pix.blit(draw(name, dir, pose), 0, 0, FRAME.w, FRAME.h, x, y)
          col++
          return { rect: { x, y, width: FRAME.w, height: FRAME.h }, anchor: { ...FRAME.anchor }, hitRect: { ...AGENT_HIT } }
        })
        states[`${state}:${dir}`] = { frames, durationsMs: [...plan.durations], loop: true }
      }
      row++
    }
    sprites[`${prefix}.${name}`] = { atlas: prefix === 'agent' ? 'agents' : 'roles', layers: [layer], states }
  }
  return { pix, sprites }
}

/** Shelf packing for tiles/objects/effects; 16×16 tiles get 1px extruded edges against seams. */
function packAtlas(items, atlas, width) {
  const frames = []
  for (const item of items) {
    const states = item.states ?? { default: { frames: item.frames, durations: item.durations, loop: item.loop } }
    for (const [state, plan] of Object.entries(states)) plan.frames.forEach((pix, i) => frames.push({ item, state, i, pix }))
  }
  const order = [...frames].sort((a, b) => b.pix.h - a.pix.h || b.pix.w - a.pix.w || a.item.id.localeCompare(b.item.id))
  let x = GAP, y = GAP, shelf = 0
  for (const f of order) {
    if (x + f.pix.w + GAP > width) { x = GAP; y += shelf + GAP; shelf = 0 }
    f.x = x; f.y = y
    x += f.pix.w + GAP
    shelf = Math.max(shelf, f.pix.h)
  }
  const pix = new Pix(width, y + shelf + GAP)
  for (const f of frames) {
    pix.blit(f.pix, 0, 0, f.pix.w, f.pix.h, f.x, f.y)
    if (f.item.id.startsWith('tile.')) {
      for (let k = 0; k < f.pix.w; k++) { pix.set(f.x + k, f.y - 1, f.pix.get(k, 0)); pix.set(f.x + k, f.y + f.pix.h, f.pix.get(k, f.pix.h - 1)) }
      for (let k = -1; k <= f.pix.h; k++) { const sy = Math.min(Math.max(k, 0), f.pix.h - 1); pix.set(f.x - 1, f.y + k, f.pix.get(0, sy)); pix.set(f.x + f.pix.w, f.y + k, f.pix.get(f.pix.w - 1, sy)) }
    }
  }
  const sprites = {}
  for (const item of items) {
    const states = item.states ?? { default: { frames: item.frames, durations: item.durations, loop: item.loop } }
    const out = {}
    for (const [state, plan] of Object.entries(states)) {
      out[state] = {
        frames: plan.frames.map((pix, i) => {
          const f = frames.find((g) => g.item === item && g.state === state && g.i === i)
          return { rect: { x: f.x, y: f.y, width: pix.w, height: pix.h }, anchor: { ...item.anchor }, hitRect: { x: 0, y: 0, width: pix.w, height: pix.h } }
        }),
        durationsMs: [...plan.durations],
        loop: plan.loop ?? plan.frames.length > 1
      }
    }
    sprites[item.id] = { atlas, layers: item.layers, states: out }
  }
  return { pix, sprites }
}

function preview(atlases, manifest) {
  // Every frame of every sprite, ×2, on a checkerboard, labelled.
  const S = 2, pad = 6, label = 8
  const rows = []
  for (const [id, sprite] of Object.entries(manifest.sprites)) for (const [state, anim] of Object.entries(sprite.states)) rows.push({ id, state, anim, atlas: sprite.atlas })
  const groups = []
  for (const r of rows) {
    const g = groups.at(-1)
    if (g && g.id === r.id) g.rows.push(r)
    else groups.push({ id: r.id, rows: [r] })
  }
  const W = 1600
  let y = pad, x = pad
  const placed = []
  for (const g of groups) {
    for (const r of g.rows) {
      const w = Math.max(r.anim.frames.reduce((n, f) => n + f.rect.width * S + 4, 0), (r.id.length + r.state.length + 2) * 4 * S) + pad
      const h = label * S + Math.max(...r.anim.frames.map((f) => f.rect.height)) * S + pad * 3
      if (x + w > W) { x = pad; y += Math.max(...placed.filter((p) => p.y === y).map((p) => p.h), 0) }
      placed.push({ r, x, y, w, h })
      x += w
    }
  }
  const H = y + Math.max(...placed.filter((p) => p.y === y).map((p) => p.h)) + pad
  const out = new Pix(W, H)
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) out.set(i, j, ((i >> 3) + (j >> 3)) % 2 ? '#efe4cf' : '#e4d6bb')
  const small = new Pix(W / S, H / S)
  for (const p of placed) text(small, Math.floor(p.x / S), Math.floor(p.y / S), `${p.r.id} ${p.r.state}`, '#5b3d2a')
  const big = small.scaled(S)
  out.blit(big, 0, 0, big.w, big.h, 0, 0)
  for (const p of placed) {
    let fx = p.x
    for (const f of p.r.anim.frames) {
      const src = atlases[p.r.atlas]
      const frame = new Pix(f.rect.width, f.rect.height)
      frame.blit(src, f.rect.x, f.rect.y, f.rect.width, f.rect.height, 0, 0)
      const scaled = frame.scaled(S)
      out.blit(scaled, 0, 0, scaled.w, scaled.h, fx, p.y + label * S)
      // anchor marker
      out.set(fx + f.anchor.x * S, p.y + label * S + f.anchor.y * S, '#e2574c')
      fx += f.rect.width * S + 4
    }
  }
  return out
}

export function build() {
  const agents = characterAtlas(KINDS, (kind, dir, pose) => drawBody(kind, dir, pose), 'agent', 'body')
  const roles = characterAtlas(ROLES, (role, dir, pose) => drawRole(role, dir, pose), 'role', 'role')
  const tiles = packAtlas(buildTiles(), 'tiles', 320)
  const effects = packAtlas(buildEffects(), 'effects', 128)
  const pixes = { tiles: tiles.pix, agents: agents.pix, roles: roles.pix, effects: effects.pix }
  const manifest = {
    version: 1,
    tile: { width: 16, height: 16 },
    character: { width: 32, height: 48, anchor: { x: 16, y: 44 } },
    atlases: Object.fromEntries(Object.entries(pixes).map(([id, p]) => [id, { file: `${id}.png`, width: p.w, height: p.h }])),
    layers: LAYERS,
    sprites: { ...tiles.sprites, ...agents.sprites, ...roles.sprites, ...effects.sprites }
  }
  return { pixes, manifest, preview: preview(pixes, manifest) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { pixes, manifest, preview: prev } = build()
  mkdirSync(OUT, { recursive: true })
  for (const [id, p] of Object.entries(pixes)) writeFileSync(join(OUT, `${id}.png`), encodePng(p.w, p.h, p.d))
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n')
  writeFileSync(join(OUT, 'preview.png'), encodePng(prev.w, prev.h, prev.d))
  const frames = Object.values(manifest.sprites).reduce((n, s) => n + Object.values(s.states).reduce((m, a) => m + a.frames.length, 0), 0)
  console.log(`office art → ${OUT}: ${Object.keys(manifest.sprites).length} sprites, ${frames} frames;`, Object.entries(manifest.atlases).map(([k, a]) => `${k} ${a.width}×${a.height}`).join(', '))
}
