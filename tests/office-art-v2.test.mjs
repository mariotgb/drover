import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve('src/renderer/src/office/assets/v2')
const { buildSet, SETS } = await import(resolve('scripts/office-art/v2/build.mjs'))
const { decodePng } = await import(resolve('scripts/office-art/png.mjs'))
const { POSES, SIDE_POSES } = await import(resolve('scripts/office-art/v2/kit-characters.mjs'))
const { GLYPHS, SAME, FOLD } = await import(resolve('scripts/office-art/v2/pixfont.mjs'))
const sets = Object.fromEntries(Object.keys(SETS).map((id) => [id, { built: buildSet(id), manifest: JSON.parse(readFileSync(join(ROOT, id, 'manifest.json'), 'utf8')) }]))
const png = (id, atlas) => decodePng(readFileSync(join(ROOT, id, `${atlas}.png`)))

test('committed v2 art is exactly what the generator produces', () => {
  for (const [id, { built, manifest }] of Object.entries(sets)) {
    assert.deepEqual(manifest, JSON.parse(JSON.stringify(built.manifest)), `${id} manifest: run node scripts/office-art/v2/build.mjs`)
    for (const [atlas, pix] of Object.entries(built.pixes)) {
      const p = png(id, atlas)
      assert.deepEqual([p.width, p.height], [pix.w, pix.h], `${id}/${atlas}`)
      assert.ok(Buffer.from(p.data.buffer).equals(Buffer.from(pix.d.buffer)), `${id}/${atlas}.png pixels differ`)
    }
  }
})

test('cozy and neon share every sprite, state, slot, nine-slice and composition key', () => {
  const [a, b] = [sets.cozy.manifest, sets.neon.manifest]
  assert.equal(a.version, 2); assert.equal(b.version, 2)
  assert.deepEqual([a.theme, b.theme], ['light', 'dark'])
  assert.deepEqual(Object.keys(a.sprites), Object.keys(b.sprites))
  for (const id of Object.keys(a.sprites)) {
    assert.deepEqual(Object.keys(a.sprites[id].states), Object.keys(b.sprites[id].states), `${id} states`)
    assert.deepEqual(Object.keys(a.sprites[id].slots ?? {}), Object.keys(b.sprites[id].slots ?? {}), `${id} slots`)
    for (const st of Object.keys(a.sprites[id].states)) assert.equal(a.sprites[id].states[st].frames.length, b.sprites[id].states[st].frames.length, `${id} ${st} frame count`)
  }
  assert.deepEqual(Object.keys(a.nineSlices), Object.keys(b.nineSlices))
  assert.deepEqual(Object.keys(a.compositions), Object.keys(b.compositions))
  assert.deepEqual(Object.keys(a.atlases), Object.keys(b.atlases))
  assert.deepEqual(a.layers, b.layers)
})

test('frames, emissive rects and lights are valid', () => {
  for (const [id, { manifest }] of Object.entries(sets)) {
    for (const [sid, sprite] of Object.entries(manifest.sprites)) {
      const { width, height } = manifest.atlases[sprite.atlas]
      assert.ok(sprite.layers.every((l) => manifest.layers.includes(l)), `${id} ${sid} layers`)
      for (const [st, anim] of Object.entries(sprite.states)) {
        assert.equal(anim.durationsMs.length, anim.frames.length, `${sid} ${st}`)
        assert.ok(anim.durationsMs.every((ms) => Number.isInteger(ms) && ms > 0))
        for (const f of anim.frames) for (const r of [f.rect, f.emit].filter(Boolean)) {
          assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= width && r.y + r.height <= height, `${id} ${sid} ${st} rect in ${sprite.atlas}`)
          assert.ok([r.x, r.y, r.width, r.height, f.anchor.x, f.anchor.y].every(Number.isInteger), `${sid} integer`)
        }
        for (const f of anim.frames) if (f.emit) assert.deepEqual([f.emit.width, f.emit.height], [f.rect.width, f.rect.height], `${sid} emit size`)
      }
      for (const l of sprite.lights ?? []) {
        assert.equal(l.color.length, 3); assert.ok(l.rx > 0 && l.ry > 0 && l.k > 0, `${sid} light`)
        for (const s of l.states ?? []) assert.ok(sprite.states[s], `${sid} light state ${s}`)
      }
    }
  }
})

test('every agent kind and role has all poses (front/back + side walk/stand), 32×48 at (16,44)', () => {
  for (const { manifest } of Object.values(sets)) {
    const people = Object.keys(manifest.sprites).filter((k) => /^(agent|role)\.(claude|codex|gemini|general|lead|reviewer|devops|frontend|backend|docs|designer)$/.test(k))
    assert.equal(people.length, 12)
    for (const id of people) {
      for (const pose of Object.keys(POSES)) for (const dir of ['front', 'back']) assert.ok(manifest.sprites[id].states[`${pose}:${dir}`], `${id} ${pose}:${dir}`)
      for (const pose of SIDE_POSES) assert.ok(manifest.sprites[id].states[`${pose}:side`], `${id} ${pose}:side`)
      for (const anim of Object.values(manifest.sprites[id].states)) for (const f of anim.frames) { assert.deepEqual([f.rect.width, f.rect.height], [32, 48]); assert.deepEqual(f.anchor, { x: 16, y: 44 }) }
    }
    for (const st of ['idle:front', 'throw:front']) assert.ok(manifest.sprites['agent.user'].states[st], `agent.user ${st}`)
    for (const st of ['sit:front', 'stand:front', 'dispatch:front', 'pleased:front', 'walk:side']) assert.ok(manifest.sprites['agent.boss'].states[st], `agent.boss ${st}`)
  }
})

test('building, interaction and ambient sprites the engine needs exist', () => {
  const need = [
    'tile.floor.hall.0', 'tile.floor.corridor.0', 'tile.floor.lobby.0', 'tile.floor.server', 'tile.ground.0', 'tile.ground.path.0', 'tile.rug.c', 'tile.runner.c',
    'tile.wall.cap', 'tile.wall.side', 'tile.wall.front', 'tile.wall.face.0', 'tile.wall.shade.top', 'tile.facade.plain',
    'object.bench.col', 'object.monitor.front', 'object.monitor.back', 'object.chair.front', 'object.chair.back', 'object.chair.lead', 'object.desk.head', 'object.table.meeting',
    'object.reception', 'object.bell', 'object.directory', 'object.rack', 'object.machine', 'object.window', 'object.board', 'object.board.note', 'object.sign', 'object.clock',
    'object.doorway', 'object.entrance', 'object.tree.big', 'object.lamp.post', 'object.hedge', 'object.cat', 'object.robot',
    'object.desk.boss', 'object.chair.boss', 'object.flag', 'object.trophy', 'object.phone', 'object.rug.boss',
    'effect.carrier', 'effect.trail', 'effect.arrival', 'effect.note', 'effect.attempt', 'effect.crumple', 'effect.spark', 'effect.confetti', 'effect.bubble',
    'effect.status', 'effect.plaque', 'effect.plaque.pointer', 'effect.label', 'effect.select', 'effect.steam', 'effect.packet', 'effect.cable', 'effect.activity',
    'effect.card', 'effect.link.dot', 'effect.flash', 'effect.glow'
  ]
  for (const { manifest } of Object.values(sets)) {
    for (const id of need) assert.ok(manifest.sprites[id], id)
    for (let i = 0; i < 16; i++) for (const who of ['agent', 'user', 'boss']) assert.ok(manifest.sprites['effect.carrier'].states[`${who}:${i}`], `carrier ${who}:${i}`)
    for (const k of ['?', '!', 'ok']) assert.ok(manifest.sprites['effect.bubble'].states[k])
    for (const st of ['code', 'ask', 'term', 'done', 'off']) assert.ok(manifest.sprites['object.monitor.front'].states[st])
    for (const slot of ['agentNorth', 'agentSouth', 'plaqueNorth', 'plaqueSouth', 'handNorth', 'landSouth', 'cableNorth']) assert.ok(manifest.sprites['object.bench.col'].slots[slot], slot)
  }
})

test('font covers Latin, Cyrillic, digits; nine-slices and compositions point at real sprites', () => {
  for (const { manifest } of Object.values(sets)) {
    const chars = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', ...'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ', ...'-_.:/!?+']
    for (const ch of chars) assert.ok(manifest.font.glyphs[ch], `glyph ${ch}`)
    assert.equal(Object.keys(manifest.font.glyphs).length, Object.keys(GLYPHS).length + Object.keys(SAME).length + Object.keys(FOLD).length)
    for (const ch of [...'ÄÖÜÉÓÑ¿¡']) assert.ok(manifest.font.glyphs[ch], `folded glyph ${ch}`)
    assert.equal('ß'.toUpperCase(), 'SS', 'uppercase lookup turns ß into SS')
    for (const [k, n] of Object.entries(manifest.nineSlices)) assert.ok(manifest.sprites[n.sprite]?.states[n.state], `nine-slice ${k}`)
    const refs = []
    const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') { if (typeof v.sprite === 'string') refs.push(v); Object.values(v).forEach(walk) } }
    walk(manifest.compositions)
    assert.ok(refs.length > 30)
    for (const r of refs) { assert.ok(manifest.sprites[r.sprite], `composition sprite ${r.sprite}`); if (r.state) assert.ok(manifest.sprites[r.sprite].states[r.state], `${r.sprite} ${r.state}`) }
  }
})
