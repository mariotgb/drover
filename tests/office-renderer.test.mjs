import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'drover-office-v21-'))
await build({ stdin: { contents: ['layout', 'camera', 'scheduler', 'effects', 'engine', 'scene', 'labels', 'navigation', 'routes', 'text', 'generated-art', 'visibility', 'view-state', 'reconcile'].map(n => `export * from './src/renderer/src/office/${n}'`).join('\n') + "\nexport { OfficeArt as AtlasArt, animationFrame } from './src/renderer/src/office/art'\nexport { setLanguage } from './src/renderer/src/i18n'", resolveDir: resolve('.'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: join(dir, 'renderer.cjs'), alias: { '@shared': resolve('src/shared') }, logLevel: 'silent', plugins: [{ name: 'test-art', setup(b) {
  b.onLoad({filter:/office\/art\.ts$/}, args => {
    let source=readFileSync(args.path,'utf8');const manifests={},urls={}
    for(const theme of ['cozy','neon']) {
      const path=`./assets/v2/${theme}/manifest.json`,manifest=JSON.parse(readFileSync(resolve(`src/renderer/src/office/assets/v2/${theme}/manifest.json`),'utf8'))
      manifests[path]=manifest;for(const atlas of Object.values(manifest.atlases))urls[`./assets/v2/${theme}/${atlas.file}`]=`${theme}/${atlas.file}`
    }
    source=source.replace(/^const manifests = .*$/m,`const manifests = ${JSON.stringify(manifests)}`).replace(/^const urls = .*$/m,`const urls = ${JSON.stringify(urls)}`)
    return {contents:source,loader:'ts'}
  }); b.onResolve({ filter: /^\.\/art$/ }, () => ({ path: 'art', namespace: 'test-art' })); b.onLoad({ filter: /.*/, namespace: 'test-art' }, () => ({ contents: `export class OfficeArt {
  theme = 'cozy'; async load() {}; async setTheme(theme) { this.theme = theme; globalThis.officeCalls.push({ id: 'theme', theme }) }
  bake(layout) { globalThis.officeCalls.push({id:'bake'}); return {width:layout.bounds.width,height:layout.bounds.height} }
  paintFront() {}
  board(ctx,lot,counts) { globalThis.officeCalls.push({id:'board',departmentId:lot.departmentId,counts:[...counts]}) }
  paint(ctx,id,state,anchor,time) { globalThis.officeCalls.push({id,state,anchor,time}); return true }
  overlay(ctx,id,data) { globalThis.officeCalls.push({id,...data}) }
  hitRect(id,state,p) { return {x:p.x-12,y:p.y-42,width:24,height:44} }
}`, loader: 'js' })) } }] })
const m = createRequire(import.meta.url)(join(dir, 'renderer.cjs')); rmSync(dir, { recursive: true })
const departments = n => Array.from({ length: n }, (_, i) => ({ id: `d${i}`, name: `Project${i}`, workspaceId: `w${i}`, workspaceIds: [`w${i}`], number: i + 1 }))
const occupants = (n, projects = 1, lead = false) => Array.from({ length: n }, (_, i) => ({ paneId: `p${i}`, departmentId: `d${i % projects}`, lead: lead && i < projects }))
const office = (n = 8) => ({ session: 'fixture', generation: 'g1', departments: departments(1), seats: [], agents: occupants(n, 1, true).map((p, i) => ({ ...p, id: `a${i}`, name: `Project0-${i === 0 ? 'lead' : `agent${i}`}`, kind: 'codex', role: i === 0 ? 'lead' : 'backend', roleSource: 'binding', status: 'working', lastStatusAt: 0, lastEventAt: null, lastTask: null, incarnation: `i${i}`, seatId: `s${i}`, transcriptCoverage: 'exact' })), externalNodes: [{ id: 'user', name: 'User', kind: 'user' }, { id: 'machine', name: 'fixture-machine', kind: 'machine' }], links: [], recentEvents: [], statusCounts: { working: n, blocked: 0, idle: 0, done: 0, unknown: 0, disconnect: 0 } })
const animation = (id, now, from = 'a0', to = 'a1') => ({ id, from, to, kind: 'prompt', count: 1, ts: now })
function host(t) {
  const pending = new Map(), listeners = new Map(); let seq = 0, paints = 0, observers = 0
  const ctx = new Proxy({}, { get(_target, key) { return key === 'drawImage' ? () => paints++ : key === 'setLineDash' ? pattern => globalThis.officeCalls.push({id:'lineDash',pattern}) : () => {} }, set() { return true } })
  const canvas = () => ({ width: 0, height: 0, getContext: () => ctx, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1440, height: 900 }), addEventListener: (k, v) => listeners.set(k, v), removeEventListener: k => listeners.delete(k), setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} })
  t.mock.method(globalThis, 'requestAnimationFrame', cb => { const id = ++seq; pending.set(id, cb); return id })
  t.mock.method(globalThis, 'cancelAnimationFrame', id => pending.delete(id))
  t.mock.method(globalThis, 'ResizeObserver', function() { observers++; this.observe = () => {}; this.disconnect = () => observers-- })
  globalThis.window = { devicePixelRatio: 2 }; globalThis.document = { createElement: canvas, documentElement: {} }; globalThis.officeCalls = []
  return { canvas, listeners, tick(time) { const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(cb => cb(time)) }, get pending() { return pending.size }, get paints() { return paints }, get observers() { return observers } }
}
globalThis.requestAnimationFrame = () => 0; globalThis.cancelAnimationFrame = () => {}; globalThis.ResizeObserver = class {}

test('v2 growth matches the 1/4/8/16/30 agent reference and remains one hall', () => {
  for (const [count, width, height, rows] of [[1,224,208,0],[4,224,320,1],[8,320,320,1],[16,320,432,2],[30,544,432,2]]) {
    const l = new m.OfficeLayout().update(departments(1), occupants(count,1,true))
    assert.equal(l.lots.length,1); assert.equal(l.lots[0].width,width); assert.equal(l.lots[0].height,height); assert.equal(l.lots[0].shape.rows,rows); assert.equal(l.seats.length,count)
    assert.equal(l.seats.filter(s => s.side === 'head').length,1); assert.equal(l.corridor.y,0); assert.equal(l.lots[0].y + l.lots[0].height,0)
  }
})
test('0/20 projects and 200 agents stay inside bottom-aligned rooms with lobby, corridor and servers', () => {
  for (const n of [0,1,20]) {
    const l = new m.OfficeLayout().update(departments(n), n ? occupants(200,n) : [], false, 0, 2)
    assert.equal(l.lots.length,n); assert.equal(l.seats.length,n ? 200 : 0); assert.ok(l.bounds.width > 0 && l.bounds.height > 0); assert.equal(l.lobby.width,192); assert.equal(l.server.width,160)
    let right = l.lobby.x + l.lobby.width
    for (const lot of l.lots) { assert.equal(lot.x,right-16); right=lot.x+lot.width; assert.equal(lot.y+lot.height,0); for (const s of l.seats.filter(s=>s.departmentId===lot.departmentId)) { assert.ok(s.x>=lot.x && s.x+s.width<=lot.x+lot.width); assert.ok(Number.isFinite(s.anchor.y)) } }
    assert.equal(l.server.x,right-16)
  }
})
test('logical seats survive rename/status/restart and reuse lowest vacancy; shrink waits ten minutes', () => {
  const model = new m.OfficeLayout(), list = occupants(16,1,true), initial = model.update(departments(1),list,false,0)
  const reordered = model.update(departments(1),list.toReversed().map(a=>({...a,name:'renamed',status:'blocked',incarnation:'new'})),false,100)
  for (const s of initial.seats) assert.deepEqual(reordered.seats.find(a=>a.paneId===s.paneId),s)
  const reduced = model.update(departments(1),list.slice(0,4),false,200)
  assert.equal(reduced.lots[0].height,432)
  const replaced = model.update(departments(1),[...list.slice(0,4),{paneId:'new',departmentId:'d0'}],false,300)
  assert.equal(replaced.seats.find(s=>s.paneId==='new').index,3)
  model.update(departments(1),list.slice(0,4),false,1000)
  const compact = model.update(departments(1),list.slice(0,4),false,200 + m.SHRINK_DELAY)
  assert.equal(compact.lots[0].width,224); assert.equal(compact.lots[0].height,320); assert.equal(compact.corridor.y,0)
})
test('seat anchors match north/south/head hand, landing and occlusion order', () => {
  const l = new m.OfficeLayout().update(departments(1),occupants(8,1,true)), north=l.seats.find(s=>s.side==='north'), south=l.seats.find(s=>s.side==='south'), head=l.seats.find(s=>s.side==='head')
  const n=m.seatPose(north), s=m.seatPose(south), h=m.seatPose(head)
  assert.equal(n.agent.y,north.deskTop+8); assert.equal(n.chair.y,north.deskTop+7); assert.equal(n.land.y,north.deskTop+4)
  assert.equal(s.agent.y,south.deskTop+44); assert.equal(s.chair.y,south.deskTop+47); assert.equal(s.land.y,south.deskTop+18)
  assert.equal(h.agent.y,head.deskTop+8)
  const route=m.routeCable(south,l.lots[0],{x:600,y:-208,width:160,height:208},{x:648,y:-68})
  assert.ok(route.some(p=>p.y>0)); for(let i=1;i<route.length;i++) assert.ok(route[i].x===route[i-1].x || route[i].y===route[i-1].y)
})
test('camera uses integer zoom even when campus cannot fit; CSS-pixel hit and drag are stable', () => {
  const c={x:-20,y:30,zoom:2},p={x:84,y:106}; assert.deepEqual(m.worldToScreen(m.screenToWorld(p,c),c),p); assert.deepEqual(m.screenToWorld(p,m.zoomAt(c,3,p)),m.screenToWorld(p,c))
  for(const w of [1,300,2000]) assert.ok([1,2,3].includes(m.fitCamera({x:-32,y:-500,width:1600,height:1000},w,900).zoom))
  const targets=[{paneId:'rear',rect:{x:40,y:30,width:32,height:48},y:40},{paneId:'front',rect:{x:40,y:30,width:32,height:48},y:50}]; assert.equal(m.hitTest(targets,m.worldToScreen({x:50,y:40},c),c),'front')
  const g=new m.DragGesture();g.begin({x:0,y:0});assert.equal(g.end({x:2,y:1}),true);g.begin({x:0,y:0});assert.equal(g.end({x:7,y:0}),false)
})
test('single hall excludes every other room, keeps seats and fits a small viewport', () => {
  const layout = new m.OfficeLayout().update(departments(4), occupants(30,4,true), false, 0, 2)
  const hall = m.singleHallLayout(layout, 'd2')
  assert.deepEqual(hall.lots.map(l => l.departmentId), ['d2'])
  assert.equal(hall.server, null)
  assert.ok(hall.seats.every(s => s.departmentId === 'd2'))
  for (const seat of hall.seats) assert.deepEqual(seat, layout.seats.find(s => s.paneId === seat.paneId))
  assert.equal(m.singleHallLayout(layout, null), layout)
  const camera = m.fitHallCamera(hall.bounds, 240, 350)
  assert.ok(hall.bounds.width * camera.zoom <= 240)
  assert.ok(hall.bounds.height * camera.zoom <= 350)
  assert.deepEqual([m.adjacentHall(['d3','d1','d2'], 'd1', 1), m.adjacentHall(['d3','d1','d2'], 'd3', -1)], ['d2','d2'])
  assert.equal(m.hallSwipe({x:150,y:0},{x:50,y:5},400),1)
  assert.equal(m.hallSwipe({x:50,y:0},{x:150,y:5},400),-1)
  assert.equal(m.hallSwipe({x:50,y:0},{x:150,y:80},400),0)
  assert.equal(m.hallSwipe({x:50,y:0},{x:150,y:5},1000),0)
})
test('engine single hall paints and targets only selected agents and restores all halls', t => {
  const h=host(t),s=office(8);s.departments=departments(2);s.agents.forEach((a,i)=>a.departmentId=`d${i%2}`)
  const e=new m.OfficeEngine(h.canvas(),{onOpen(){},onHover(){}})
  e.setVisibility(true,true);e.update({state:s,animations:[]});e.setHall('d1');h.tick(0)
  assert.equal(e.mapState().rooms.length,1)
  assert.ok(e.targets.length)
  assert.ok(e.targets.every(target=>s.agents.find(a=>a.paneId===target.paneId).departmentId==='d1'))
  assert.equal(globalThis.officeCalls.filter(c=>c.id==='plaque').length,4)
  assert.ok(!globalThis.officeCalls.some(c=>c.id==='agent.user'||c.id==='object.reception'))
  e.setHall(null);h.tick(40)
  assert.equal(e.mapState().rooms.length,4)
  e.dispose()
})
test('task count changes redraw only board data without rebaking world, light or front layers', t => {
  const h=host(t),e=new m.OfficeEngine(h.canvas(),{onOpen(){},onHover(){}})
  e.setVisibility(true,true);e.update({state:office(),animations:[]});h.tick(0)
  const world=e.world,layout=e.layout,bakes=globalThis.officeCalls.filter(c=>c.id==='bake').length
  for(let i=1;i<=20;i++) { e.setBoardCounts(new Map([['d0',[i,2,3]]]));h.tick(i*40) }
  assert.equal(e.world,world);assert.equal(e.layout,layout)
  assert.equal(globalThis.officeCalls.filter(c=>c.id==='bake').length,bakes)
  assert.deepEqual(globalThis.officeCalls.filter(c=>c.id==='board').at(-1).counts,[20,2,3])
  e.dispose()
})
test('carrier phases preserve throw, arc, catch, attempt fall and TTL; history prompt never confirms', () => {
  const q=new m.EnvelopeQueue(),now=10000; q.ingest([animation('one',now)],now,true,()=>300)
  const a=q.active[0];assert.equal(a.duration,1260);assert.equal(m.carrierPhase(a,now+160).phase,'throw');assert.equal(m.carrierPhase(a,now+300).phase,'flight');assert.equal(m.carrierPhase(a,now+1540).phase,'catch')
  const mid=m.arcPoint({x:0,y:0},{x:100,y:0},.5);assert.ok(mid.y<0)
  q.advance(now+1540);assert.ok(q.notes.has('a1'))
  const s=office();s.recentEvents=[{id:'history',kind:'prompt',from:'a0',to:'a1',ts:now,summary:''},{id:'attempt',kind:'prompt_attempt',from:'a0',to:'a1',ts:now,summary:''}];const attempt=new m.EnvelopeQueue();attempt.ingestEvents(s,now,true,()=>100);assert.equal(attempt.active.length,1);assert.equal(attempt.active[0].kind,'prompt_attempt');assert.equal(m.carrierPhase(attempt.active[0],now+280+800*.7+200).phase,'fall');attempt.advance(now+5000);assert.equal(attempt.notes.size,0)
  const expired=new m.EnvelopeQueue();expired.ingest([animation('old',now-5001)],now,true);assert.equal(expired.active.length,0)
})
test('12 carriers, 20 queue slots, 2-second coalescing, generation reset and reduced-motion outcomes', () => {
  const q=new m.EnvelopeQueue(),now=10000; q.ingest(Array.from({length:70},(_,i)=>animation(String(i),now,`a${i}`,`b${i}`)),now,true);assert.ok(q.active.length<=12);assert.ok(q.pending.length<=20)
  const pair=new m.EnvelopeQueue();pair.ingest([animation('a',now),animation('b',now+1)],now,true);assert.equal(pair.active.length,1);assert.equal(pair.active[0].count,2);pair.ingest([animation('a',now)],now+1,true);assert.equal(pair.active[0].count,2)
  const reduced=new m.EnvelopeQueue();reduced.ingest([animation('r',now)],now,true,()=>0,true);assert.equal(reduced.active.length,0);assert.ok(reduced.notes.has('a1'));reduced.pruneNotes({...office(),agents:[{id:'a1',status:'idle'}]},now);assert.equal(reduced.notes.size,0)
  reduced.clear();assert.equal(reduced.notes.size,0);assert.equal(m.officeTheme(false),'cozy');assert.equal(m.officeTheme(true),'neon')
})
test('frame loop paints at 30 foreground / at most 5 background FPS and zero hidden; dispose cancels RAF', () => {
  const pending=new Map();let id=0,count=0;const loop=new m.FrameLoop({request:cb=>{pending.set(++id,cb);return id},cancel:id=>pending.delete(id)},()=>count++)
  const tick=t=>{const callbacks=[...pending.values()];pending.clear();callbacks.forEach(cb=>cb(t))};loop.setVisibility(true,true);for(let t=0;t<1000;t+=10)tick(t);assert.ok(count<=30)
  loop.setVisibility(true,false);count=0;for(let t=1000;t<2000;t+=10)tick(t);assert.ok(count<=5);loop.setVisibility(false,false);assert.equal(pending.size,0);tick(3000);assert.ok(count<=5);loop.dispose()
})
test('engine baseline/reconnect cannot replay fresh history; live status done produces confetti only once', t => {
  const h=host(t),e=new m.OfficeEngine(h.canvas(),{onOpen(){},onHover(){}});let now=10000;t.mock.method(Date,'now',()=>now);const s=office();e.setVisibility(true,true);e.update({state:s,animations:[animation('baseline',now)]});assert.equal(e.effects.active.length,0)
  e.update({state:s,animations:[animation('live',now)]});assert.equal(e.effects.active.length,1)
  const done={...s,agents:s.agents.map((a,i)=>i===1?{...a,status:'done',lastStatusAt:now}:a)};e.update({state:done,animations:[]});assert.equal(e.effects.celebrations.size,1)
  e.setVisibility(false,true);e.setVisibility(true,true);done.recentEvents=[{id:'return-attempt',kind:'prompt_attempt',from:'a0',to:'a1',ts:now,summary:''}];e.update({state:done,animations:[]});assert.equal(e.effects.active.length,0);assert.equal(e.effects.celebrations.size,0)
  e.setConnected(false);e.update({state:done,animations:[animation('offline',now)]});assert.equal(e.effects.active.length,0);e.dispose();assert.equal(h.pending,0);assert.equal(h.observers,0);assert.equal(h.listeners.size,0)
})
test('engine theme switch preserves places/camera; DPR2 click selects, drag does not; cached bake survives frames', async t => {
  const h=host(t),opened=[],e=new m.OfficeEngine(h.canvas(),{onOpen:id=>opened.push(id),onHover(){}});e.setVisibility(true,true);e.update({state:office(),animations:[]});h.tick(0)
  const s=e.layout.seats[1],anchor=m.seatPose(s).agent,p=m.worldToScreen({x:anchor.x,y:anchor.y-15},e.camera),event={clientX:p.x,clientY:p.y,pointerId:1,button:0}
  h.listeners.get('pointerdown')(event);h.listeners.get('pointerup')(event);assert.deepEqual(opened,['p1'])
  h.listeners.get('pointerdown')(event);h.listeners.get('pointermove')({...event,clientX:p.x+20});h.listeners.get('pointerup')({...event,clientX:p.x+20});assert.equal(opened.length,1)
  const before=JSON.stringify(e.layout.seats),camera={...e.camera};await e.setTheme(true);assert.equal(JSON.stringify(e.layout.seats),before);assert.deepEqual(e.camera,camera);assert.equal(e.art.theme,'neon');h.tick(40);const bakes=officeCalls.filter(c=>c.id==='bake').length;h.tick(80);assert.equal(officeCalls.filter(c=>c.id==='bake').length,bakes)
  e.setConnected(false);h.listeners.get('pointerdown')(event);h.listeners.get('pointerup')(event);assert.equal(opened.length,1)
  e.setVisibility(false,true);const painted=h.paints;h.tick(120);assert.equal(h.paints,painted);e.dispose()
})
test('50 open/close cycles leave no canvas listeners, RAF handles or resize observers', t => {
  const h=host(t);for(let i=0;i<50;i++){const e=new m.OfficeEngine(h.canvas(),{onOpen(){},onHover(){}});e.setVisibility(true,true);e.update({state:office(),animations:[]});h.tick(i*100);e.dispose();assert.equal(h.pending,0);assert.equal(h.observers,0);assert.equal(h.listeners.size,0)}
})
test('all office HUD words have five-language coverage; names lose common prefixes and inferred roles remain labelled', t => {
  host(t);for(const lang of ['en','ru','de','es','zh']) {m.setLanguage(lang);for(const key of Object.keys(m.officeMessages)){const text=m.officeText(key,{n:3});assert.ok(text.length);assert.ok(!text.includes('{n}'));if(lang!=='en'&&key!=='Team')assert.notEqual(text,key)};assert.ok(m.roleLabel({role:'backend',roleSource:'name'}).includes(m.roleLabel({role:'backend',roleSource:'binding'})));for(const role of ['future','constructor','__proto__'])assert.equal(m.roleLabel({role,roleSource:'default'}),m.roleLabel({role:'general',roleSource:'default'}))};m.setLanguage('en')
  const names=m.shortAgentNames(office().agents,departments(1));assert.equal(names.get('a0'),'lead');assert.equal(names.get('a1'),'agent1')
})
test('same-ID sidebar chat/board navigation exits office; menu buttons and arrow keys do not', () => {
  const row=()=>({closest(selector){return selector==='.sidebar .thread'?this:null}});assert.equal(m.isSidebarNavigation(row()),true);assert.equal(m.isSidebarNavigation(row(),'Enter'),true);assert.equal(m.isSidebarNavigation(row(),'ArrowDown'),false);assert.equal(m.isSidebarNavigation(null),false)
})

test('widening and adding a parallel bench retain occupied sides, rows and columns', () => {
  const model=new m.OfficeLayout(), d=departments(1)
  let before=model.update(d,occupants(4,1,true),false,0)
  for(const count of [8,16,30]) {
    const after=model.update(d,occupants(count,1,true),false,count)
    for(const seat of before.seats) {
      const next=after.seats.find(s=>s.paneId===seat.paneId)
      assert.equal(next.side,seat.side);assert.equal(next.row,seat.row);assert.equal(next.bench,seat.bench);assert.equal(next.col,seat.col)
    }
    assert.equal(new Set(after.seats.map(s=>s.index)).size,count)
    before=after
  }
})
test('opaque boss IDs place the cabinet beside reception and use boss anchors and art', async t => {
  const h=host(t),e=new m.OfficeEngine(h.canvas(),{onOpen(){},onHover(){}}),s=office(4)
  s.departments.push({...departments(1)[0],id:'opaque-hq',name:'HQ',number:999})
  s.agents.push({...s.agents[0],id:'opaque-token',paneId:'chief-pane',name:'Nobody can infer this',incarnation:'hash-only',departmentId:'opaque-hq',isBoss:true})
  e.setVisibility(true,true);e.update({state:s,animations:[]});h.tick(0)
  const lot=e.layout.lots[0];assert.equal(lot.departmentId,'opaque-hq');assert.equal(lot.x,e.layout.lobby.x+e.layout.lobby.width-16)
  assert.deepEqual(e.nodes.get('opaque-token').hand,{x:lot.x+124,y:lot.y+70})
  assert.ok(officeCalls.some(c=>c.id==='agent.boss'));assert.ok(officeCalls.some(c=>c.id==='object.desk.boss'&&c.anchor.y===lot.y+132))
  await e.setTheme(true);h.tick(40);assert.equal(e.layout.lots[0].departmentId,'opaque-hq');e.dispose()
})
test('unconfirmed input stays silent, board activity targets its own project, disabled events cannot replay', () => {
  const now=10000,s=office(),q=new m.EnvelopeQueue()
  s.recentEvents=[{id:'input',kind:'input_observed',from:'user',to:'a1',ts:now,summary:''},{id:'task',kind:'task_assigned',from:'a1',to:null,ts:now,summary:''}]
  q.ingestEvents(s,now,true,()=>120)
  assert.equal(q.flashes.has(JSON.stringify(['user','a1'])),false);assert.equal(q.active.length,1);assert.equal(q.active[0].kind,'board');assert.equal(q.active[0].from,'a1');assert.equal(q.active[0].to,'d0')
  const disabled=new m.EnvelopeQueue();disabled.ingest([animation('hidden',now)],now,false);disabled.ingest([animation('hidden',now)],now,true);assert.equal(disabled.active.length,0)
  q.notes.set('a1',{at:now,user:true});q.pruneNotes(s,now+600001);assert.equal(q.notes.size,0)
})

test('atlas adapter keeps the latest theme on out-of-order decode and respects empty chairs and finite poses', async t => {
  const releases=[], old=globalThis.Image
  globalThis.Image=class { decode(){return new Promise(resolve=>releases.push({src:this.src,resolve}))} }
  t.after(()=>{globalThis.Image=old})
  const art=new m.AtlasArt(),cozy=art.setTheme('cozy'),neon=art.setTheme('neon')
  releases.filter(r=>r.src.startsWith('neon/')).forEach(r=>r.resolve());await neon
  assert.equal(art.ready,true);assert.equal(art.manifest.set,'neon')
  releases.filter(r=>r.src.startsWith('cozy/')).forEach(r=>r.resolve());await cozy
  assert.ok([...art.images.values()].every(image=>image.src.startsWith('neon/')))
  for(const dir of ['front','back']) assert.deepEqual(art.frame(`object.chair.${dir}`,'in',0),art.manifest.sprites[`object.chair.${dir}`].states.in.frames[0])
  assert.deepEqual(art.frame('object.coffee','default',0),art.manifest.sprites['object.coffee'].states.default.frames[0])
  const animation=art.manifest.sprites['agent.codex'].states['throw:front']
  assert.deepEqual(m.animationFrame(animation,0),animation.frames[0]);assert.deepEqual(m.animationFrame(animation,10000),animation.frames.at(-1))
  assert.deepEqual(art.frame('effect.attempt','fall',499),art.manifest.sprites['effect.attempt'].states.fall.frames.at(-1))
})

test('manual projectLead wins over the earlier lead inferred from a name', t => {
  const h=host(t),e=new m.OfficeEngine(h.canvas(),{onOpen(){},onHover(){}}),s=office(4)
  s.agents[0]={...s.agents[0],role:'lead',roleSource:'name'};s.agents[1]={...s.agents[1],role:'lead',roleSource:'projectLead'}
  e.update({state:s,animations:[]})
  assert.equal(e.layout.seats.find(s=>s.side==='head').paneId,'p1')
  assert.notEqual(e.layout.seats.find(s=>s.paneId==='p0').side,'head')
  e.dispose()
})
test('SSH attempts stay dim/dashed and never energize equipment or move packets; real receipt can', t => {
  let now=10000;t.mock.method(Date,'now',()=>now)
  const h=host(t),e=new m.OfficeEngine(h.canvas(),{onOpen(){},onHover(){}}),s=office(4)
  const attempt={id:'ssh',from:'a0',to:'machine',kind:'ssh_attempt',style:'machine',count:1,lastAt:now,weight:1};s.links=[attempt]
  e.setVisibility(true,true);e.update({state:s,animations:[]});h.tick(0)
  assert.ok(officeCalls.some(c=>c.id==='lineDash'&&c.pattern.join(',')==='3,5'))
  assert.ok(officeCalls.some(c=>c.id==='object.machine'&&c.state==='idle'))
  assert.equal(officeCalls.filter(c=>c.id==='object.rack'&&c.state==='hot').length,0)
  assert.equal(officeCalls.filter(c=>c.id==='object.machine'&&c.state==='active').length,0)
  assert.equal(officeCalls.filter(c=>c.id==='effect.link.dot'&&c.state==='machine').length,0)
  const history={...s,links:[{...attempt,kind:'prompt'}]};e.update({state:history,animations:[]});globalThis.officeCalls=[];h.tick(40)
  assert.equal(officeCalls.filter(c=>c.id==='object.machine'&&c.state==='active').length,0)
  e.update({state:history,animations:[animation('machine-receipt',now,'a0','machine')]});globalThis.officeCalls=[];h.tick(80)
  assert.ok(officeCalls.some(c=>c.id==='object.machine'&&c.state==='active'))
  assert.ok(officeCalls.some(c=>c.id==='object.rack'&&c.state==='hot'))
  assert.ok(officeCalls.some(c=>c.id==='effect.link.dot'&&c.state==='machine'))
  now+=4001;globalThis.officeCalls=[];h.tick(120)
  assert.equal(officeCalls.filter(c=>c.id==='object.machine'&&c.state==='active').length,0)
  e.dispose()
})

test('link bounds include offscreen endpoints crossing the viewport and the lifted arc', () => {
  const bounds = m.arcBounds({x:-100,y:100},{x:200,y:100})
  assert.ok(bounds.x < 0 && bounds.x + bounds.width > 100)
  assert.ok(bounds.y < 60 && bounds.y + bounds.height > 100)
  assert.equal(m.pathLength([{x:0,y:0},{x:3,y:4},{x:3,y:10}]),11)
})
test('offscreen links do not build paths or paint dots, visible cached paths survive status updates', t => {
  const h=host(t),s=office(8),e=new m.OfficeEngine(h.canvas(),{onOpen(){},onHover(){}})
  globalThis.Path2D=class {rect(){}}
  const now=Date.now();s.links=[{id:'link',from:'a0',to:'a1',kind:'prompt',style:'agent',count:8,lastAt:now,weight:8}]
  e.setVisibility(true,true);e.update({state:s,animations:[]});e.camera={x:100000,y:100000,zoom:2};h.tick(0)
  assert.equal(e.linkPaths.size,0)
  assert.ok(!globalThis.officeCalls.some(c=>c.id==='effect.link.dot'))
  e.camera={x:0,y:600,zoom:2};h.tick(40)
  assert.equal(e.linkPaths.size,1);const paths=[...e.linkPaths.values()][0]
  e.update({state:{...s,agents:s.agents.map(a=>({...a,status:'idle'}))},animations:[]});h.tick(80)
  assert.equal([...e.linkPaths.values()][0],paths)
  e.dispose();delete globalThis.Path2D
})
test('HUD ignores decay/history/status timestamps but reacts to visible names, status and membership', () => {
  const s=office(50),view=m.officeViewState(null,s)
  const links={...s,links:[{weight:1}],recentEvents:[{id:'history'}],agents:s.agents.map(a=>({...a,lastStatusAt:123}))}
  assert.equal(m.officeViewState(view,links),view)
  const changed={...s,agents:s.agents.map((a,i)=>i? a:{...a,status:'blocked'})}
  assert.notEqual(m.officeViewState(view,changed),view)
  assert.equal(m.officeViewState(view,changed).departments,view.departments)
  assert.equal(m.officeViewState(view,changed).agents[1],view.agents[1])
  const events=Array.from({length:1000},(_,i)=>({id:String(i),from:i%2?'a0':'outside',to:null,kind:'prompt',ts:i,summary:''}))
  assert.deepEqual(m.visibleOfficeEvents({...s,recentEvents:events},'d0').map(e=>e.id),['999','997','995','993','991','989','987','985'])
})

test('office deltas preserve untouched sections, enforce versions/generation and prune bounded events', () => {
  const state={...office(),version:7},changed={...state.agents[0],status:'blocked'}
  const delta={session:state.session,generation:state.generation,baseVersion:7,version:8,agents:[changed],removedAgents:[],links:[],removedLinks:[],events:[],removedEvents:[]}
  const next=m.reconcileOffice(state,{delta,animations:[]})
  assert.equal(next.version,8);assert.equal(next.agents[0],changed);assert.equal(next.agents[1],state.agents[1])
  for(const key of ['links','recentEvents','departments','seats','externalNodes','statusCounts'])assert.equal(next[key],state[key])
  assert.equal(m.reconcileOffice(next,{delta,animations:[]}),null)
  assert.equal(m.reconcileOffice(state,{delta:{...delta,generation:'foreign'},animations:[]}),null)
  assert.equal(m.reconcileOffice(null,{delta,animations:[]}),null)
  const removed=m.reconcileOffice(next,{delta:{...delta,baseVersion:8,version:9,agents:[],removedAgents:[changed.id]},animations:[]})
  assert.ok(!removed.agents.some(a=>a.id===changed.id))
  const many=Array.from({length:1001},(_,i)=>({id:String(i),ts:i,from:null,to:null,kind:'input_observed',summary:''}))
  const events=m.reconcileOffice(state,{delta:{...delta,events:many},animations:[]})
  assert.equal(events.recentEvents.length,1000);assert.equal(events.recentEvents[0].id,'1')
  const hud=m.officeViewState(null,state);assert.equal(m.officeViewState(hud,{...state,version:8}),hud)
})
