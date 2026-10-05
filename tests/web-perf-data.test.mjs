import { buildTranscriptWorker } from './_transcript-worker.mjs'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
import {mkdtempSync,rmSync,writeFileSync,mkdirSync,appendFileSync,existsSync,readFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {createServer} from 'node:http'
import {EventEmitter} from 'node:events'
import {chromium} from 'playwright-core'

const dir=mkdtempSync(join(tmpdir(),'drover-data-tests-'))
await build({stdin:{contents:`export * from './src/renderer/src/model';export * from './src/renderer/src/structural-share';export * from './src/main/transcripts/revisions';export * from './src/main/transcripts/manager';export * from './src/main/remote/rpc'`,resolveDir:resolve('.'),loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:join(dir,'test.cjs'),alias:{'@shared':resolve('src/shared')},logLevel:'silent'})
await buildTranscriptWorker(dir)
const m=createRequire(import.meta.url)(join(dir,'test.cjs'));process.on('exit',()=>rmSync(dir,{recursive:true,force:true}))
const snapshot=()=>({version:'fixture',protocol:1,workspaces:[{workspace_id:'w1',number:1,label:'Project'},{workspace_id:'w2',number:2,label:'Other'}],tabs:[{workspace_id:'w1',tab_id:'t1',number:1},{workspace_id:'w1',tab_id:'t2',number:2},{workspace_id:'w2',tab_id:'t3',number:3}],panes:[1,2,3].map(n=>({pane_id:'p'+n,workspace_id:n===3?'w2':'w1',tab_id:'t'+n,agent:'claude',agent_status:'idle',revision:1,cwd:'/fixture',tokens:{preview:'index.html'}})),agents:[],layouts:[]})
const update=(revision,reset,items,stream='s')=>({paneId:'p1',stream,revision,reset,meta:null,items:items.map(id=>({id,kind:'user',text:id}))})

test('48 JSON snapshots changing another agent retain selected Thread, unchanged tabs/workspaces and address selectors',()=>{
 let raw=snapshot(), model=m.buildModel(raw);const active=model.byPane.get('p1'),otherProject=model.groups[1],tab=model.groups[0].tabs[0]
 const notifications={active:0,project:0,changed:0};let previous=model
 for(let n=0;n<48;n++){
  raw=JSON.parse(JSON.stringify(raw));raw.panes[1].agent_status=n%2?'idle':'working';raw.panes[1].revision++
  model=m.buildModel(raw,previous)
  if(model.byPane.get('p1')!==previous.byPane.get('p1'))notifications.active++
  if(model.groups[1]!==previous.groups[1])notifications.project++
  if(model.byPane.get('p2')!==previous.byPane.get('p2'))notifications.changed++
  assert.equal(model.byPane.get('p1'),active);assert.equal(model.groups[0].tabs[0],tab);assert.equal(model.groups[1],otherProject)
  assert.equal(model.groups[0].threads[0],active);assert.equal(model.threads[0],active);previous=model
 }
 assert.deepEqual(notifications,{active:0,project:0,changed:48})
 assert.equal(m.buildModel(JSON.parse(JSON.stringify(raw)),model),model,'identical JSON reuses entire model')
})

test('nested pane/agent metadata, title, labels, CWD and layout/ordering are compared structurally',()=>{
 const raw=snapshot();raw.agents=[{...raw.panes[0],name:'agent',state_labels:{a:'one'}}]
 const model=m.buildModel(raw)
 for(const modify of [s=>s.panes[0].tokens.preview='other.html',s=>s.panes[0].title='New title',s=>s.panes[0].cwd='/different',s=>s.agents[0].state_labels.a='two',s=>s.agents[0].name='renamed',s=>s.tabs[0].label='Chat',s=>s.workspaces[0].label='Renamed project']){
  const next=structuredClone(raw);modify(next);const changed=m.buildModel(next,model)
  assert.notEqual(changed.byPane.get('p1'),model.byPane.get('p1'));assert.equal(changed.byPane.get('p3'),model.byPane.get('p3'))
 }
 const next=structuredClone(raw);next.panes=next.panes.filter(p=>p.pane_id!=='p2');next.tabs.reverse()
 const changed=m.buildModel(next,model);assert.equal(changed.byPane.has('p2'),false);assert.equal(changed.byPane.get('p1'),model.byPane.get('p1'))
 assert.equal(changed.threads[1],model.byPane.get('p3'),'deleting another tab preserves shifted threads')
 assert.equal(changed.groups[1],model.groups[1],'deleting another tab preserves unrelated groups')
 assert.ok(changed.threads.every(th=>th===changed.byPane.get(th.paneId)))
 next.panes.push({...next.panes[0],pane_id:'p4'});next.layouts=[{tab_id:'t1',panes:[{pane_id:'p4',rect:{x:0,y:0}},{pane_id:'p1',rect:{x:1,y:0}}]}]
 const split=m.buildModel(next,changed);assert.equal(split.byPane.get('p1').paneIndex,1);assert.equal(split.byPane.get('p1').tabPaneCount,2)
})

test('snapshot structural sharing preserves nested fields, handles additions/removals and never mutates inputs',()=>{
 const before=snapshot(),copy=structuredClone(before);assert.equal(m.structuralShare(before,copy),before)
 copy.panes[1].tokens.preview='new.html';const result=m.structuralShare(before,copy)
 assert.equal(result.panes[0],before.panes[0]);assert.equal(result.workspaces,before.workspaces);assert.notEqual(result.panes[1],before.panes[1]);assert.equal(before.panes[1].tokens.preview,'index.html')
 assert.deepEqual(m.structuralShare({a:1,b:2},{a:1}),{a:1});assert.deepEqual(m.structuralShare([1,2],[1]),[1])
})

test('resume coalesces item upserts, appends in transcript order and includes metadata-only revisions',()=>{
 const history=new m.TranscriptRevisions();history.record(update(1,true,['a','b']));history.record(update(3,false,['b','c']));history.record(update(5,false,['b']));history.record(update(6,false,[]))
 const full=update(6,true,['a','b','c']);full.meta={title:'latest'}
 const delta=history.resume(full,{stream:'s',revision:1})
 assert.equal(delta.reset,false);assert.equal(delta.baseRevision,1);assert.deepEqual(delta.items.map(i=>i.id),['b','c']);assert.equal(delta.meta.title,'latest')
 const unchanged=history.resume(full,{stream:'s',revision:6});assert.deepEqual(unchanged.items,[]);assert.equal(unchanged.reset,false)
})

test('unknown, expired, wrong-stream and pre-reset revisions require a full reset; memory is bounded',()=>{
 const history=new m.TranscriptRevisions(2);history.record(update(1,true,['a']));history.record(update(2,false,['b']));history.record(update(3,false,[]));const full=update(3,true,['a','b'])
 for(const cursor of [undefined,{stream:'other',revision:3},{stream:'s',revision:1},{stream:'s',revision:99}])assert.equal(history.resume(full,cursor),full)
 history.record(update(4,true,['new']));const reset=update(4,true,['new']);assert.equal(history.resume(reset,{stream:'s',revision:3}),reset)
 assert.deepEqual(history.resume(reset,{stream:'s',revision:4}).items,[])
})

test('real file tail + manager: switch/resume and a new connection receive only missed items; /clear resets',async t=>{
 const root=mkdtempSync(join(tmpdir(),'drover-resume-'));let manager
 t.after(()=>{manager?.dispose();rmSync(root,{recursive:true,force:true})})
 const project=join(root,'projects','fixture');mkdirSync(project,{recursive:true})
 const line=id=>JSON.stringify({type:'user',uuid:id,message:{role:'user',content:id}})+'\n',file=join(project,'session.jsonl');writeFileSync(file,line('a'))
 const service={env:{CLAUDE_CONFIG_DIR:root},snapshot:{panes:[{pane_id:'p1',agent:'claude',agent_session:{value:'session'}}]}}
 const events=new EventEmitter()
 const waitForUpdate=(predicate,description)=>new Promise((resolve,reject)=>{
  const onUpdate=u=>{if(predicate(u)){clearTimeout(timer);events.off('update',onUpdate);resolve(u)}}
  const timer=setTimeout(()=>{events.off('update',onUpdate);reject(new Error(`Timed out waiting for ${description}`))},10_000)
  events.on('update',onUpdate)
 })
 const publicUpdates=[]
 manager=new m.TranscriptManager(service,u=>publicUpdates.push(u),u=>events.emit('update',u))
 const initial=await manager.subscribe('p1');assert.equal(initial.reset,true);assert.deepEqual(initial.items.map(i=>i.text),['a']);assert.equal(initial.meta.path,file)
 await manager.subscribeOffice('p1')
 manager.unsubscribe('p1');const publicCount=publicUpdates.length;const cursor={stream:initial.stream,revision:initial.revision}
 const appended=waitForUpdate(u=>u.items.some(i=>i.text==='b'),'appended transcript item')
 appendFileSync(file,line('b'))
 await appended
 assert.equal(publicUpdates.length,publicCount,'internal office observation never publishes raw chat while the public subscription is closed')
 const resumed=await manager.subscribe('p1',true,cursor);assert.equal(resumed.reset,false);assert.deepEqual(resumed.items.map(i=>i.text),['b'])
 const handlers=new m.RpcHandlers();handlers.register('transcript:subscribe',(ctx,id,cursor)=>manager.subscribe(id,!ctx.existingSubscription,cursor));handlers.register('transcript:unsubscribe',(_,id)=>manager.unsubscribe(id))
 const connection=new m.RemoteRpcConnection('fresh')
 const rpc=await m.dispatchRemoteRpc(handlers,connection,{t:'call',id:'resume',method:'transcriptSubscribe',args:['p1',cursor]});assert.equal(rpc.ok,true);assert.deepEqual(rpc.value.items.map(i=>i.text),['b'])
 m.releaseRemoteRpc(handlers,connection)
 // Register before truncation: fs.watch or the poll must deliver the internal reset.
 // Awaiting the private read() is not a barrier if another read is in flight.
 const reset=waitForUpdate(u=>u.reset,'truncated transcript reset')
 writeFileSync(file,'')
 const resetUpdate=await reset;assert.deepEqual(resetUpdate.items,[]);assert.equal(resetUpdate.meta.path,file);assert.ok(resetUpdate.revision>initial.revision)
 const cleared=await manager.subscribe('p1',false,cursor);assert.equal(cleared.reset,true);assert.deepEqual(cleared.items,[])
})

test('RPC validates optional resume cursor, rejects injection/future malformed versions and accepts legacy clients',async()=>{
 const handlers=new m.RpcHandlers(),connection=new m.RemoteRpcConnection('validation');let received
 handlers.register('transcript:subscribe',(_,id,cursor)=>{received=cursor;return {id}})
 for(const cursor of [{stream:'s',revision:-1},{stream:'s',revision:NaN},{stream:'s',revision:1.5},{stream:'s',revision:1,extra:1},{stream:'',revision:1}]){
  const result=await m.dispatchRemoteRpc(handlers,connection,{t:'call',id:'bad',method:'transcriptSubscribe',args:['p1',cursor]});assert.equal(result.ok,false)
 }
 for(const args of [['p1'],['p1',null],['p1',{stream:'s',revision:1}]]){
  const result=await m.dispatchRemoteRpc(handlers,connection,{t:'call',id:'ok',method:'transcriptSubscribe',args});assert.equal(result.ok,true)
 }
 assert.deepEqual(received,{stream:'s',revision:1})
})


test('React pane selectors render only the changed row; a closed model consumer wakes with current data', async t => {
  const executable = process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()
  if (!existsSync(executable)) { t.skip('Local Chromium is needed for the render-count regression'); return }
  const root = mkdtempSync(join(tmpdir(), 'drover-selector-render-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  await build({ stdin: { resolveDir: resolve('src/renderer/src'), loader: 'tsx', contents: `
    import {createRoot} from 'react-dom/client'; import {memo,useState} from 'react';
    import {bootstrap,useModel,useThread,useVisibleModel,useStore} from './store'; import {DEFAULT_SETTINGS} from '@shared/types';
    window.fixtureApi={init:async()=>({settings:{...DEFAULT_SETTINGS,syncFocus:false,showLimits:false,language:'en'},connection:{status:'connected',session:'fixture'},snapshot:window.fixtureSnapshot,home:'/fixture',appVersion:'fixture'}),on:new Proxy({},{get:(_,key)=>fn=>{if(key==='snapshot')window.emitSnapshot=fn;return()=>{}}}),setSelectedPane:()=>{},request:async()=>({ok:true,result:{}}),agentKinds:async()=>[],modelCatalog:async()=>null,limits:async()=>({claude:null,codex:null}),previewServers:async()=>[]};
    const count=key=>window.counts[key]=(window.counts[key]||0)+1;
    function Active(){const th=useThread('p1');count('active');return <span>{th?.name}</span>}
    function Closed(){const [visible,setVisible]=useState(false);window.showModel=setVisible;const m=useVisibleModel(visible);count('closed');return <div id="visible">{m.byPane.get('p2')?.status}</div>}
    const Row=memo(function Row({thread}){count('row-'+thread.paneId);return <span>{thread.status}</span>});
    function Rows(){const m=useModel();return <div>{m.threads.map(th=><Row key={th.paneId} thread={th}/>)}</div>}
    window.counts={};window.fixtureStore=useStore;await bootstrap();createRoot(document.getElementById('root')).render(<><Active/><Closed/><Rows/></>);
  ` }, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', outfile: join(root, 'fixture.js'), alias: { '@shared': resolve('src/shared') }, logLevel: 'silent', plugins: [{ name: 'no-real-api', setup(b) {
    b.onResolve({ filter: /^\.\/api$/ }, () => ({ path: 'mock-api', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const api=new Proxy({},{get:(_,key)=>window.fixtureApi[key]});export const call=async()=>({});export const errorText=String;export const humanizeError=String', loader: 'js' }))
  } }] })
  const server = createServer((req, res) => { res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html'); res.end(req.url === '/fixture.js' ? readFileSync(join(root, 'fixture.js')) : '<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>') })
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)))
  const browser = await chromium.launch({ executablePath: executable, headless: true }); t.after(() => browser.close())
  const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message))
  await page.addInitScript(snap => { window.fixtureSnapshot = snap }, snapshot())
  await page.goto('http://127.0.0.1:' + server.address().port); await page.waitForFunction(() => window.counts?.active === 1)
  const counts = await page.evaluate(async () => {
    window.counts = {}; const raw = structuredClone(window.fixtureSnapshot)
    for (let n = 0; n < 48; n++) { raw.panes[1].agent_status = n % 2 ? 'idle' : 'working'; raw.panes[1].revision++; window.emitSnapshot(structuredClone(raw)); await new Promise(r => requestAnimationFrame(r)) }
    return window.counts
  })
  assert.deepEqual(counts, { 'row-p2': 48 })
  await page.evaluate(() => window.showModel(true)); await page.waitForFunction(() => document.getElementById('visible').textContent === 'idle')
  assert.equal(await page.evaluate(() => window.counts.closed), 1)
  await page.evaluate(() => window.emitSnapshot(structuredClone(window.fixtureStore.getState().snapshot)))
  await page.evaluate(() => new Promise(r => requestAnimationFrame(r)))
  assert.deepEqual(await page.evaluate(() => window.counts), { 'row-p2': 48, closed: 1 })
  assert.deepEqual(errors, [])
})
