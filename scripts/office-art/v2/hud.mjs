// HUD mock-ups: the office tab around a generated scene, two directions.
// Writes hud-<a|b>-<s|m|l>.html next to scene-<dir>-<size>.png (from mockups.mjs).
// Usage: node scripts/office-art/v2/hud.mjs <dir with scenes>
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pix } from '../canvas.mjs'
import { encodePng } from '../png.mjs'
import { drawBody, drawRole, STATES } from '../characters.mjs'
import { statusMark } from './overlay.mjs'
import { THEMES } from './themes.mjs'
import { SCENES } from './scenes.mjs'

const uri = (pix) => 'data:image/png;base64,' + Buffer.from(encodePng(pix.w, pix.h, pix.d)).toString('base64')
const ROLE_RU = { lead: 'Тимлид', backend: 'Бэкенд', frontend: 'Фронтенд', devops: 'Инфраструктура', docs: 'Документация', reviewer: 'Ревью', designer: 'Дизайн', general: 'Общая роль' }
const KIND_RU = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', general: 'Агент' }
const STATUS_RU = { working: 'Работает', blocked: 'Ждёт ответа', idle: 'Свободен', done: 'Готово', unknown: 'Неизвестно' }

function portrait(a) {
  const k = ['claude', 'codex', 'gemini'].includes(a.kind) ? a.kind : 'general'
  const body = drawBody(k, 'front', STATES.idle.poses[0]); body.blit(drawRole(a.role, 'front', STATES.idle.poses[0]), 0, 0, 32, 48, 0, 0)
  const c = new Pix(28, 30); c.blit(body, 2, 0, 28, 30, 0, 0)
  return uri(c)
}
function mark(P, status) { const c = new Pix(5, 5); statusMark(P, c, 0, 0, status, 1); return uri(c) }

const ICON = {
  fit: '<path d="M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3"/>',
  focus: '<circle cx="8" cy="8" r="4.5"/><path d="M8 1v3M8 12v3M1 8h3M12 8h3"/>',
  links: '<path d="M6.5 9.5l3-3M5 11a2.5 2.5 0 0 1 0-3.5l1.5-1.5M11 5a2.5 2.5 0 0 1 0 3.5L9.5 10"/>',
  term: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 7l2 1.5L5 10M8.5 10.5h3"/>',
  list: '<path d="M5 4.5h8M5 8h8M5 11.5h8M2.5 4.5h.5M2.5 8h.5M2.5 11.5h.5"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>',
  chat: '<path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5V11h.5"/>',
  plus: '<path d="M8 3v10M3 8h10"/>', folder: '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/>'
}
const svg = (name) => `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</svg>`

function eventLine(e, dir) {
  const short = (n = '') => n.replace(/^drover-|^site-/, '')
  const icon = { prompt: dir === 'a' ? '✈' : '◆', attempt: '✕', user_prompt: dir === 'a' ? '✈' : '◆', done: '✓', ssh: '⇄', board: '▤' }[e.type]
  const text = {
    prompt: `<b>${short(e.from)}</b> → <b>${short(e.to)}</b> · задача`,
    attempt: `<b>${short(e.from)}</b> → <b>${short(e.to)}</b> · не подтверждено`,
    user_prompt: `<b>Вы</b> → <b>${e.to}</b> · задача`,
    done: `<b>${short(e.at)}</b> · готово`,
    ssh: `<b>${short(e.from)}</b> → <b>${e.to}</b> · SSH`,
    board: `<b>${short(e.from)}</b> · карточка на доске`
  }[e.type]
  return { icon, text, cls: e.type }
}

const CSS = `
*{box-sizing:border-box}html,body{margin:0}body{width:1440px;height:900px;overflow:hidden;font:13px/1.35 -apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.win{width:1440px;height:900px;display:flex}
.side{width:250px;flex:none;display:flex;flex-direction:column;padding:14px 10px 10px;gap:4px}
.lights{display:flex;gap:8px;padding:2px 6px 14px}.lights i{width:12px;height:12px;border-radius:50%;display:block}
.side .new{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;font-weight:550}
.side .cap{font-size:11.5px;font-weight:600;padding:12px 10px 4px;letter-spacing:.02em}
.side .proj{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px}
.side .proj .n{margin-left:auto;font-size:11.5px;font-variant-numeric:tabular-nums}
.side .agent{display:flex;align-items:center;gap:8px;padding:5px 10px 5px 30px;border-radius:8px;font-size:12.5px}
.side .agent i{width:7px;height:7px;border-radius:50%;display:block;flex:none}
.side .foot{margin-top:auto;padding:10px;border-radius:10px;font-size:12px;display:grid;grid-template-columns:auto 1fr auto;gap:6px 8px;align-items:center}
.side .bar{height:4px;border-radius:2px;overflow:hidden}.side .bar b{display:block;height:100%}
.main{flex:1;min-width:0;display:flex;flex-direction:column}
.tabs{height:48px;flex:none;display:flex;align-items:center;gap:6px;padding:0 16px}
.tabs span{padding:6px 14px;border-radius:8px;font-weight:550}
.stage{position:relative;flex:1;overflow:hidden}
.world{position:absolute;left:0;top:0;image-rendering:pixelated;transform-origin:0 0}
.hud{position:absolute}
.panel{position:relative}.hud.panel{position:absolute}
.row{display:flex;align-items:center;gap:8px}
.seg{display:inline-flex;gap:2px;padding:2px;border-radius:8px}
.btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:7px;font:inherit;font-size:12.5px;font-weight:550;border:0;cursor:pointer;white-space:nowrap}
.seg .btn{height:24px;padding:0 9px;font-variant-numeric:tabular-nums}
.chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:13px;font-size:12.5px;font-weight:550;white-space:nowrap}
.chip small{font-weight:500;opacity:.7}
.px{image-rendering:pixelated;display:block}
.counters{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:8px}.counter{display:flex;align-items:center;gap:7px;padding:4px 10px 4px 8px;border-radius:8px;font-size:12.5px;white-space:nowrap}
.counter b{font-size:15px;font-variant-numeric:tabular-nums}
.counter img{width:15px;height:15px}
.roster{right:14px;top:14px;bottom:14px;width:318px;display:flex;flex-direction:column;padding:12px 10px 10px}
.roster h3,.log h3,.mini h3{margin:0 4px 8px;display:flex;align-items:center;gap:8px}
.search{display:flex;align-items:center;gap:7px;height:30px;padding:0 10px;border-radius:8px;margin-bottom:8px;font-size:12.5px}
.list{overflow:hidden;flex:1;display:flex;flex-direction:column;gap:2px}
.dept{display:flex;align-items:center;gap:8px;padding:8px 6px 4px;font-size:11.5px;font-weight:650;letter-spacing:.04em;text-transform:uppercase}
.dept .cnt{margin-left:auto;font-weight:500}
.ag{display:grid;grid-template-columns:40px 1fr auto;gap:2px 10px;align-items:center;padding:6px 8px;border-radius:9px}
.ag .face{grid-row:span 2;width:40px;height:43px;border-radius:7px;overflow:hidden;display:flex;align-items:flex-end;justify-content:center}
.ag .face img{width:37px;height:40px}
.ag .nm{font-weight:620;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ag .meta{font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ag .st{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;grid-row:1;grid-column:3;justify-self:end}
.ag .st img{width:10px;height:10px}
.ag .ev{grid-column:2/4;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ag .acts{grid-column:1/4;display:flex;gap:6px;margin-top:6px}
.log{left:14px;bottom:14px;width:330px;padding:12px 12px 10px}
.log ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px}
.log li{display:flex;align-items:center;gap:9px;font-size:12.5px}
.log li .ic{width:22px;height:22px;flex:none;border-radius:6px;display:grid;place-items:center;font-size:12px;font-weight:700}
.log li time{margin-left:auto;font-size:11.5px;font-variant-numeric:tabular-nums}
.mini{bottom:14px;padding:10px}
.mini .map{position:relative;overflow:hidden;border-radius:4px}
.mini .map img{display:block;image-rendering:pixelated}
.mini .vp{position:absolute;border-radius:2px}
.card{width:270px;padding:12px;z-index:3}
.card .top{display:flex;gap:10px;align-items:center}
.card .face{width:46px;height:50px;border-radius:8px;display:flex;align-items:flex-end;justify-content:center;overflow:hidden}
.card .face img{width:42px;height:45px}
.card .nm{font-weight:650;font-size:14px}.card .meta{font-size:12px}
.card .task{margin:10px 0 0;padding:8px 10px;border-radius:8px;font-size:12.5px}
.card .task small{display:block;font-size:11px;margin-bottom:2px}
.card .acts{display:flex;gap:6px;margin-top:10px}
.card::after{content:'';position:absolute;left:50%;bottom:-8px;width:14px;height:14px;transform:translateX(-50%) rotate(45deg)}

/* ---------- A: Мастерская (light Drover + wood & paper) */
.dir-a{background:#f7f5ef;color:#2b2118}
.dir-a .side{background:#f1ede4}.dir-a .lights i:nth-child(1){background:#ff5f57}.dir-a .lights i:nth-child(2){background:#febc2e}.dir-a .lights i:nth-child(3){background:#28c840}
.dir-a .side .new{color:#2b2118}.dir-a .side .cap{color:#8a7a66}.dir-a .side .proj.on{background:#e6dfd0}.dir-a .side .n{color:#8a7a66}.dir-a .side .agent{color:#5b4a3a}
.dir-a .side .foot{background:#fffaf0;border:1px solid #e6dccb;color:#5b4a3a}.dir-a .side .bar{background:#eadfca}.dir-a .side .bar b{background:#c96442}
.dir-a .tabs{background:#f7f5ef;border-bottom:1px solid #e6dccb}.dir-a .tabs span{color:#7a6a58}.dir-a .tabs span.on{background:#fff;color:#2b2118;box-shadow:0 0 0 1px #e6dccb,0 1px 2px rgba(0,0,0,.06)}
.dir-a .stage{background:#6f9f4c}
.dir-a .panel{background:#fbf3df;border:2px solid #6a4228;border-radius:9px;box-shadow:inset 0 0 0 2px #f2e2bd,0 3px 0 #4a2e1f,0 12px 26px rgba(43,29,27,.30);color:#3b2b26}
.dir-a h3{font:700 11px/1 -apple-system,system-ui;letter-spacing:.08em;text-transform:uppercase;color:#8a5a32}
.dir-a .seg{background:#ead6ad;box-shadow:inset 0 1px 0 #d7bd8a}.dir-a .btn{background:#f6e7c6;color:#4a2e1f;box-shadow:inset 0 -2px 0 #d9bd86,0 0 0 1px #c9a46e}
.dir-a .seg .btn{background:transparent;box-shadow:none;color:#7a5236}.dir-a .seg .btn.on{background:#fffaf0;color:#3b2b26;box-shadow:inset 0 -2px 0 #d9bd86,0 0 0 1px #c9a46e}
.dir-a .btn.primary{background:#c96442;color:#fff;box-shadow:inset 0 -2px 0 #9c4a2f,0 0 0 1px #9c4a2f}
.dir-a .chip{background:#f3e3bf;color:#4a2e1f;box-shadow:inset 0 0 0 1px #d9bd86}.dir-a .chip.on{background:#c96442;color:#fff;box-shadow:inset 0 -2px 0 #9c4a2f}
.dir-a .counter{background:#f3e3bf;box-shadow:inset 0 0 0 1px #e0c793;color:#5b3d2a}.dir-a .counter.warn{background:#ffe9b8;box-shadow:inset 0 0 0 1.5px #e0900b}
.dir-a .search{background:#f1dfb8;color:#8a6a48;box-shadow:inset 0 1px 0 #dcc08a}
.dir-a .dept{color:#8a5a32}.dir-a .dept .cnt{color:#a98a64}
.dir-a .ag .face{background:#ead6ad;box-shadow:inset 0 0 0 1px #d6b77f}.dir-a .ag .meta,.dir-a .ag .ev{color:#8a6a48}
.dir-a .ag.sel{background:#fff7e3;box-shadow:inset 3px 0 0 #c96442,0 0 0 1px #e6cfa0}.dir-a .ag:not(.sel):nth-child(odd){background:#f8ecd2}
.dir-a .st.working{color:#2f6fd6}.dir-a .st.blocked{color:#b56f00}.dir-a .st.done{color:#1f8a4c}.dir-a .st.idle{color:#8a7a66}.dir-a .st.unknown{color:#9a8a74}
.dir-a .log li .ic{background:#f3e3bf;color:#7a5236;box-shadow:inset 0 0 0 1px #d9bd86}.dir-a .log li .ic.attempt{color:#b0402a}.dir-a .log li .ic.done{background:#d9f2e0;color:#1f8a4c;box-shadow:inset 0 0 0 1px #9fd4b0}.dir-a .log li .ic.user_prompt{background:#dceeff;color:#2f6fd6}.dir-a .log li .ic.ssh{background:#dce8ff;color:#3a6fb0}
.dir-a .log time{color:#a98a64}.dir-a .mini .vp{box-shadow:0 0 0 2px #c96442,0 0 0 4px rgba(255,250,240,.7)}
.dir-a .card .face{background:#ead6ad}.dir-a .card .meta{color:#8a6a48}.dir-a .card .task{background:#f3e3bf;box-shadow:inset 0 0 0 1px #e0c793}.dir-a .card .task small{color:#8a5a32}
.dir-a .card::after{background:#fbf3df;border-right:2px solid #6a4228;border-bottom:2px solid #6a4228}
.dir-a .hint{color:#fbf3df;text-shadow:0 1px 0 #2b1d1b}

/* ---------- B: Неоновый хаб (dark Drover + glass & neon) */
.dir-b{background:#151515;color:#ecebe6}
.dir-b .side{background:#1c1c1b;border-right:1px solid #2a2a28}.dir-b .lights i:nth-child(1){background:#ff5f57}.dir-b .lights i:nth-child(2){background:#febc2e}.dir-b .lights i:nth-child(3){background:#28c840}
.dir-b .side .new{color:#ecebe6}.dir-b .side .cap{color:#7d7b74}.dir-b .side .proj.on{background:#2a2a28}.dir-b .side .n{color:#7d7b74}.dir-b .side .agent{color:#b8b6ad}
.dir-b .side .foot{background:#222221;border:1px solid #2e2e2c;color:#b8b6ad}.dir-b .side .bar{background:#333331}.dir-b .side .bar b{background:#d97757}
.dir-b .tabs{background:#1c1c1b;border-bottom:1px solid #2a2a28}.dir-b .tabs span{color:#8f8d85}.dir-b .tabs span.on{background:#2c2c2a;color:#ecebe6}
.dir-b .stage{background:#20263a}
.dir-b .panel{background:rgba(9,13,22,.9);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border:1px solid rgba(94,242,255,.26);border-radius:7px;box-shadow:0 0 0 1px rgba(0,0,0,.45),0 14px 34px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.05);color:#dffbff}
.dir-b .panel::before{content:'';position:absolute;inset:-1px;border-radius:7px;pointer-events:none;background:linear-gradient(#5ef2ff,#5ef2ff) top left/12px 2px,linear-gradient(#5ef2ff,#5ef2ff) top left/2px 12px,linear-gradient(#5ef2ff,#5ef2ff) bottom right/12px 2px,linear-gradient(#5ef2ff,#5ef2ff) bottom right/2px 12px;background-repeat:no-repeat;filter:drop-shadow(0 0 4px rgba(94,242,255,.7))}
.dir-b h3{font:600 10.5px/1 'SF Mono',ui-monospace,Menlo,monospace;letter-spacing:.16em;text-transform:uppercase;color:#5ef2ff;text-shadow:0 0 8px rgba(94,242,255,.5)}
.dir-b .seg{background:rgba(255,255,255,.05);box-shadow:inset 0 0 0 1px rgba(94,242,255,.14)}.dir-b .btn{background:rgba(255,255,255,.06);color:#cfe9f2;box-shadow:inset 0 0 0 1px rgba(94,242,255,.2)}
.dir-b .seg .btn{background:transparent;box-shadow:none;color:#8fb3c4}.dir-b .seg .btn.on{background:rgba(94,242,255,.14);color:#5ef2ff;box-shadow:inset 0 0 0 1px rgba(94,242,255,.55),0 0 14px rgba(94,242,255,.3)}
.dir-b .btn.primary{background:#d97757;color:#fff;box-shadow:0 0 16px rgba(217,119,87,.45)}
.dir-b .chip{background:rgba(255,255,255,.05);color:#cfe9f2;box-shadow:inset 0 0 0 1px rgba(94,242,255,.18)}.dir-b .chip.on{background:rgba(255,122,217,.14);color:#ff9ae3;box-shadow:inset 0 0 0 1px rgba(255,122,217,.6),0 0 14px rgba(255,122,217,.3)}
.dir-b .counter{background:rgba(255,255,255,.04);box-shadow:inset 0 0 0 1px rgba(94,242,255,.14);color:#a9c3cf}.dir-b .counter b{color:#eafcff}.dir-b .counter.warn{box-shadow:inset 0 0 0 1px rgba(245,184,61,.7),0 0 14px rgba(245,184,61,.25)}
.dir-b .search{background:rgba(255,255,255,.05);color:#6f8ea0;box-shadow:inset 0 0 0 1px rgba(94,242,255,.14)}
.dir-b .dept{color:#5ef2ff;font-family:'SF Mono',ui-monospace,monospace;font-size:10.5px;letter-spacing:.14em}.dir-b .dept .cnt{color:#6f8ea0}
.dir-b .ag .face{background:linear-gradient(#26304a,#161c2c);box-shadow:inset 0 0 0 1px rgba(94,242,255,.2)}.dir-b .ag .meta,.dir-b .ag .ev{color:#7f9aaa}
.dir-b .ag.sel{background:rgba(94,242,255,.08);box-shadow:inset 0 0 0 1px rgba(94,242,255,.5),0 0 18px rgba(94,242,255,.15)}
.dir-b .st.working{color:#60a5fa}.dir-b .st.blocked{color:#f5b83d}.dir-b .st.done{color:#3ecf7a}.dir-b .st.idle{color:#8b8f99}.dir-b .st.unknown{color:#6f6f78}
.dir-b .log li .ic{background:rgba(94,242,255,.1);color:#5ef2ff;box-shadow:inset 0 0 0 1px rgba(94,242,255,.3)}.dir-b .log li .ic.attempt{background:rgba(255,107,107,.12);color:#ff8a8a;box-shadow:inset 0 0 0 1px rgba(255,107,107,.4)}.dir-b .log li .ic.done{background:rgba(62,207,122,.12);color:#3ecf7a;box-shadow:inset 0 0 0 1px rgba(62,207,122,.4)}.dir-b .log li .ic.user_prompt{background:rgba(255,154,107,.12);color:#ff9a6b;box-shadow:inset 0 0 0 1px rgba(255,154,107,.4)}.dir-b .log li .ic.ssh{background:rgba(124,242,140,.12);color:#7cf28c;box-shadow:inset 0 0 0 1px rgba(124,242,140,.4)}
.dir-b .log time{color:#6f8ea0}.dir-b .mini .vp{box-shadow:0 0 0 1.5px #5ef2ff,0 0 12px rgba(94,242,255,.6)}
.dir-b .card .face{background:linear-gradient(#26304a,#161c2c)}.dir-b .card .meta{color:#7f9aaa}.dir-b .card .task{background:rgba(94,242,255,.06);box-shadow:inset 0 0 0 1px rgba(94,242,255,.18)}.dir-b .card .task small{color:#5ef2ff;font-family:'SF Mono',ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase;font-size:9.5px}
.dir-b .card::after{background:rgba(9,13,22,.95);border-right:1px solid rgba(94,242,255,.4);border-bottom:1px solid rgba(94,242,255,.4)}
`

export function hudHtml(dir, size, scene, meta) {
  const P = THEMES[dir === 'a' ? 'cozy' : 'neon']
  const zoom = size === 'l' ? 1 : 2
  const stageW = 1440 - 250, stageH = 900 - 48
  const visW = stageW - 318 - 28
  const main = meta.main
  const fx = size === 'l' ? meta.width / 2 : main.x + main.width / 2
  const fy = size === 'l' ? meta.height / 2 : main.y + main.height * 0.42
  let tx = Math.round(visW / 2 + 14 - fx * zoom), ty = Math.round(stageH / 2 - fy * zoom)
  tx = Math.min(0, Math.max(tx, stageW - 318 - 28 - meta.width * zoom)); ty = Math.min(0, Math.max(ty, stageH - meta.height * zoom))
  if (meta.width * zoom < visW) tx = Math.round((visW - meta.width * zoom) / 2 + 14)
  if (meta.height * zoom < stageH) ty = Math.round((stageH - meta.height * zoom) / 2)
  const agents = scene.projects.flatMap((p) => p.agents.map((a) => ({ ...a, project: p.name })))
  const counts = { working: 0, blocked: 0, done: 0, idle: 0 }
  for (const a of agents) if (counts[a.status] !== undefined) counts[a.status]++
  const lastFor = (name) => {
    const e = [...scene.events].reverse().find((e) => e.to === name || e.from === name || e.at === name)
    if (!e) return { prompt: '', attempt: '', done: '' }[0] ?? (agents.find((a) => a.name === name)?.lead ? '→ раздаёт задачи · 1 мин' : 'нет событий за 30 мин')
    if (e.type === 'prompt' && e.to === name) return `← задача от ${e.from.replace(/^\w+-/, '')} · сейчас`
    if (e.type === 'prompt') return `→ задача для ${e.to.replace(/^\w+-/, '')} · сейчас`
    if (e.type === 'user_prompt') return '← задача от вас · 8 с'
    if (e.type === 'attempt') return e.from === name ? `→ ${e.to.replace(/^\w+-/, '')}: не подтверждено` : '← попытка без подтверждения'
    if (e.type === 'done') return '✓ закончил · 3 с'
    if (e.type === 'ssh') return `⇄ SSH на ${e.to} · 20 с`
    if (e.type === 'board') return '▤ карточка на доске · 12 с'
    return ''
  }
  const selected = size === 'm' ? 'drover-backend' : null
  const rows = (p) => p.agents.slice(0, size === 'l' && p.name === 'drover' ? 9 : 99).map((a) => `
      <div class="ag${a.name === selected ? ' sel' : ''}">
        <div class="face"><img class="px" src="${portrait(a)}"></div>
        <div class="nm">${a.name}</div>
        <span class="st ${a.status}"><img class="px" src="${mark(P, a.status)}">${STATUS_RU[a.status]}</span>
        <div class="meta">${KIND_RU[a.kind] ?? a.kind} · ${ROLE_RU[a.role]}${a.lead ? ' · главный' : ''}</div>
        <div class="ev">${lastFor(a.name)}</div>
        ${a.name === selected ? `<div class="acts"><button class="btn primary">${svg('chat')}Открыть чат</button><button class="btn">${svg('focus')}На карте</button><button class="btn">${svg('term')}</button></div>` : ''}
      </div>`).join('')
  const more = size === 'l' ? `<div class="dept" style="justify-content:center;text-transform:none;letter-spacing:0;font-weight:500">ещё 21 агент в зале drover…</div>` : ''
  const log = scene.events.slice(0, 5).map((e) => eventLine(e, dir))
  const times = ['сейчас', '2 с', '5 с', '12 с', '20 с']
  const miniW = 196, miniH = Math.round(meta.height * miniW / meta.width)
  const vp = { x: Math.max(0, -tx / zoom), y: Math.max(0, -ty / zoom), w: Math.min(meta.width, visW / zoom), h: Math.min(meta.height, stageH / zoom) }
  const k = miniW / meta.width
  let card = ''
  if (selected && meta.nodes[selected]?.head) {
    const h = meta.nodes[selected].head
    const cx = tx + h.x * zoom, cy = ty + (h.y - 22) * zoom
    const a = agents.find((x) => x.name === selected)
    card = `<div class="hud panel card" style="left:${Math.round(cx - 135)}px;top:${Math.round(cy - 196)}px">
      <div class="top"><div class="face"><img class="px" src="${portrait(a)}"></div><div><div class="nm">${a.name}</div><div class="meta">${KIND_RU[a.kind]} · ${ROLE_RU[a.role]}</div><div class="meta"><span class="st ${a.status}" style="display:inline-flex;align-items:center;gap:5px;font-weight:600"><img class="px" style="width:10px;height:10px" src="${mark(P, a.status)}">${STATUS_RU[a.status]} · 4 мин</span></div></div></div>
      <div class="task"><small>Последняя задача · от lead</small>API для доски задач: статусы и перенос карточек</div>
      <div class="acts"><button class="btn primary">${svg('chat')}Открыть чат</button><button class="btn">${svg('term')}Терминал</button></div>
    </div>`
  }
  const side = `<aside class="side"><div class="lights"><i></i><i></i><i></i></div>
    <div class="new">${svg('plus')} Новый агент</div>
    <div class="cap">Проекты</div>
    ${scene.projects.map((p, i) => `<div class="proj${i === 0 ? ' on' : ''}">${svg('folder')} ${p.name}<span class="n">${p.agents.length}</span></div>`).join('')}
    <div class="foot"><span>Claude</span><div class="bar"><b style="width:34%"></b></div><span>34%</span><span>Codex</span><div class="bar"><b style="width:21%"></b></div><span>21%</span></div>
  </aside>`
  return `<!doctype html><html><head><meta charset="utf-8"><title>office v2 ${dir}-${size}</title><style>${CSS}</style></head>
<body class="dir-${dir}"><div class="win">${side}
<main class="main"><div class="tabs"><span>Чаты</span><span class="on">Общий зал</span></div>
<section class="stage">
  <img class="world" src="scene-${dir}-${size}.png" style="width:${meta.width * zoom}px;height:${meta.height * zoom}px;transform:translate(${tx}px,${ty}px)">
  <div class="hud panel" style="left:14px;top:14px;padding:8px 10px;display:flex;flex-direction:column;gap:8px">
    <div class="row"><h3 style="margin:0 6px 0 2px">Общий зал</h3>
      <span class="chip${size === 'l' ? ' on' : ''}">Все залы</span>
      ${scene.projects.map((p, i) => `<span class="chip${i === 0 && size !== 'l' ? ' on' : ''}">${p.name} <small>${p.agents.length}</small></span>`).join('')}
    </div>
    <div class="row"><span class="seg"><button class="btn${zoom === 1 ? ' on' : ''}">×1</button><button class="btn${zoom === 2 ? ' on' : ''}">×2</button><button class="btn">×3</button></span>
      <button class="btn">${svg('fit')}Вместить</button><button class="btn">${svg('focus')}К моему залу</button>
      <span class="seg"><button class="btn on" title="Связи">${svg('links')}Связи</button><button class="btn" title="Терминалы">${svg('term')}</button></span></div>
  </div>
  <div class="hud panel roster"><h3>Команда <span style="margin-left:auto;font-weight:500;opacity:.7">${agents.length}</span></h3>
    <div class="counters">
      <div class="counter"><img class="px" src="${mark(P, 'working')}"><b>${counts.working}</b> работают</div>
      <div class="counter${counts.blocked ? ' warn' : ''}"><img class="px" src="${mark(P, 'blocked')}"><b>${counts.blocked}</b> ждут вас</div>
      <div class="counter"><img class="px" src="${mark(P, 'done')}"><b>${counts.done}</b> готово</div>
      <div class="counter"><img class="px" src="${mark(P, 'idle')}"><b>${counts.idle}</b> свободны</div>
    </div>
    <div class="search">${svg('search')} Имя, роль или статус</div>
    <div class="list">${scene.projects.map((p) => `<div class="dept"><span>${p.name}</span><span class="cnt">${p.agents.length}</span></div>${rows(p)}${p.name === 'drover' ? more : ''}`).join('')}</div>
  </div>
  <div class="hud panel log"><h3>Журнал</h3><ul>${log.map((l, i) => `<li><span class="ic ${l.cls}">${l.icon}</span><span>${l.text}</span><time>${times[i]}</time></li>`).join('')}</ul></div>
  <div class="hud panel mini" style="right:346px"><h3>Карта</h3><div class="map" style="width:${miniW}px;height:${miniH}px"><img src="scene-${dir}-${size}.png" style="width:${miniW}px;height:${miniH}px"><div class="vp" style="left:${Math.round(vp.x * k)}px;top:${Math.round(vp.y * k)}px;width:${Math.round(vp.w * k)}px;height:${Math.round(vp.h * k)}px"></div></div></div>
  ${card}
</section></main></div></body></html>`
}

if (process.argv[1]?.endsWith('hud.mjs')) {
  const dirPath = process.argv[2]
  for (const dir of ['a', 'b']) for (const size of ['s', 'm', 'l']) {
    const meta = JSON.parse(readFileSync(join(dirPath, `scene-${dir}-${size}.json`), 'utf8'))
    writeFileSync(join(dirPath, `hud-${dir}-${size}.html`), hudHtml(dir, size, SCENES[size], meta))
  }
  console.log('hud →', dirPath)
}
