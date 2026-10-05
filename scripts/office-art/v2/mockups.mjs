// Office v2 mock-ups: scenes (S/M/L × two directions), interaction storyboards, hall growth.
// Usage: node scripts/office-art/v2/mockups.mjs <outDir>
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pix } from '../canvas.mjs'
import { encodePng } from '../png.mjs'
import { print, measure } from './pixfont.mjs'
import { renderScene } from './render.mjs'
import { SCENES, team } from './scenes.mjs'
import { THEMES } from './themes.mjs'

const save = (file, pix, scale = 1) => { const s = scale === 1 ? pix : pix.scaled(scale); writeFileSync(file, encodePng(s.w, s.h, s.d)); return file }
const crop = (pix, x, y, w, h) => { const o = new Pix(w, h); o.blit(pix, Math.round(x), Math.round(y), w, h, 0, 0); return o }
const clone = (o) => JSON.parse(JSON.stringify(o))

// ---------------------------------------------------------------- storyboards
const BASE = () => clone({ projects: SCENES.m.projects, machines: SCENES.m.machines, links: [] })
const setStatus = (spec, name, status) => { for (const p of spec.projects) for (const a of p.agents) if (a.name === name) a.status = status }

export const STORIES = [
  {
    id: 'prompt', title: 'ЗАДАЧА ОТ ТИМЛИДА', note: 'prompt (confirmed): замах → бросок → полёт по дуге → адресат ловит «!» → записка на столе, агент печатает',
    frames: [0.02, 0.09, 0.4, 0.75, 0.97, 1.2], focus: ['drover-lead', 'drover-designer'],
    make: (t) => { const s = BASE(); setStatus(s, 'drover-designer', t > 1 ? 'working' : 'idle'); s.events = t <= 1 ? [{ type: 'prompt', from: 'drover-lead', to: 'drover-designer', t }] : [{ type: 'note', at: 'drover-designer' }]; if (t > 1) s.links = [{ from: 'drover-lead', to: 'drover-designer', weight: 1, recent: 1 }]; return s }
  },
  {
    id: 'attempt', title: 'ПОПЫТКА БЕЗ ПОДТВЕРЖДЕНИЯ', note: 'prompt_attempt: летит тем же путём, на середине глохнет и падает; остаётся смятый листок / гаснущие искры',
    frames: [0.1, 0.35, 0.6, 0.8, 1], focus: ['drover-lead', 'drover-reviewer'],
    make: (t) => { const s = BASE(); setStatus(s, 'drover-reviewer', 'idle'); s.events = [{ type: 'attempt', from: 'drover-lead', to: 'drover-reviewer', t }]; return s }
  },
  {
    id: 'user', title: 'ЗАДАЧА ОТ ВАС', note: 'user_prompt: из приёмной «Вы» к агенту; свой цвет носителя',
    frames: [0.1, 0.35, 0.65, 0.97], focus: ['Вы', 'drover-lead'],
    make: (t) => { const s = BASE(); s.events = [{ type: 'user_prompt', to: 'drover-lead', t }]; return s }
  },
  {
    id: 'done', title: 'ГОТОВО', note: 'agent_status → done: потягивается, конфетти, табличка зеленеет, ✓ над головой (обратного «пакета» нет — его нет в событиях)',
    frames: [-1, 0.1, 0.35, 0.7, 2], focus: ['drover-docs', 'drover-devops'],
    make: (t) => { const s = BASE(); setStatus(s, 'drover-docs', t < 0 ? 'working' : t > 1 ? 'idle' : 'done'); s.events = t >= 0 && t <= 1 ? [{ type: 'done', at: 'drover-docs', t }] : []; return s }
  },
  {
    id: 'blocked', title: 'ЖДЁТ ОТВЕТА', note: 'blocked: машет рукой, «?» и жёлтая табличка; в приёмной звенит звонок и счётчик «N ждут»',
    frames: [0, 1, 2], focus: ['drover-reviewer', 'Вы'], wide: true,
    make: (t) => { const s = BASE(); s.tick = t; return s }
  },
  {
    id: 'ssh', title: 'SSH НА МАШИНУ', note: 'ssh_attempt: кабель по полу от стола до серверной, бегут пакеты, стойка «горячая», на машине терминал',
    frames: [0.05, 0.35, 0.65], focus: ['drover-devops', 'homeserver'], wide: true, extra: [(L) => ({ x: L.corridor.x + 200, y: L.corridorY + 70 })],
    make: (t) => { const s = BASE(); s.events = [{ type: 'ssh', from: 'drover-devops', to: 'homeserver', t }]; return s }
  },
  {
    id: 'links', title: 'ЧАСТЫЕ СВЯЗИ', note: 'links: толщина по частоте (1–3), яркость по свежести, бегущие точки; новое событие = вспышка',
    frames: [0, 0.33, 0.66], focus: ['drover-lead', 'drover-frontend', 'drover-backend'],
    make: (t) => { const s = BASE(); s.phase = t; s.links = [{ from: 'drover-lead', to: 'drover-backend', weight: 3, recent: 1 }, { from: 'drover-lead', to: 'drover-frontend', weight: 2, recent: 0.6 }, { from: 'drover-backend', to: 'drover-frontend', weight: 1, recent: 0.2 }]; return s }
  },
  {
    id: 'board', title: 'ДОСКА ЗАДАЧ', note: 'task_created / task_assigned / task_status: карточка летит к доске зала и прикалывается',
    frames: [0.1, 0.45, 0.8, 1], focus: ['drover-backend', 'drover-lead'], extra: [(L) => { const h = L.rooms.find((r) => r.kind === 'hall'); return { x: h.x + 30, y: h.y + 20 } }],
    make: (t) => { const s = BASE(); s.events = [{ type: 'board', from: 'drover-backend', t }]; return s }
  }
]

function focusBox(layout, names, wide, extra = []) {
  const pts = []
  for (const n of names.map((n) => layout.nodes[n]).filter(Boolean)) {
    const south = n.side === 'south'
    pts.push({ x: n.center - 30, y: n.deskTop + (south ? 0 : -52) }, { x: n.center + 30, y: n.deskTop + (south ? 62 : 40) })
  }
  for (const e of extra) pts.push(e(layout))
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y)
  const minW = wide ? 380 : 260, minH = wide ? 230 : 190
  const bw = Math.max(minW, Math.max(...xs) - Math.min(...xs) + 40), bh = Math.max(minH, Math.max(...ys) - Math.min(...ys) + 24)
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2
  return { x: Math.round(cx - bw / 2), y: Math.round(cy - bh / 2), w: Math.round(bw), h: Math.round(bh) }
}

export function storyboard(themeId, story, scale = 2) {
  const first = renderScene(themeId, story.make(story.frames[0]))
  const box = focusBox(first.layout, story.focus, story.wide, story.extra)
  const gap = 6, pad = 6
  const panels = story.frames.map((t) => crop(renderScene(themeId, story.make(t)).pix, box.x, box.y, box.w, box.h))
  const W = panels.length * (box.w + gap) - gap + pad * 2, Hh = box.h + pad * 2 + 14
  const sheet = new Pix(W, Hh)
  const P = THEMES[themeId]
  sheet.rect(0, 0, W, Hh, P.id === 'neon' ? '#0b0f18' : '#efe4cf')
  panels.forEach((p, i) => {
    const x = pad + i * (box.w + gap)
    sheet.rect(x - 1, pad - 1, box.w + 2, box.h + 2, P.id === 'neon' ? '#2c3550' : '#c9b48a')
    sheet.blit(p, 0, 0, p.w, p.h, x, pad)
    const n = String(i + 1)
    sheet.rect(x + 2, pad + 2, measure(n) + 4, 9, P.id === 'neon' ? '#0b0f18' : '#2b1d1b')
    print(sheet, x + 4, pad + 4, n, '#ffffff')
  })
  print(sheet, pad, box.h + pad + 5, story.title, P.id === 'neon' ? '#dffbff' : '#4a2e1f')
  return sheet.scaled(scale)
}

// ---------------------------------------------------------------- hall growth
export function growth(themeId) {
  const sizes = [1, 4, 8, 16, 30]
  const halls = sizes.map((n) => {
    const spec = { projects: [{ name: 'drover', agents: team('drover', n).map((a) => ({ ...a, status: a.status === 'unknown' ? 'idle' : a.status })) }], machines: [], events: [], links: [] }
    const { pix, layout } = renderScene(themeId, spec)
    const hall = layout.rooms.find((r) => r.kind === 'hall')
    return { n, img: crop(pix, hall.x - 4, hall.y - 4, hall.width + 8, hall.height + 8) }
  })
  const gap = 18, top = 22, H = Math.max(...halls.map((h) => h.img.h)) + top + 8
  const W = halls.reduce((w, h) => w + h.img.w + gap, gap)
  const P = THEMES[themeId]
  const sheet = new Pix(W, H)
  sheet.rect(0, 0, W, H, P.id === 'neon' ? '#0b0f18' : '#efe4cf')
  let x = gap
  for (const h of halls) {
    sheet.blit(h.img, 0, 0, h.img.w, h.img.h, x, H - 8 - h.img.h)
    const label = `${h.n} ${h.n === 1 ? 'АГЕНТ' : h.n < 5 ? 'АГЕНТА' : 'АГЕНТОВ'}`
    print(sheet, x + h.img.w / 2 - measure(label), H - 8 - h.img.h - 16, label, P.id === 'neon' ? '#dffbff' : '#4a2e1f', 2)
    x += h.img.w + gap
  }
  return sheet
}

if (process.argv[1]?.endsWith('mockups.mjs')) {
  const out = process.argv[2] ?? 'mockups'
  mkdirSync(out, { recursive: true })
  for (const [dir, theme] of [['a', 'cozy'], ['b', 'neon']]) {
    for (const size of ['s', 'm', 'l']) {
      const { pix, layout } = renderScene(theme, { ...SCENES[size], select: size === 'm' ? 'drover-backend' : undefined })
      save(join(out, `scene-${dir}-${size}.png`), pix)
      save(join(out, `office-v2-${dir}-${size}-world.png`), pix, 2)
      const main = layout.rooms.find((r) => r.kind === 'hall')
      writeFileSync(join(out, `scene-${dir}-${size}.json`), JSON.stringify({ width: pix.w, height: pix.h, main: { x: main.x, y: main.y, width: main.width, height: main.height }, rooms: layout.rooms.map((r) => ({ kind: r.kind, name: r.name, x: r.x, y: r.y, width: r.width, height: r.height })), nodes: Object.fromEntries(Object.entries(layout.nodes).map(([k, n]) => [k, { x: n.center, y: n.deskTop, side: n.side, head: n.head ?? null }])) }))
    }
    const rows = STORIES.map((st) => { const img = storyboard(theme, st); save(join(out, `story-${dir}-${st.id}.png`), img); return img })
    const W = Math.max(...rows.map((r) => r.w)), H = rows.reduce((h, r) => h + r.h, 0)
    const all = new Pix(W, H); all.rect(0, 0, W, H, theme === 'neon' ? '#0b0f18' : '#efe4cf')
    let y = 0; for (const r of rows) { all.blit(r, 0, 0, r.w, r.h, 0, y); y += r.h }
    save(join(out, `office-v2-${dir}-story.png`), all)
    save(join(out, `office-v2-${dir}-growth.png`), growth(theme), 2)
  }
  console.log('mock-ups →', out)
}
