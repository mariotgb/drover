// Preview sheets from the COMMITTED v2 assets (manifest + PNG atlases), like the engine sees them.
// Usage: node scripts/office-art/v2/previews.mjs <outDir> [prefix]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Pix } from '../canvas.mjs'
import { encodePng, decodePng } from '../png.mjs'
import { previewSheet } from './build.mjs'
import { renderSample, renderRoomSample, SAMPLE_AGENTS } from './atlas-sample.mjs'

const ROOT = resolve('src/renderer/src/office/assets/v2')
const out = resolve(process.argv[2] ?? 'previews'), prefix = process.argv[3] ?? 'office-v21-art'
mkdirSync(out, { recursive: true })
const save = (name, pix, k = 1) => { const s = k === 1 ? pix : pix.scaled(k); writeFileSync(join(out, name), encodePng(s.w, s.h, s.d)); console.log(name, s.w, s.h) }
for (const id of ['cozy', 'neon']) {
  const manifest = JSON.parse(readFileSync(join(ROOT, id, 'manifest.json'), 'utf8'))
  const pixes = {}
  for (const [atlas, info] of Object.entries(manifest.atlases)) { const p = decodePng(readFileSync(join(ROOT, id, info.file))); const pix = new Pix(p.width, p.height); pix.d.set(p.data); pixes[atlas] = pix }
  const set = { manifest, pixes }
  save(`${prefix}-${id}.png`, previewSheet(set))
  save(`${prefix}-${id}-sample.png`, renderSample(set, { agents: SAMPLE_AGENTS }), 3)
  const parts = [renderRoomSample(set, 'lobby'), renderRoomSample(set, 'boss'), renderRoomSample(set, 'boss', { bossPose: 'dispatch:front' })]
  const W = parts.reduce((w, p) => w + p.w + 8, -8), H = Math.max(...parts.map((p) => p.h))
  const rooms = new Pix(W, H); let x = 0; for (const p of parts) { rooms.blit(p, 0, 0, p.w, p.h, x, 0); x += p.w + 8 }
  save(`${prefix}-${id}-rooms.png`, rooms, 3)
}
