import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'drover-office-renderer-'))
await build({
  stdin: { contents: ['layout', 'camera', 'scheduler', 'effects', 'engine', 'scene', 'labels', 'navigation', 'routes'].map(name => `export * from './src/renderer/src/office/${name}'`).join('\n') + "\nexport { setLanguage } from './src/renderer/src/i18n'", resolveDir: resolve('.'), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', outfile: join(dir, 'renderer.cjs'), alias: { '@shared': resolve('src/shared') }, logLevel: 'silent',
  plugins: [{ name: 'procedural-office-art', setup(b) {
    b.onResolve({ filter: /^\.\/art$/ }, () => ({ path: 'art', namespace: 'office-fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'office-fixture' }, () => ({ contents: `const manifest = ${readFileSync('src/renderer/src/office/assets/manifest.json', 'utf8')};
    export class OfficeArt {
      manifest = manifest; async load() {};
      frame(id, state, time) {
        const sprite = manifest.sprites[id]; if (!sprite) return;
        const animation = sprite.states[state] ?? sprite.states.default ?? Object.values(sprite.states)[0];
        let age = Math.max(0, time) % animation.durationsMs.reduce((sum, ms) => sum + ms, 0);
        for (let i = 0; i < animation.frames.length; i++) { age -= animation.durationsMs[i]; if (age < 0) return animation.frames[i] }
        return animation.frames[0];
      }
      paint(_context, id, state, anchor, time) { globalThis.officeArtCalls?.push({ id, state, anchor, time }); return !!manifest.sprites[id] };
      hitRect(_id, _state, anchor) { return { x: anchor.x - 12, y: anchor.y - 36, width: 24, height: 40 } }
    }`, loader: 'js' }))
  } }]
})
const m = createRequire(import.meta.url)(join(dir, 'renderer.cjs'))
rmSync(dir, { recursive: true })
const projects = n => Array.from({ length: n }, (_, i) => ({ id: `project-${i}`, number: i + 1 }))
const agents = (n, projectCount = 1) => Array.from({ length: n }, (_, i) => ({ paneId: `pane-${String(i).padStart(3, '0')}`, departmentId: `project-${i % projectCount}` }))
const intersects = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

test('0/1/20 departments and 0/8/200 agents: finite bounds, eight desks per lot, no overlaps', () => {
  for (const count of [0, 1, 20]) for (const size of [0, 8, 200]) {
    const state = new m.OfficeLayout().update(projects(count).reverse(), count ? agents(size, count).reverse() : [])
    assert.ok(state.bounds.width > 0 && state.bounds.height > 0)
    assert.equal(state.seats.length, count ? size : 0)
    for (const seat of state.seats) {
      assert.equal(seat.width, 4 * 16); assert.equal(seat.height, 3 * 16)
      assert.ok(state.lots.some(l => l.departmentId === seat.departmentId && seat.x >= l.x && seat.y >= l.y && seat.x + seat.width <= l.x + l.width && seat.y + seat.height <= l.y + l.height))
    }
    for (let i = 0; i < state.seats.length; i++) for (let j = i + 1; j < state.seats.length; j++) {
      const a = state.seats[i], b = state.seats[j]
      assert.ok(!intersects(a, b))
      if (a.y === b.y) assert.ok(Math.abs(a.x - b.x) - a.width >= 2 * 16)
    }
    for (let i = 0; i < state.lots.length; i++) {
      const lot = state.lots[i]
      assert.equal(lot.width, 24 * 16); assert.equal(lot.height, 20 * 16)
      assert.ok(state.seats.filter(s => s.departmentId === lot.departmentId && Math.floor(s.index / 8) === lot.block).length <= 8)
      for (let j = i + 1; j < state.lots.length; j++) assert.ok(!intersects(lot, state.lots[j]))
    }
  }
})

test('departments start in a row or a three-column grid; later additions preserve anchors', () => {
  for (const n of [1, 2, 3, 4, 12, 20]) {
    const { lots } = new m.OfficeLayout().update(projects(n), [])
    for (let i = 0; i < n; i++) { assert.equal(lots[i].x, (i % 3) * 26 * 16); assert.equal(lots[i].y, Math.floor(i / 3) * 22 * 16) }
  }
  const layout = new m.OfficeLayout(), initial = layout.update(projects(1), agents(8))
  const expanded = layout.update(projects(20), agents(8))
  assert.deepEqual(expanded.seats, initial.seats)
  assert.deepEqual(expanded.lots[0], initial.lots[0])
})

test('split, move, restart, status/rename and removals do not shuffle neighbors; repack is explicit', () => {
  const layout = new m.OfficeLayout(), list = agents(8)
  const initial = layout.update(projects(2), list)
  const split = layout.update(projects(2), [...list, { paneId: 'pane-new', departmentId: 'project-0' }])
  assert.deepEqual(split.seats.slice(0, 8), initial.seats)
  assert.equal(split.lots.filter(l => l.departmentId === 'project-0').length, 2)
  const restarted = layout.update(projects(2), list.map(a => ({ ...a, incarnation: 'new', status: 'blocked', name: 'renamed' })))
  assert.deepEqual(restarted.seats, initial.seats)
  const moved = layout.update(projects(2), list.map((a, i) => i ? a : { ...a, departmentId: 'project-1' }))
  assert.equal(moved.seats[0].departmentId, 'project-1')
  assert.deepEqual(moved.seats.slice(1), initial.seats.slice(1))
  const removed = layout.update(projects(2), list.slice(2))
  assert.deepEqual(removed.seats, initial.seats.slice(2))
  const compact = layout.update(projects(2), list.slice(2), true)
  assert.equal(compact.seats[0].index, 0)
  assert.notDeepEqual(compact.seats[0].anchor, initial.seats[2].anchor)
})

test('camera preserves a zoom anchor, fit is finite, hits use CSS pixels and reverse Y order', () => {
  const camera = { x: -20, y: 30, zoom: 2 }, screen = { x: 84, y: 106 }
  assert.deepEqual(m.screenToWorld(screen, camera), { x: 52, y: 38 })
  assert.deepEqual(m.worldToScreen(m.screenToWorld(screen, camera), camera), screen)
  const zoomed = m.zoomAt(camera, 3, screen)
  assert.deepEqual(m.screenToWorld(screen, zoomed), m.screenToWorld(screen, camera))
  assert.ok(Number.isFinite(m.fitCamera({ x: -32, y: -32, width: 1200, height: 1000 }, 1, 1).zoom))
  const targets = [{ paneId: 'back', rect: { x: 40, y: 30, width: 32, height: 48 }, y: 40 }, { paneId: 'front', rect: { x: 40, y: 30, width: 32, height: 48 }, y: 50 }]
  assert.equal(m.hitTest(targets, screen, camera), 'front')
  assert.equal(m.hitTest(targets, { x: 0, y: 0 }, camera), null)
  targets[0].y = 50
  assert.equal(m.hitTest(targets, screen, camera), 'front')
})

test('click threshold is four CSS pixels and a drag stays a drag after returning', () => {
  const gesture = new m.DragGesture()
  gesture.begin({ x: 10, y: 10 }); assert.equal(gesture.end({ x: 14, y: 10 }), true)
  gesture.begin({ x: 10, y: 10 }); assert.equal(gesture.move({ x: 14.1, y: 10 }), true); assert.equal(gesture.end({ x: 10, y: 10 }), false)
  gesture.begin({ x: 10, y: 10 }); gesture.cancel(); assert.equal(gesture.end({ x: 10, y: 10 }), false)
})

function frameHost() {
  let id = 0
  const pending = new Map()
  return { pending, request: cb => { pending.set(++id, cb); return id }, cancel: id => pending.delete(id), tick(time) { const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(cb => cb(time)) } }
}

test('one RAF: <=30 FPS, <=5 FPS in background, zero hidden and no leaked handles', () => {
  const host = frameHost(), drawn = [], loop = new m.FrameLoop(host, time => drawn.push(time))
  assert.equal(host.pending.size, 0)
  loop.setVisibility(true, true); loop.setVisibility(true, true)
  for (let frame = 0; frame < 60; frame++) { assert.equal(host.pending.size, 1); host.tick(frame * 1000 / 60) }
  assert.equal(drawn.length, 30)
  drawn.length = 0; loop.setVisibility(true, false)
  for (let frame = 60; frame < 120; frame++) host.tick(frame * 1000 / 60)
  assert.equal(drawn.length, 5)
  loop.setVisibility(false, false); assert.equal(host.pending.size, 0)
  host.tick(5000); assert.equal(drawn.length, 5)
  loop.setVisibility(true, true); host.tick(6000); assert.equal(drawn.length, 6)
  loop.dispose(); assert.equal(host.pending.size, 0)
})
const animation = (id, pair = id, ts = 1000) => ({ id, from: `from-${pair}`, to: `to-${pair}`, kind: 'prompt', count: 1, ts })

test('confirmed effects dedup, batch per pair, expire and respect all queue limits', () => {
  const queue = new m.EnvelopeQueue()
  queue.ingest([animation('a', 'pair'), animation('b', 'pair')], 1000, true)
  assert.equal(queue.active.length, 1); assert.equal(queue.active[0].count, 2)
  queue.ingest([animation('a', 'pair')], 1000, true); assert.equal(queue.active[0].count, 2)
  queue.ingest([animation('c', 'pair', 1500)], 1500, true)
  queue.advance(2999); assert.equal(queue.active.length, 0)
  queue.advance(3000); assert.equal(queue.active.length, 1); assert.equal(queue.active[0].id, 'c')
  queue.clear(); queue.ingest(Array.from({ length: 100 }, (_, i) => animation(`${i}`)), 1000, true)
  assert.ok(queue.active.length <= 12)
  queue.advance(8000); assert.equal(queue.active.length, 0)
  queue.ingest([animation('expired', 'p', 1000)], 8000, true); assert.equal(queue.active.length, 0)
  queue.ingest([{ ...animation('attempt', 'p', 8000), kind: 'prompt_attempt' }], 8000, true); assert.equal(queue.active.length, 0)
})

test('hidden/reduced motion effects never replay; weights decay with wall time', () => {
  const queue = new m.EnvelopeQueue()
  queue.ingest([animation('hidden')], 1000, false)
  queue.ingest([animation('hidden')], 1100, true); assert.equal(queue.active.length, 0)
  queue.ingest([animation('new', 'p', 1100)], 1100, true); assert.equal(queue.active.length, 1)
  queue.discardMotion(); queue.advance(1200); assert.equal(queue.active.length, 0)
  assert.ok(Math.abs(m.decayedWeight(1, 0, 300_000) - 1 / Math.E) < 1e-10)
})

function canvasHost(t) {
  const host = frameHost(), listeners = new Map(), resizeObservers = new Set()
  let paints = 0
  const context = new Proxy({}, { get: (_target, key) => key === 'drawImage' ? () => paints++ : () => {} })
  const createCanvas = () => ({ width: 1, height: 1, getContext: () => context, getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 600 }),
    addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key), setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => true })
  const globals = { officeArtCalls: [], document: { createElement: createCanvas, documentElement: { lang: 'en' } }, window: { devicePixelRatio: 2 }, ResizeObserver: class { constructor(callback) { this.callback = callback; resizeObservers.add(this) } observe() {} disconnect() { resizeObservers.delete(this) } }, requestAnimationFrame: host.request, cancelAnimationFrame: host.cancel }
  for (const [key, value] of Object.entries(globals)) { const old = globalThis[key]; globalThis[key] = value; t.after(() => { if (old === undefined) delete globalThis[key]; else globalThis[key] = old }) }
  return { host, listeners, resizeObservers, createCanvas, paints: () => paints }
}
const state = () => ({ session: 'isolated', generation: 'test', departments: [{ id: 'project-0', number: 1, name: 'Test', workspaceId: 'w1' }], seats: [], agents: [{ id: 'agent-v1', paneId: 'pane-000', departmentId: 'project-0', status: 'working', lastStatusAt: 1000, kind: 'codex', role: 'general' }], externalNodes: [], links: [], recentEvents: [] })

test('engine DPR2 click opens the correct pane; drag does not open; hide stops painting', t => {
  const h = canvasHost(t), opened = [], canvas = h.createCanvas()
  const engine = new m.OfficeEngine(canvas, { onOpen: id => opened.push(id), onHover() {} })
  engine.update({ state: state(), animations: [] }); engine.setVisibility(true, true); h.host.tick(0)
  const point = m.worldToScreen({ x: 48, y: 110 }, engine.camera)
  const event = { clientX: point.x, clientY: point.y, button: 0, pointerId: 1 }
  h.listeners.get('pointerdown')(event); h.listeners.get('pointerup')(event)
  assert.deepEqual(opened, ['pane-000'])
  h.listeners.get('pointerdown')(event); h.listeners.get('pointermove')({ ...event, clientX: point.x + 5 }); h.listeners.get('pointerup')({ ...event, clientX: point.x + 5 })
  assert.equal(opened.length, 1)
  engine.setVisibility(false, true); const before = h.paints(); h.host.tick(1000); assert.equal(h.paints(), before)
  engine.dispose(); assert.equal(h.listeners.size, 0); assert.equal(h.resizeObservers.size, 0); assert.equal(h.host.pending.size, 0)
})

test('50 engine open/close cycles return RAF, DOM listeners and resize observers to zero', t => {
  const h = canvasHost(t)
  for (let i = 0; i < 50; i++) {
    const engine = new m.OfficeEngine(h.createCanvas(), { onOpen() {}, onHover() {} })
    engine.update({ state: state(), animations: [] }); engine.setVisibility(true, true); h.host.tick(i * 40)
    engine.dispose()
    assert.equal(h.listeners.size, 0); assert.equal(h.resizeObservers.size, 0); assert.equal(h.host.pending.size, 0)
  }
})

test('DOM machine captions stay on separate rows when zoomed out and do not update on draw frames', t => {
  const h = canvasHost(t), updates = []
  const engine = new m.OfficeEngine(h.createCanvas(), { onOpen() {}, onHover() {}, onLabels: labels => updates.push(labels) })
  const office = state()
  office.externalNodes = [{ id: 'pc', kind: 'machine', name: 'pc' }, { id: 'server', kind: 'machine', name: 'homeserver' }]
  engine.update({ state: office, animations: [] }); engine.zoom(0.5)
  const machines = updates.at(-1).filter(label => label.kind === 'machine')
  assert.ok(machines[1].y - machines[0].y >= 16)
  const count = updates.length
  engine.setVisibility(true, true); h.host.tick(0); h.host.tick(100)
  assert.equal(updates.length, count)
  engine.dispose()
})


test('disconnect blocks canvas opening even if there are cached hit targets', t => {
  const h = canvasHost(t), opened = [], engine = new m.OfficeEngine(h.createCanvas(), { onOpen: id => opened.push(id), onHover() {} })
  engine.update({ state: state(), animations: [] }); engine.setVisibility(true, true); h.host.tick(0)
  const p = m.worldToScreen({ x: 48, y: 75 }, engine.camera)
  const event = { clientX: p.x, clientY: p.y, pointerId: 1, button: 0 }
  engine.setConnected(false)
  h.listeners.get('pointerdown')(event); h.listeners.get('pointerup')(event)
  assert.deepEqual(opened, [])
  engine.setConnected(true)
  h.listeners.get('pointerdown')(event); h.listeners.get('pointerup')(event)
  assert.deepEqual(opened, ['pane-000']); engine.dispose()
})

test('seat presentation matches the reference: front sits behind the desk, back between desk and chair', t => {
  const h = canvasHost(t), engine = new m.OfficeEngine(h.createCanvas(), { onOpen() {}, onHover() {} })
  const office = state()
  office.agents = Array.from({ length: 8 }, (_, i) => ({ ...office.agents[0], id: `agent-${i}`, paneId: `pane-00${i}` }))
  engine.update({ state: office, animations: [] }); engine.setVisibility(true, true); h.host.tick(0)
  const calls = globalThis.officeArtCalls
  const front = calls.findIndex(c => c.id === 'agent.codex' && c.state === 'working:front')
  const frontDesk = calls.findIndex(c => c.id === 'object.desk.front')
  const back = calls.findIndex(c => c.id === 'agent.codex' && c.state === 'working:back')
  const backDesk = calls.findIndex(c => c.id === 'object.desk.back')
  const backChair = calls.findIndex(c => c.id === 'object.chair.back')
  assert.ok(front >= 0 && front < frontDesk)
  assert.ok(backDesk >= 0 && backDesk < back && back < backChair)
  assert.equal(calls[front].anchor.y, 101); assert.equal(calls[back].anchor.y, 249)
  assert.ok(calls.some(c => c.id === 'tile.wall.cap.front'))
  assert.ok(calls.some(c => c.id.startsWith('tile.floor.carpet.red.')))
  engine.dispose()
})

test('unknown/disconnect turn desks off; back desks select new cached animation frames; reduced motion freezes them', t => {
  const h = canvasHost(t), engine = new m.OfficeEngine(h.createCanvas(), { onOpen() {}, onHover() {} })
  let now = 10_000; t.mock.method(Date, 'now', () => now)
  const office = state()
  office.agents = Array.from({ length: 5 }, (_, i) => ({ ...office.agents[0], id: `agent-${i}`, paneId: `pane-00${i}`, lastStatusAt: now }))
  office.agents[0].status = 'unknown'
  engine.update({ state: office, animations: [] }); engine.setVisibility(true, true); h.host.tick(0)
  assert.ok(globalThis.officeArtCalls.some(c => c.id === 'object.desk.front' && c.state === 'off'))
  const first = globalThis.officeArtCalls.filter(c => c.id === 'object.desk.back' && c.state === 'on').length
  now += 950; h.host.tick(950)
  assert.ok(globalThis.officeArtCalls.filter(c => c.id === 'object.desk.back' && c.state === 'on').length > first)
  engine.setOptions(false, true)
  h.host.tick(1400)
  const frozen = globalThis.officeArtCalls.filter(c => c.id === 'object.desk.back' && c.state === 'on').length
  now += 950; h.host.tick(2400)
  assert.equal(globalThis.officeArtCalls.filter(c => c.id === 'object.desk.back' && c.state === 'on').length, frozen)
  engine.setConnected(false); h.host.tick(2800)
  assert.ok(globalThis.officeArtCalls.some(c => c.id === 'object.desk.back' && c.state === 'off'))
  engine.dispose()
})

test('envelopes use elapsed animation time, attempts and machine links use their distinct sprites', t => {
  const h = canvasHost(t), engine = new m.OfficeEngine(h.createCanvas(), { onOpen() {}, onHover() {} })
  let now = 10_000; t.mock.method(Date, 'now', () => now)
  const office = state()
  office.agents.push({ ...office.agents[0], id: 'recipient', paneId: 'pane-001' })
  office.externalNodes = [{ id: 'machine:pc', kind: 'machine', name: 'pc' }]
  office.links = [{ id: 'attempt', from: 'agent-v1', to: 'recipient', style: 'attempt', weight: 1, lastAt: now }, { id: 'ssh', from: 'agent-v1', to: 'machine:pc', style: 'machine', weight: 1, lastAt: now }]
  engine.update({ state: office, animations: [] }); engine.setVisibility(true, true)
  engine.update({ state: office, animations: [{ ...animation('confirmed', 'pair', now), from: 'agent-v1', to: 'recipient' }] })
  now += 350; h.host.tick(350)
  assert.ok(globalThis.officeArtCalls.some(c => c.id === 'effect.envelope' && c.time === 350))
  for (const id of ['effect.attempt', 'effect.dash', 'effect.cable.h', 'effect.cable.v', 'effect.cable.plug']) assert.ok(globalThis.officeArtCalls.some(c => c.id === id), id)
  const calls = globalThis.officeArtCalls
  assert.ok(calls.findIndex(c => c.id === 'effect.cable.h') < calls.findIndex(c => c.id === 'object.desk.front'))
  assert.ok(calls.findIndex(c => c.id === 'effect.cable.h') < calls.findIndex(c => c.id === 'agent.codex'))
  engine.dispose()
})

const manifest = JSON.parse(readFileSync('src/renderer/src/office/assets/manifest.json', 'utf8'))
function routeFixture(count, size) {
  const layout = new m.OfficeLayout().update(projects(count), agents(size, count))
  const poses = layout.seats.map(m.seatPose)
  const hits = poses.map(pose => {
    const frame = manifest.sprites['agent.codex'].states[`idle:${pose.direction}`].frames[0]
    return { ...frame.hitRect, x: pose.agent.x - frame.anchor.x + frame.hitRect.x, y: pose.agent.y - frame.anchor.y + frame.hitRect.y }
  })
  return { layout, poses, hits }
}
function assertClearRoute(route, hits) {
  assert.ok(route.length >= 2, 'route exists')
  for (let i = 1; i < route.length; i++) for (const hit of hits) assert.equal(m.segmentHitsRect(route[i - 1], route[i], hit), false, JSON.stringify({ segment: [route[i - 1], route[i]], hit }))
}

test('links and travelling envelopes avoid character hit rects across both rows, rooms and extensions', () => {
  for (const [count, size] of [[1, 8], [3, 24], [20, 200]]) {
    const { poses, hits } = routeFixture(count, size)
    for (let i = 0; i < poses.length; i += Math.max(1, Math.floor(size / 16))) {
      const targets = [0, Math.min(4 * count, size - 1), size - 1]
      for (const j of targets) {
        if (i === j) continue
        const from = m.aboveHead(poses[i].agent, hits[i]), to = m.aboveHead(poses[j].agent, hits[j])
        const route = m.routeLine(from, to, hits)
        assert.deepEqual(route[0], from); assert.deepEqual(route.at(-1), to)
        assertClearRoute(route, hits)
        for (let step = 0; step <= 20; step++) {
          const p = m.pointOnRoute(route, step / 20)
          assert.ok(hits.every(hit => !intersects({ x: p.x - 8, y: p.y - 8, width: 16, height: 16 }, hit)), 'envelope footprint clears characters')
        }
      }
    }
  }
})

test('SSH cables leave through the bottom aisle and stay outside other rooms and all characters', () => {
  for (const [count, size] of [[1, 8], [3, 24], [20, 200]]) {
    const { layout, hits } = routeFixture(count, size)
    const rooms = layout.lots.map(l => ({ ...l, height: l.height + m.TILE }))
    const machine = { x: layout.bounds.x + layout.bounds.width + 10 * m.TILE, y: 5 * m.TILE }
    for (const seat of layout.seats) {
      const lot = layout.lots.find(l => l.departmentId === seat.departmentId && l.block === Math.floor(seat.index / 8))
      const route = m.routeCable(seat, lot, rooms, machine, hits)
      assertClearRoute(route, hits)
      assert.deepEqual(route.at(-1), machine)
      assert.ok(route.some(p => p.y >= lot.y + lot.height + m.TILE * 1.5), 'exits below the front wall')
      assertClearRoute(route, rooms.filter(r => r.slot !== lot.slot))
    }
  }
})

test('user sprite and caption clear its head; reduced motion freezes its default frame', t => {
  const h = canvasHost(t), labels = [], engine = new m.OfficeEngine(h.createCanvas(), { onOpen() {}, onHover() {}, onLabels: x => labels.push(x) })
  const office = state(); office.externalNodes = [{ id: 'user', kind: 'user', name: 'User' }]
  engine.update({ state: office, animations: [] }); engine.setOptions(false, true); engine.reset(); engine.setVisibility(true, true); h.host.tick(0)
  const sprite = globalThis.officeArtCalls.find(c => c.id === 'object.user')
  assert.ok(sprite); assert.equal(sprite.time, 0)
  const label = labels.at(-1).find(l => l.id === 'user')
  assert.equal(label.y, m.worldToScreen({ x: 0, y: -24 - 50 }, engine.camera).y)
  assert.ok(label.y > 0, 'reset keeps caption in view')
  engine.dispose()
})

test('sidebar navigation is action-based for same-ID chat and board, including Enter, excluding menu buttons', () => {
  const row = kind => ({ paneId: 'same-id', kind, closest(selector) { return selector === '.sidebar .thread' ? this : null } })
  for (const target of [row('chat'), row('board')]) {
    assert.equal(m.isSidebarNavigation(target), true)
    assert.equal(m.isSidebarNavigation(target, 'Enter'), true)
    assert.equal(m.isSidebarNavigation(target, 'ArrowDown'), false)
  }
  assert.equal(m.isSidebarNavigation({ closest: () => ({}) }), false, 'nested More button does not navigate')
  assert.equal(m.isSidebarNavigation(null), false)
})

test('unknown roles (including inherited keys) fall back to the translated general role in all five languages', t => {
  canvasHost(t)
  for (const lang of ['en', 'ru', 'es', 'de', 'zh']) {
    m.setLanguage(lang)
    const general = m.roleLabel({ role: 'general', roleSource: 'default' })
    for (const role of ['future-role', 'constructor', '__proto__']) assert.equal(m.roleLabel({ role, roleSource: 'default' }), general)
    const inferred = m.roleLabel({ role: 'future-role', roleSource: 'name' })
    assert.ok(inferred.includes(general)); assert.ok(!inferred.includes('undefined'))
    assert.ok(m.statusLabel('disconnect')); assert.ok(m.coverageLabel('history_limit'))
  }
  m.setLanguage('en')
  assert.equal(m.kindLabel('claude'), 'Claude Code'); assert.equal(m.kindLabel('codex'), 'Codex')
})
