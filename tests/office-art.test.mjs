import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ASSETS = resolve('src/renderer/src/office/assets')
const { build } = await import(resolve('scripts/office-art/build.mjs'))
const { decodePng } = await import(resolve('scripts/office-art/png.mjs'))
const manifest = JSON.parse(readFileSync(join(ASSETS, 'manifest.json'), 'utf8'))
const generated = build()
const STATES = ['idle', 'working', 'blocked', 'done', 'unknown']
const DIRECTIONS = ['front', 'back']
const atlas = (id) => decodePng(readFileSync(join(ASSETS, manifest.atlases[id].file)))

test('committed art is exactly what the generator produces', () => {
  assert.deepEqual(manifest, JSON.parse(JSON.stringify(generated.manifest)))
  for (const [id, pix] of Object.entries(generated.pixes)) {
    const png = atlas(id)
    assert.equal(png.width, pix.w, id)
    assert.equal(png.height, pix.h, id)
    assert.ok(Buffer.from(png.data.buffer).equals(Buffer.from(pix.d.buffer)), `${id}.png pixels differ: run node scripts/office-art/build.mjs`)
  }
})

test('manifest v1 matches the office contract', () => {
  assert.equal(manifest.version, 1)
  assert.deepEqual(manifest.tile, { width: 16, height: 16 })
  assert.deepEqual(manifest.character, { width: 32, height: 48, anchor: { x: 16, y: 44 } })
  assert.deepEqual(Object.keys(manifest.atlases).sort(), ['agents', 'effects', 'roles', 'tiles'])
  for (const [id, info] of Object.entries(manifest.atlases)) {
    const png = atlas(id)
    assert.equal(info.file, `${id}.png`)
    assert.deepEqual([png.width, png.height], [info.width, info.height], id)
  }
  for (const [id, sprite] of Object.entries(manifest.sprites)) {
    assert.ok(manifest.atlases[sprite.atlas], id)
    assert.ok(sprite.layers.length && sprite.layers.every((l) => manifest.layers.includes(l)), `${id} layers`)
    const { width, height } = manifest.atlases[sprite.atlas]
    for (const [state, anim] of Object.entries(sprite.states)) {
      assert.ok(anim.frames.length > 0, `${id} ${state}`)
      assert.equal(anim.durationsMs.length, anim.frames.length, `${id} ${state} durations`)
      assert.ok(anim.durationsMs.every((ms) => Number.isInteger(ms) && ms > 0), `${id} ${state} durations > 0`)
      for (const f of anim.frames) {
        const r = f.rect
        assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= width && r.y + r.height <= height, `${id} ${state} rect inside ${sprite.atlas}`)
        assert.ok(f.hitRect.x >= 0 && f.hitRect.y >= 0 && f.hitRect.x + f.hitRect.width <= r.width && f.hitRect.y + f.hitRect.height <= r.height, `${id} ${state} hitRect`)
        assert.ok([r.x, r.y, r.width, r.height, f.anchor.x, f.anchor.y].every(Number.isInteger), `${id} integer pixels`)
      }
    }
  }
})

test('every agent kind and role covers all states × directions, 2–6 frames, aligned frames', () => {
  const agents = Object.keys(manifest.sprites).filter((id) => id.startsWith('agent.'))
  const roles = Object.keys(manifest.sprites).filter((id) => id.startsWith('role.'))
  assert.deepEqual(agents.sort(), ['agent.claude', 'agent.codex', 'agent.gemini', 'agent.general'])
  assert.deepEqual(roles.sort(), ['backend', 'designer', 'devops', 'docs', 'frontend', 'general', 'lead', 'reviewer'].map((r) => `role.${r}`))
  const reference = manifest.sprites['agent.general']
  for (const id of [...agents, ...roles]) {
    const sprite = manifest.sprites[id]
    for (const state of STATES) for (const dir of DIRECTIONS) {
      const anim = sprite.states[`${state}:${dir}`]
      assert.ok(anim, `${id} ${state}:${dir}`)
      assert.ok(anim.frames.length >= 2 && anim.frames.length <= 6, `${id} ${state}:${dir} frame count`)
      assert.deepEqual(anim.durationsMs, reference.states[`${state}:${dir}`].durationsMs, `${id} timing matches body`)
      for (const f of anim.frames) {
        assert.deepEqual([f.rect.width, f.rect.height], [32, 48])
        assert.deepEqual(f.anchor, { x: 16, y: 44 })
      }
    }
  }
})

test('unknown has no motion; other states animate', () => {
  for (const sprite of ['agent.claude', 'agent.codex', 'agent.gemini', 'agent.general']) {
    const png = atlas('agents')
    const pixels = (f) => {
      const out = []
      for (let y = 0; y < f.rect.height; y++) out.push(Buffer.from(png.data.buffer, ((f.rect.y + y) * png.width + f.rect.x) * 4, f.rect.width * 4).toString('hex'))
      return out.join('')
    }
    for (const dir of DIRECTIONS) {
      const unknown = manifest.sprites[sprite].states[`unknown:${dir}`].frames.map(pixels)
      assert.ok(unknown.every((p) => p === unknown[0]), `${sprite} unknown:${dir} is static`)
      for (const state of ['working', 'blocked']) {
        const frames = manifest.sprites[sprite].states[`${state}:${dir}`].frames.map(pixels)
        assert.ok(new Set(frames).size > 1, `${sprite} ${state}:${dir} animates`)
      }
    }
  }
})

test('rooms, furniture and effects the office needs are present at grid sizes', () => {
  const size = (id, state = Object.keys(manifest.sprites[id].states)[0]) => { const r = manifest.sprites[id].states[state].frames[0].rect; return [r.width, r.height] }
  for (const id of ['tile.floor.wood.0', 'tile.floor.server', 'tile.wall.cap', 'tile.wall.cap.front', 'tile.wall.face.top', 'tile.wall.face.bottom', 'tile.wall.shadow', 'tile.floor.carpet.red.c']) assert.deepEqual(size(id), [16, 16], id)
  for (const id of ['object.desk.front', 'object.desk.back', 'object.desk.terminal']) {
    assert.deepEqual(size(id, 'on'), [64, 48], `${id} is 4×3 tiles`)
    assert.ok(manifest.sprites[id].states.off, `${id} off`)
    assert.deepEqual(manifest.sprites[id].states.on.frames[0].anchor, { x: 32, y: 48 })
  }
  for (const id of ['object.door', 'object.sign', 'object.window', 'object.taskboard', 'object.plant.big', 'object.plant.small', 'object.cooler', 'object.sofa', 'object.server.rack', 'object.machine.pc', 'object.machine.homeserver', 'object.chair.front', 'object.chair.back'])
    assert.ok(manifest.sprites[id], id)
  const user = manifest.sprites['object.user']
  assert.ok(user?.states.default, 'object.user (the «Вы» node)')
  assert.equal(user.atlas, 'tiles')
  assert.deepEqual(user.layers, ['body'])
  assert.ok(user.states.default.loop && user.states.default.frames.length >= 2 && user.states.default.frames.length <= 6, 'object.user idles')
  for (const f of user.states.default.frames) {
    assert.deepEqual([f.rect.width, f.rect.height], [32, 48], 'object.user uses the character frame')
    assert.deepEqual(f.anchor, { x: 16, y: 44 }, 'object.user feet at the character anchor')
  }
  for (const id of ['effect.envelope', 'effect.question', 'effect.alert', 'effect.error', 'effect.attempt', 'effect.dash', 'effect.cable.h', 'effect.cable.v', 'effect.cable.plug', 'effect.sparkle', 'effect.select'])
    assert.equal(manifest.sprites[id]?.atlas, 'effects', id)
})
