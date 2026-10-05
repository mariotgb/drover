// v2 characters: every agent kind and role in all poses, front/back (+ side for stand/walk).
// State key: `<pose>:<dir>`. The engine mirrors `side` frames for walking left.
import { Pix } from '../canvas.mjs'
import { drawBody, drawRole, drawSide, drawRoleSide, drawUser, drawBoss, STATES, USER_POSES, USER_DURATIONS, FRAME, KINDS, ROLES } from '../characters.mjs'
import { S } from './kit-tiles.mjs'

const wave = (w, bob = 0) => ({ arms: 'raise', wave: w, mouth: 'o', noAsk: true, bob })
export const POSES = {
  idle: { poses: STATES.idle.poses, durations: STATES.idle.durations, loop: true },
  working: { poses: STATES.working.poses, durations: STATES.working.durations, loop: true },
  blocked: { poses: [wave(0), wave(1), wave(0, 1), wave(1)], durations: [220, 220, 220, 220], loop: true },
  done: { poses: STATES.done.poses, durations: STATES.done.durations, loop: true },
  unknown: { poses: STATES.unknown.poses, durations: STATES.unknown.durations, loop: false },
  throw: { poses: [{ arms: 'throw', phase: 0 }, { arms: 'throw', phase: 1, mouth: 'grin' }], durations: [160, 120], loop: false },
  catch: { poses: [{ arms: 'stretch', reach: 1, mouth: 'o', jump: 3 }, { arms: 'stretch', reach: 0, mouth: 'o', jump: 1 }], durations: [180, 120], loop: false },
  stretch: { poses: [{ arms: 'stretch', reach: 0, eyes: 'closed', mouth: 'o' }, { arms: 'stretch', reach: 1, eyes: 'closed', mouth: 'o', bob: -1 }], durations: [600, 900], loop: false },
  stand: { poses: [{}, { bob: 1 }], durations: [800, 800], loop: true },
  walk: { poses: [{ walk: 0 }, { walk: 1, bob: 1 }, { walk: 2 }, { walk: 3, bob: 1 }], durations: [150, 150, 150, 150], loop: true }
}
export const SIDE_POSES = ['stand', 'walk']
export const DIRS = ['front', 'back']
export const AGENT_HIT = { x: 6, y: 4, width: 20, height: 42 }

/** Lift the figure by n px (a jump); the contact shadow stays on the floor. */
export function jump(pix, n, keepShadow = true) {
  if (!n) return pix
  const out = new Pix(pix.w, pix.h)
  for (let y = 0; y < pix.h; y++) for (let x = 0; x < pix.w; x++) {
    const p = pix.get(x, y)
    if (!p[3]) continue
    const shadow = keepShadow && y >= 42 && p[3] < 255
    out.set(x, shadow ? y : y - n, p)
  }
  return out
}
function frames(draw, plan) {
  return S(plan.poses.map((pose) => jump(draw(pose), pose.jump ?? 0, true)), plan.durations, plan.loop)
}
function sprite(id, atlas, layer, drawFront, drawSideView) {
  const states = {}
  for (const [pose, plan] of Object.entries(POSES)) for (const dir of DIRS) states[`${pose}:${dir}`] = frames((p) => drawFront(dir, p), plan)
  for (const pose of SIDE_POSES) states[`${pose}:side`] = frames((p) => drawSideView(p), POSES[pose])
  return { id, atlas, layers: [layer], anchor: { ...FRAME.anchor }, states, hit: AGENT_HIT }
}

export function buildCharacters() {
  const out = []
  for (const kind of KINDS) out.push(sprite(`agent.${kind}`, 'agents', 'body', (dir, p) => drawBody(kind, dir, p), (p) => drawSide(kind, p)))
  for (const role of ROLES) out.push(sprite(`role.${role}`, 'roles', 'role', (dir, p) => drawRole(role, dir, p), (p) => drawRoleSide(role, p)))
  out.push({
    id: 'agent.user', atlas: 'agents', layers: ['body'], anchor: { ...FRAME.anchor }, hit: AGENT_HIT,
    states: { 'idle:front': S(USER_POSES.map((p) => drawUser(p)), USER_DURATIONS, true), 'throw:front': S([drawUser({ throw: 0 }), drawUser({ throw: 1 })], [160, 120], false) }
  })
  // «Главный босс»: separate look, no role overlay.
  out.push({
    id: 'agent.boss', atlas: 'agents', layers: ['body'], anchor: { ...FRAME.anchor }, hit: AGENT_HIT,
    states: {
      'sit:front': S([drawBoss({ pose: 'sit' }), drawBoss({ pose: 'sit', bob: 1 }), drawBoss({ pose: 'sit' }), drawBoss({ pose: 'sit', eyes: 'closed' })], [700, 700, 700, 140], true),
      'stand:front': S([drawBoss({ pose: 'stand' }), drawBoss({ pose: 'stand', bob: 1 })], [800, 800], true),
      'dispatch:front': S([drawBoss({ pose: 'dispatch', phase: 0 }), drawBoss({ pose: 'dispatch', phase: 1 }), drawBoss({ pose: 'dispatch', phase: 2 })], [180, 140, 260], false),
      'pleased:front': S([drawBoss({ pose: 'pleased', phase: 0 }), drawBoss({ pose: 'pleased', phase: 1 })], [400, 400], true),
      'walk:side': S([0, 1, 2, 3].map((w) => drawBoss({ pose: 'walk', walk: w, bob: w % 2 })), [150, 150, 150, 150], true)
    }
  })
  return out
}
