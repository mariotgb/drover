// Office v2.1 art: two sets with identical keys — cozy («Мастерская», light theme) and
// neon («Неоновый хаб», dark theme). Writes atlases + manifest.json (version 2) per set into
// src/renderer/src/office/assets/v2/<set>/. Deterministic.
// Usage: node scripts/office-art/v2/build.mjs [--out <dir>]
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pix } from '../canvas.mjs'
import { encodePng } from '../png.mjs'
import { text } from '../font.mjs'
import { THEMES } from './themes.mjs'
import { buildTiles, S } from './kit-tiles.mjs'
import { buildObjects } from './kit-objects.mjs'
import { buildEffects, buildFont } from './kit-fx.mjs'
import { buildCharacters } from './kit-characters.mjs'
import { compositions, lighting, palette } from './kit-data.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export const SETS = { cozy: 'light', neon: 'dark' }
export const LAYERS_V2 = ['floor', 'floor-shade', 'rug', 'wall', 'wall-decor', 'furniture-back', 'body', 'role', 'furniture', 'furniture-top', 'wall-front', 'effect']
const GAP = 2
const WIDTH = { tiles: 256, furniture: 640, agents: 680, roles: 680, effects: 512 }

function pack(items, atlas) {
  const width = WIDTH[atlas]
  const frames = []
  for (const item of items) for (const [state, plan] of Object.entries(item.states)) plan.frames.forEach((f, i) => {
    frames.push({ item, state, i, kind: 'pix', pix: f.pix })
    if (f.emit) frames.push({ item, state, i, kind: 'emit', pix: f.emit })
  })
  const order = [...frames].sort((a, b) => b.pix.h - a.pix.h || b.pix.w - a.pix.w || a.item.id.localeCompare(b.item.id) || a.state.localeCompare(b.state) || a.i - b.i || a.kind.localeCompare(b.kind))
  let x = GAP, y = GAP, shelf = 0
  for (const f of order) {
    if (x + f.pix.w + GAP > width) { x = GAP; y += shelf + GAP; shelf = 0 }
    f.x = x; f.y = y; x += f.pix.w + GAP; shelf = Math.max(shelf, f.pix.h)
  }
  const pix = new Pix(width, y + shelf + GAP)
  for (const f of frames) {
    pix.blit(f.pix, 0, 0, f.pix.w, f.pix.h, f.x, f.y)
    if (f.item.id.startsWith('tile.') && f.kind === 'pix') {
      for (let k = 0; k < f.pix.w; k++) { pix.set(f.x + k, f.y - 1, f.pix.get(k, 0)); pix.set(f.x + k, f.y + f.pix.h, f.pix.get(k, f.pix.h - 1)) }
      for (let k = -1; k <= f.pix.h; k++) { const sy = Math.min(Math.max(k, 0), f.pix.h - 1); pix.set(f.x - 1, f.y + k, f.pix.get(0, sy)); pix.set(f.x + f.pix.w, f.y + k, f.pix.get(f.pix.w - 1, sy)) }
    }
  }
  const find = (item, state, i, kind) => frames.find((g) => g.item === item && g.state === state && g.i === i && g.kind === kind)
  const sprites = {}
  for (const item of items) {
    const states = {}
    for (const [state, plan] of Object.entries(item.states)) {
      const anchor = plan.anchor ?? item.anchor
      states[state] = {
        frames: plan.frames.map((f, i) => {
          const a = find(item, state, i, 'pix'), e = f.emit ? find(item, state, i, 'emit') : null
          const hit = item.hit ?? { x: 0, y: 0, width: f.pix.w, height: f.pix.h }
          return { rect: { x: a.x, y: a.y, width: f.pix.w, height: f.pix.h }, anchor: { ...anchor }, hitRect: { ...hit }, ...(e ? { emit: { x: e.x, y: e.y, width: f.pix.w, height: f.pix.h } } : {}) }
        }),
        durationsMs: [...plan.durations],
        loop: plan.loop
      }
    }
    sprites[item.id] = { atlas, layers: item.layers, states, ...(item.lights?.length ? { lights: item.lights.map((l) => ({ ...l, color: l.color.map((v) => Math.round(v * 100) / 100) })) } : {}), ...(item.slots ? { slots: item.slots } : {}) }
  }
  return { pix, sprites }
}

const NINE = (P) => ({
  'plaque.default': { sprite: 'effect.plaque', state: 'default', left: 3, right: 3, height: 9, markX: 2, markY: 2, textX: 9, textY: 2, maxWidth: 46 },
  'plaque.blocked': { sprite: 'effect.plaque', state: 'blocked', left: 3, right: 3, height: 9, markX: 2, markY: 2, textX: 9, textY: 2, maxWidth: 46 },
  'plaque.lead': { sprite: 'effect.plaque', state: 'lead', left: 3, right: 3, height: 9, markX: 2, markY: 2, textX: 9, textY: 2, maxWidth: 46 },
  'plaque.you': { sprite: 'effect.plaque', state: 'you', left: 3, right: 3, height: 9, markX: 2, markY: 2, textX: 9, textY: 2, maxWidth: 46 },
  'label.dark': { sprite: 'effect.label', state: 'dark', left: 3, right: 3, height: 9, textX: 3, textY: 2, font: 'light' },
  'label.light': { sprite: 'effect.label', state: 'light', left: 3, right: 3, height: 9, textX: 3, textY: 2, font: 'ink' },
  'label.warn': { sprite: 'effect.label', state: 'warn', left: 3, right: 3, height: 9, textX: 3, textY: 2, font: 'warn' },
  'sign.x1': { sprite: 'object.sign', state: 'x1', left: 7, right: 7, height: 14, textX: 6, textY: 6, scale: 1, font: 'sign' },
  'sign.x2': { sprite: 'object.sign', state: 'x2', left: 7, right: 7, height: 19, textX: 8, textY: 6, scale: 2, font: 'sign' }
})

export function buildSet(setId) {
  const P = THEMES[setId]
  const items = [...buildTiles(P), ...buildObjects(P), ...buildCharacters(P), ...buildEffects(P)]
  const ids = new Set()
  for (const it of items) { if (ids.has(it.id)) throw new Error(`duplicate ${it.id}`); ids.add(it.id) }
  const atlases = {}, sprites = {}
  for (const atlas of ['tiles', 'furniture', 'agents', 'roles', 'effects']) {
    const packed = pack(items.filter((it) => it.atlas === atlas), atlas)
    atlases[atlas] = packed.pix
    Object.assign(sprites, packed.sprites)
  }
  const font = buildFont(P)
  atlases.font = font.pix
  const manifest = {
    version: 2, set: setId, theme: SETS[setId],
    tile: { width: 16, height: 16 }, character: { width: 32, height: 48, anchor: { x: 16, y: 44 } },
    atlases: Object.fromEntries(Object.entries(atlases).map(([id, p]) => [id, { file: `${id}.png`, width: p.w, height: p.h }])),
    layers: LAYERS_V2,
    lighting: lighting(P), palette: palette(P), font: font.meta, nineSlices: NINE(P), compositions: compositions(P),
    sprites: Object.fromEntries(Object.keys(sprites).sort().map((k) => [k, sprites[k]]))
  }
  return { pixes: atlases, manifest }
}

/** Every frame of every sprite on a labelled sheet (×2), emissive frames on a dark strip. */
export function previewSheet(set) {
  const { pixes, manifest } = set
  const S2 = 2, pad = 6, label = 8, W = 2400
  const rows = []
  for (const [id, sprite] of Object.entries(manifest.sprites)) for (const [state, anim] of Object.entries(sprite.states)) rows.push({ id, state, anim, atlas: sprite.atlas })
  let x = pad, y = pad, rowH = 0
  const placed = []
  for (const r of rows) {
    const fw = r.anim.frames.reduce((n, f) => n + f.rect.width * S2 + 4, 0)
    const w = Math.max(fw, (r.id.length + r.state.length + 2) * 4 * S2) + pad
    const h = label * S2 + Math.max(...r.anim.frames.map((f) => f.rect.height)) * S2 + pad * 2
    if (x + w > W) { x = pad; y += rowH; rowH = 0 }
    placed.push({ r, x, y }); x += w; rowH = Math.max(rowH, h)
  }
  const H = y + rowH + pad
  const out = new Pix(W, H)
  const dark = manifest.theme === 'dark'
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) out.set(i, j, ((i >> 3) + (j >> 3)) % 2 ? (dark ? '#1b2030' : '#efe4cf') : (dark ? '#161a28' : '#e4d6bb'))
  const small = new Pix(W / S2, Math.ceil(H / S2))
  for (const p of placed) text(small, Math.floor(p.x / S2), Math.floor(p.y / S2), `${p.r.id} ${p.r.state}`.replace(/[^A-Za-z0-9.:_\- ]/g, '?'), dark ? '#9fb3c8' : '#5b3d2a')
  const big = small.scaled(S2)
  out.blit(big, 0, 0, big.w, big.h, 0, 0)
  for (const p of placed) {
    let fx = p.x
    for (const f of p.r.anim.frames) {
      const src = pixes[p.r.atlas]
      const fr = new Pix(f.rect.width, f.rect.height)
      fr.blit(src, f.rect.x, f.rect.y, f.rect.width, f.rect.height, 0, 0)
      if (f.emit) fr.blit(src, f.emit.x, f.emit.y, f.emit.width, f.emit.height, 0, 0)
      const sc = fr.scaled(S2)
      out.blit(sc, 0, 0, sc.w, sc.h, fx, p.y + label * S2)
      const ax = fx + f.anchor.x * S2, ay = p.y + label * S2 + f.anchor.y * S2
      if (out.in(ax, ay)) { out.set(ax, ay, '#e2574c'); out.set(ax + 1, ay, '#e2574c') }
      fx += f.rect.width * S2 + 4
    }
  }
  return out
}

export function writeSet(setId, root) {
  const set = buildSet(setId)
  const dir = join(root, setId)
  mkdirSync(dir, { recursive: true })
  for (const [id, p] of Object.entries(set.pixes)) writeFileSync(join(dir, `${id}.png`), encodePng(p.w, p.h, p.d))
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(set.manifest) + '\n')
  return set
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outArg = process.argv.indexOf('--out')
  const root = resolve(outArg > 0 ? process.argv[outArg + 1] : join(here, '../../../src/renderer/src/office/assets/v2'))
  for (const setId of Object.keys(SETS)) {
    const set = writeSet(setId, root)
    const frames = Object.values(set.manifest.sprites).reduce((n, s) => n + Object.values(s.states).reduce((m, a) => m + a.frames.length, 0), 0)
    console.log(`${setId}: ${Object.keys(set.manifest.sprites).length} sprites, ${frames} frames;`, Object.entries(set.manifest.atlases).map(([k, a]) => `${k} ${a.width}×${a.height}`).join(', '))
  }
}
export { S }
