import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

const temp = mkdtempSync(join(tmpdir(), 'drover-office-test-'))
const out = join(temp, 'office.cjs')
await build({ stdin: { contents: `
 export { OfficeCollector } from './src/main/office/collector'
 export { publicTranscript } from './src/main/office/transport'
 export { resolveOfficeRole } from './src/main/office/collector-role'
 export { validateRpcArgs } from './src/main/remote/validation'
 export { TranscriptManager } from './src/main/transcripts/manager'
 export { FileTailer } from './src/main/transcripts/tail'
 export { ClaudeParser } from './src/main/transcripts/claude'
 export { CodexParser } from './src/main/transcripts/codex'
 export { TaskBoards } from './src/main/tasks'
 export { extractOfficeToolEvidence } from './src/main/office/analyze'
 export { OFFICE_LIMITS } from './src/shared/office'
 export { REMOTE_METHOD_CHANNELS, REMOTE_EVENT_CHANNELS, REMOTE_LOCAL_ONLY_METHODS } from './src/shared/remote'
`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: out,
 alias: { '@shared': resolve('src/shared') }, logLevel: 'silent' })
const m = createRequire(import.meta.url)(out)
const drain = () => new Promise(resolve => setImmediate(resolve))
const receipt = (pane, name) => JSON.stringify({ id: 'cli:agent:prompt', result: { type: 'agent_prompted', agent: { pane_id: pane, name } } })
const stamp = 1800000000000
function setup(t, overrides = {}) {
  let time = stamp
  let session = 'isolated-fixture'
  const panes = [1,2].map(n => ({ pane_id: `w1:p${n}`, workspace_id: 'w1', tab_id: 'w1:t1', terminal_id:`term${n}`,
    agent: n === 1 ? 'claude' : 'codex', agent_session: { value: `synthetic-${n}` }, agent_status: 'working', revision: 1, cwd: '/synthetic-only' }))
  const snapshot = { workspaces: [{ workspace_id: 'w1', label: 'Synthetic', number:1 }], panes,
    agents: panes.map((p,i)=>({...p,name:i?'backend':'lead'})), tabs:[],layouts:[] }
  const retained = new Map(), subscriptions = [], releases = [], boards = [], unboards = [], updates = []
  const source = {session:()=>session,snapshot:()=>snapshot,settings:()=>({roles:[],projectLeads:{}}),
    subscribe:async pane => {
      subscriptions.push(pane); retained.set(pane,(retained.get(pane)||0)+1)
      return {paneId:pane, reset:true, meta:{located:'exact',sessionId:snapshot.panes.find(p=>p.pane_id===pane).agent_session.value},items:[]}
    }, unsubscribe:pane=> { releases.push(pane); retained.set(pane,(retained.get(pane)||0)-1) },
    watchBoard:async cwd=> { boards.push(cwd); return {cwd,exists:true,tasks:[]} },unwatchBoard:cwd=>unboards.push(cwd), ...overrides}
  const office = new m.OfficeCollector(source,u=>updates.push(u),()=>time)
  t.after(()=>office.dispose())
  const send = (...items) => office.onTranscript({paneId:'w1:p1',reset:false,meta:{located:'exact',sessionId:panes[0].agent_session.value},items})
  const tool = (id, { output = receipt('w1:p2','backend'), command = 'herdr agent prompt backend "PRIVATE_SECRET"', ts = time } = {}) => ({
    kind:'tool',id,ts,name:'Bash',category:'command',title:'private',status:output?'done':'running',
    officeEvidence:m.extractOfficeToolEvidence('Bash',{command},output)})
  return {office,source,snapshot,panes,send,tool,updates,subscriptions,releases,boards,unboards,retained,
    advance:n=>time+=n,session:s=>session=s}
}

test('synthetic fixture contains three departments, eight kinds/roles and every status',()=>{
 const fixture = JSON.parse(readFileSync('tests/fixtures/office/state.json','utf8'))
 assert.equal(fixture.departments.length,3)
 assert.equal(new Set(fixture.agents.map(a=>a.kind)).size,8)
 assert.equal(new Set(fixture.agents.map(a=>a.role)).size,8)
 assert.deepEqual([...new Set(fixture.agents.map(a=>a.status))].sort(),['blocked','disconnect','done','idle','unknown','working'])
 assert.ok(fixture.seats.some(s=>s.terminal && s.agentId === null))
})
test('startup, reset and 100 reopenings create no historical effects or extra refs',async t=>{
 const s=setup(t);s.office.init();await drain()
 s.office.onTranscript({paneId:'w1:p1',reset:true,meta:{located:'exact',sessionId:'synthetic-1'},items:[s.tool('history')]})
 for(let i=0;i<100;i++){s.office.stop();s.office.init()}
 s.send(s.tool('history'));s.office.flush()
 assert.equal(s.office.getState().recentEvents.length,0)
 assert.equal(s.updates.flatMap(u=>u.animations).length,0)
 assert.equal(s.subscriptions.length,2);assert.equal(s.boards.length,1)
})
test('two accepted prompts, repeated results and attempt promotion are counted once',async t=>{
 const s=setup(t);s.office.init();await drain()
 s.send(s.tool('first',{output:null}));s.office.flush()
 assert.equal(s.office.getState().recentEvents[0].kind,'prompt_attempt')
 assert.equal(s.updates.flatMap(u=>u.animations).length,0)
 s.send(s.tool('first'),s.tool('second'));s.office.flush()
 for(let i=0;i<100;i++)s.send(s.tool('first'),s.tool('second'))
 s.office.flush()
 const state=s.office.getState()
 assert.deepEqual(state.recentEvents.map(e=>e.kind),['prompt','prompt'])
 assert.equal(state.links.length,1);assert.equal(state.links[0].count,2)
 assert.equal(s.updates.flatMap(u=>u.animations).reduce((n,a)=>n+a.count,0),2)
 assert.ok(!JSON.stringify(s.updates).includes('PRIVATE_SECRET'))
})
test('links retain all observations beyond the 1000 event ring, decay, and publish expiry',async t=>{
 const s=setup(t);s.office.init();await drain()
 for(let i=0;i<1200;i++)s.send(s.tool(`burst-${i}`))
 s.office.flush();assert.equal(s.office.getState().recentEvents.length,1000)
 assert.equal(s.office.getState().links[0].count,1200)
 s.advance(300000);s.office.flush()
 assert.ok(Math.abs(s.office.getState().links[0].weight-1200/Math.E)<1e-8)
 s.advance(30*60000);s.office.flush()
 assert.equal(s.updates.at(-1).state.links.length,0)
 assert.equal(s.office.getState().recentEvents.length,0)
})
test('unknown or heuristic provenance never becomes a lead or confirmed communication',async t=>{
 const s=setup(t);s.office.init();await drain()
 s.office.onTranscript({paneId:'w1:p1',reset:false,meta:{located:'heuristic',sessionId:'synthetic-1'},items:[s.tool('guess')]})
 assert.equal(s.office.getState().recentEvents.length,0)
 s.send({kind:'user',id:'input',text:'SECRET_FROM_OTHER_AGENT',ts:stamp,images:[]})
 const event=s.office.getState().recentEvents[0]
 assert.equal(event.from,null);assert.equal(event.kind,'input_observed');assert.equal(s.office.getState().links.length,0)
})
test('pending results cannot be reassigned to a restarted occupant of the same target pane',async t=>{
 const s=setup(t);s.office.init();await drain()
 const seat=s.office.getState().agents[1].seatId
 s.send(s.tool('pending',{output:null}))
 const previous=s.office.getState().recentEvents[0].to
 s.panes[1].agent_session.value='replacement';s.office.onSnapshot(s.snapshot);await drain()
 s.send(s.tool('pending'));s.office.flush()
 assert.equal(s.office.getState().agents[1].seatId,seat)
 assert.notEqual(s.office.getState().agents[1].id,previous)
 assert.equal(s.office.getState().recentEvents[0].kind,'prompt_attempt')
 assert.equal(s.updates.flatMap(u=>u.animations).length,0)
})
test('shared cwd has one board ref; broken files and assignee changes preserve honest endpoints',async t=>{
 const s=setup(t);s.office.init();await drain()
 assert.equal(s.boards.length,1)
 const board={cwd:'/synthetic-only',exists:true,tasks:[{id:'a',title:'SECRET_TITLE',notes:'SECRET_NOTE',status:'todo',assignee:'backend'}]}
 s.office.onBoard(board);s.office.onBoard({...board,error:'SECRET_PATH'})
 s.office.onBoard({...board,tasks:[{...board.tasks[0],status:'done',assignee:'lead'}]})
 const events=s.office.getState().recentEvents
 assert.deepEqual(events.map(e=>e.kind),['task_created','task_assigned','task_assigned','task_status'])
 assert.ok(events.every(e=>e.from.includes(':department:')))
 assert.ok(!JSON.stringify(s.office.getState()).includes('SECRET'))
 // Only fields actually written by this UI operation have user provenance.
 s.office.onBoard({...board,tasks:[{...board.tasks[0],status:'blocked'}]}, {taskId:'a',status:'blocked'})
 const last=s.office.getState().recentEvents.slice(-2)
 assert.ok(last.find(e=>e.kind==='task_assigned').from.includes(':department:'))
 assert.equal(last.find(e=>e.kind==='task_status').from,'user')
})
test('accepted user sends are distinguished from observed transcript input and stale session callbacks',async t=>{
 const s=setup(t);s.office.init();await drain()
 const agent=s.office.endpoint('w1:p1')
 s.office.userPrompt(agent,'SUPER_SECRET')
 s.send({kind:'user',id:'user-copy',text:'SUPER_SECRET',images:[],ts:stamp})
 assert.deepEqual(s.office.getState().recentEvents.map(e=>e.kind),['user_prompt'])
 s.session('next');s.office.resetSession();s.office.init();await drain()
 s.office.userPrompt(agent,'old-delayed-result')
 assert.equal(s.office.getState().recentEvents.length,0)
 assert.equal(s.office.getState().session,'next')
 assert.ok(s.releases.length>=2 && s.unboards.length>=1)
})
test('hidden collection keeps counts, clears animations, and releases refs after 30 seconds',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval']})
 const s=setup(t);s.office.init();await drain();s.office.stop()
 s.send(s.tool('hidden'));t.mock.timers.tick(29999)
 assert.equal(s.releases.length,0)
 s.office.init();s.office.flush()
 assert.equal(s.updates.flatMap(u=>u.animations).length,0)
 s.office.stop();t.mock.timers.tick(30000)
 assert.equal(s.releases.length,2);assert.equal(s.unboards.length,1)
 s.office.init();await drain();s.send(s.tool('history-return'));s.office.flush()
 assert.equal(s.subscriptions.length,4)
})
test('four concurrent lookups and cancellation of queued panes never release chat refs',async t=>{
 let loads=0,max=0;const resolveLoads=[]
 const s=setup(t,{subscribe:pane=>{loads++;max=Math.max(max,loads);return new Promise(resolve=>resolveLoads.push(()=>{loads--;resolve({paneId:pane,reset:true,meta:null,items:[]})}))}})
 for(let i=3;i<=10;i++)s.snapshot.panes.push({...s.panes[0],pane_id:`w1:p${i}`,agent_session:{value:`session${i}`}})
 s.office.init();assert.equal(max,4)
 s.office.dispose();assert.equal(s.releases.length,4)
 for(const resolve of resolveLoads)resolve();await drain()
 assert.equal(loads,0);assert.equal(max,4)
})
test('history-limit coverage stays frozen even when a chat already tails the large file',async t=>{
 const s=setup(t);s.office.init();await drain()
 s.office.onTranscript({paneId:'w1:p1',reset:true,meta:{located:'exact',sessionId:'synthetic-1'},items:[],error:'office-history-limit'})
 s.send(s.tool('should-not-observe'));s.office.flush()
 assert.equal(s.office.getState().agents[0].transcriptCoverage,'history_limit')
 assert.equal(s.office.getState().recentEvents.length,0)
})
test('animation limits enforce 12 active, 20 queued, a 2 second pair cooldown and expiry',async t=>{
 const s=setup(t);s.office.init();await drain()
 const sender=s.office.endpoint('w1:p1'),target=s.office.endpoint('w1:p2')
 s.office.userPrompt(sender,'a');s.office.flush()
 s.office.userPrompt(sender,'b');s.office.userPrompt(sender,'c');s.office.flush()
 assert.equal(s.updates.flatMap(u=>u.animations).reduce((n,a)=>n+a.count,0),1)
 s.advance(2000);s.office.flush()
 assert.equal(s.updates.flatMap(u=>u.animations).reduce((n,a)=>n+a.count,0),3)
 s.office.userPrompt(target,'d');s.office.stop();s.office.init();s.office.flush()
 assert.equal(s.updates.flatMap(u=>u.animations).reduce((n,a)=>n+a.count,0),3)
})
test('transport strips main-only evidence without changing the parser store',()=>{
 const item={kind:'tool',id:'t',officeEvidence:{version:1,input:{command:'SECRET'},results:[]}}
 const safe=m.publicTranscript({paneId:'p',items:[item],reset:false,meta:null})
 assert.equal(safe.items[0].officeEvidence,undefined);assert.ok(item.officeEvidence)
 const index=readFileSync('src/main/index.ts','utf8')
 assert.ok(!Object.values(m.REMOTE_METHOD_CHANNELS).some(c=>c.startsWith('office:')))
 assert.ok(!m.REMOTE_EVENT_CHANNELS.some(c=>c.startsWith('office:')))
 assert.ok(m.REMOTE_LOCAL_ONLY_METHODS.includes('officeInit') && m.REMOTE_LOCAL_ONLY_METHODS.includes('officeStop'))
 assert.ok(index.includes("win.webContents.send('office:update'"))
 assert.ok(index.includes("ipcMain.handle('office:init'"))
})
test('both real parsers preserve acceptance evidence past display truncation',()=>{
 const claude=new m.ClaudeParser(), codex=new m.CodexParser()
 const input={command:'herdr agent prompt backend "SECRET"'}
 const output='x'.repeat(40000)+'\n'+receipt('w1:p2','backend')
 claude.feed([JSON.stringify({type:'assistant',uuid:'a',timestamp:new Date(stamp).toISOString(),message:{content:[{type:'tool_use',id:'c',name:'Bash',input}]}}),
 JSON.stringify({type:'user',uuid:'r',message:{content:[{type:'tool_result',tool_use_id:'c',content:output}]}})])
 codex.feed([JSON.stringify({type:'response_item',timestamp:new Date(stamp).toISOString(),payload:{type:'function_call',call_id:'x',name:'exec_command',arguments:JSON.stringify({cmd:input.command})}}),
 JSON.stringify({type:'response_item',payload:{type:'function_call_output',call_id:'x',output}})])
 for(const [parser,id] of [[claude,'c'],[codex,'x']]){
   const tool=parser.store.get(id);assert.ok(tool.officeEvidence.results.length===1)
   assert.ok(!tool.output.includes('agent_prompted'))
 }
})
test('the shared FileTailer refuses oversized histories and resets on atomic replacement',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'office-tail-')),path=join(dir,'synthetic.jsonl');t.after(()=>rmSync(dir,{recursive:true,force:true}))
 writeFileSync(path,'1234567890\n');const lines=[],errors=[]
 const limited=new m.FileTailer(path,(l,r)=>lines.push([l,r]),e=>errors.push(e.message),()=>5)
 t.after(()=>limited.stop());await limited.start()
 assert.deepEqual(lines,[]);assert.equal(errors[0],'office-history-limit')
 limited.stop()
 const tailer=new m.FileTailer(path,(l,r)=>lines.push([l,r]));t.after(()=>tailer.stop());await tailer.start()
 assert.equal(lines[0][1],true)
 const {renameSync}=await import('node:fs');writeFileSync(path+'.new','replacement is longer than before\n');renameSync(path+'.new',path)
 await new Promise(resolve=>setTimeout(resolve,1500))
 assert.ok(lines.some(([l,r])=>r && l.includes('replacement is longer than before')))
})

test('wide bursts preserve data while effects cap active/queued counts and expire after five seconds',async t=>{
 const s=setup(t)
 for(let i=3;i<=50;i++)s.snapshot.panes.push({...s.panes[0],pane_id:`w1:p${i}`,agent:'gemini',agent_session:{value:`extra-${i}`}})
 s.office.init();await drain()
 for(const a of s.office.getState().agents)s.office.userPrompt(a.id,'private')
 s.office.flush()
 assert.equal(s.office.getState().recentEvents.length,50)
 assert.equal(s.updates.at(-1).animations.length,12)
 s.advance(2000);s.office.flush()
 assert.equal(s.updates.at(-1).animations.length,8)
 assert.equal(s.updates.flatMap(u=>u.animations).length,20)
 for(const a of s.office.getState().agents)s.office.userPrompt(a.id,'private-2')
 s.advance(5001);s.office.flush()
 assert.equal(s.updates.flatMap(u=>u.animations).length,20)
 assert.equal(s.office.getState().recentEvents.length,100)
})

test('exact incarnation and explicit role follow pane moves, and restarts clear the binding',async t=>{
 const s=setup(t)
 const template={id:'custom:test',name:'frontend',orchestrator:false}
 s.office.bindRole('w1:p1',template) // binding while the office is closed
 s.office.init();await drain()
 let agent=s.office.getState().agents.find(a=>a.paneId==='w1:p1')
 assert.equal(agent.role,'frontend');assert.equal(agent.roleSource,'binding')
 const id=agent.id
 s.snapshot.workspaces.push({workspace_id:'w2',label:'Other',number:2})
 s.panes[0].pane_id='w2:p3';s.panes[0].workspace_id='w2';s.snapshot.agents[0]={...s.panes[0],name:'renamed'}
 s.office.onSnapshot(s.snapshot);await drain()
 agent=s.office.getState().agents.find(a=>a.paneId==='w2:p3')
 assert.equal(agent.id,id);assert.equal(agent.roleSource,'binding');assert.equal(agent.departmentId,'isolated-fixture:department:w2')
 s.panes[0].agent_session.value='new-process';s.office.onSnapshot(s.snapshot);await drain()
 agent=s.office.getState().agents.find(a=>a.paneId==='w2:p3')
 assert.notEqual(agent.id,id);assert.equal(agent.roleSource,'default')
})
test('disconnect freezes statuses and source deltas without replay on reconnect',async t=>{
 const s=setup(t);s.office.init();await drain()
 s.office.onConnection(false);s.office.onSnapshot(s.snapshot)
 assert.ok(s.office.getState().agents.every(a=>a.status==='disconnect'))
 s.send(s.tool('offline'));s.office.flush()
 assert.equal(s.office.getState().recentEvents.length,0)
 s.office.onConnection(true);s.send(s.tool('offline'));s.office.flush()
 assert.ok(s.office.getState().agents.every(a=>a.status==='working'))
 assert.equal(s.office.getState().recentEvents.length,0)
 s.send(s.tool('online'));s.office.flush()
 assert.equal(s.office.getState().recentEvents.length,1)
})

test('role creation accepts a bounded existing template ID and ignores unknown IDs',()=>{
 const template={id:'project:.ai/roles/frontend.md',name:'frontend',label:'Frontend',kind:'claude',args:'',instructions:'private',source:'project'}
 const request={workspaceId:'w1',folder:null,kind:'claude',name:'frontend',placement:'tab',args:[],roleId:template.id}
 assert.doesNotThrow(()=>m.validateRpcArgs('createAgent',[request]))
 assert.equal(m.resolveOfficeRole(request.roleId,[template]),template)
 request.roleId='custom:missing'
 assert.doesNotThrow(()=>m.validateRpcArgs('createAgent',[request]))
 assert.equal(m.resolveOfficeRole(request.roleId,[template]),null)
 assert.equal(m.resolveOfficeRole('starter:orchestrator',[]).orchestrator,true)
})
test('garbage role IDs and path traversal are rejected at the remote boundary and ignored by main',()=>{
 const request={workspaceId:'w1',folder:null,kind:'claude',name:'frontend',placement:'tab',args:[]}
 for(const roleId of ['', 'custom:'+ 'x'.repeat(201), 'project:../secret', 'project:/etc/passwd\0', 'custom:$(echo hi)', 'custom:has space', 42, {id:'custom:x'}]){
   assert.throws(()=>m.validateRpcArgs('createAgent',[{...request,roleId}]))
   assert.equal(m.resolveOfficeRole(roleId,[]),null)
 }
 // A syntactically valid path-like unknown ID is a reference, never opened as a file.
 assert.equal(m.resolveOfficeRole('project:/etc/passwd',[]),null)
})

test('late acceptance removes its attempt even after the public ring has evicted the attempt event',async t=>{
 const s=setup(t);s.office.init();await drain()
 s.send(s.tool('pending-long',{output:null}))
 for(let i=0;i<1000;i++)s.send(s.tool(`other-${i}`))
 assert.ok(!s.office.getState().recentEvents.some(e=>e.kind==='prompt_attempt'))
 s.send(s.tool('pending-long'));s.office.flush()
 assert.equal(s.office.getState().links.some(l=>l.kind==='prompt_attempt'),false)
 assert.equal(s.office.getState().links.find(l=>l.kind==='prompt').count,1001)
})


const until = async (predicate) => {
 const deadline=Date.now()+4000
 while(!predicate() && Date.now()<deadline)await new Promise(r=>setTimeout(r,10))
 assert.ok(predicate(),'asynchronous source reached the expected state')
}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}

test('office-only transcript refs feed the private observer without publishing raw items to renderer',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'office-private-transcript-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
 const cwd=join(dir,'project'),slug=cwd.replace(/[^A-Za-z0-9]/g,'-'),home=join(dir,'claude'),folder=join(home,'projects',slug)
 mkdirSync(folder,{recursive:true});const file=join(folder,'synthetic.jsonl')
 const line=id=>JSON.stringify({type:'assistant',uuid:id,message:{content:[{type:'text',text:'RAW_PRIVATE_TRANSCRIPT'}]}})+'\n'
 writeFileSync(file,line('baseline').replaceAll('\\n','\n'))
 const service={snapshot:{panes:[{pane_id:'pane',agent:'claude',cwd,agent_session:{value:'synthetic'}}]},env:{CLAUDE_CONFIG_DIR:home}}
 const publicUpdates=[],privateUpdates=[]
 const manager=new m.TranscriptManager(service,u=>publicUpdates.push(u),u=>privateUpdates.push(u));t.after(()=>manager.dispose())
 await manager.subscribeOffice('pane')
 assert.equal(publicUpdates.length,0);assert.equal(privateUpdates.length,1)
 appendFileSync(file,line('private-one').replaceAll('\\n','\n'))
 await until(()=>privateUpdates.some(u=>u.items.some(i=>i.id.startsWith('private-one'))))
 assert.equal(publicUpdates.length,0)
 await manager.subscribe('pane')
 appendFileSync(file,line('public-chat').replaceAll('\\n','\n'))
 await until(()=>publicUpdates.some(u=>u.items.some(i=>i.id.startsWith('public-chat'))))
 manager.unsubscribe('pane');const count=publicUpdates.length
 appendFileSync(file,line('private-two').replaceAll('\\n','\n'))
 await until(()=>privateUpdates.some(u=>u.items.some(i=>i.id.startsWith('private-two'))))
 assert.equal(publicUpdates.length,count)
 manager.unsubscribeOffice('pane');assert.equal(manager.subs.size,0)
})
test('office board refs never publish raw cwd/notes, and cancelled watches never restore a timer',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'office-private-board-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
 mkdirSync(join(dir,'.drover'));const file=join(dir,'.drover/tasks.json')
 writeFileSync(file,JSON.stringify({tasks:[{id:'a',title:'PRIVATE_TITLE',notes:'PRIVATE_NOTES',status:'todo'}]}))
 const publicBoards=[],privateBoards=[]
 const boards=new m.TaskBoards(b=>publicBoards.push(b),b=>privateBoards.push(b));t.after(()=>boards.dispose())
 await boards.watchOffice(dir);assert.equal(publicBoards.length,0);assert.equal(privateBoards.length,1)
 await boards.watch(dir);assert.equal(publicBoards.length,1)
 boards.unwatch(dir);writeFileSync(file,JSON.stringify({tasks:[{id:'a',title:'PRIVATE_TITLE',notes:'PRIVATE_NOTES_CHANGED',status:'done'}]}))
 await boards.refresh(dir);assert.equal(publicBoards.length,1);assert.equal(privateBoards.at(-1).tasks[0].status,'done')
 boards.unwatchOffice(dir);assert.equal(boards.timer,null)
 const cancelled=boards.watchOffice(dir);boards.unwatchOffice(dir);await cancelled
 assert.equal(boards.watched.size,0);assert.equal(boards.timer,null)
})
test('stale oversized lookup does not publish an error into the replacement incarnation',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'office-stale-stat-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
 const cwd=join(dir,'project'),folder=join(dir,'claude','projects',cwd.replace(/[^A-Za-z0-9]/g,'-'))
 mkdirSync(folder,{recursive:true});const old=join(folder,'old.jsonl'),fresh=join(folder,'fresh.jsonl')
 writeFileSync(old,'');writeFileSync(fresh,'')
 const fsp=await import('node:fs/promises'),original=fsp.default.stat,pause=deferred(),started=deferred()
 let intercepted=false
 fsp.default.stat=async file=>{
   if(file===old&&!intercepted){intercepted=true;started.resolve();await pause.promise;return {size:m.OFFICE_LIMITS.maxHistoryBytes+1}}
   return original(file)
 }
 t.after(()=>{fsp.default.stat=original})
 const pane={pane_id:'pane',agent:'claude',cwd,agent_session:{value:'old'}}
 const service={snapshot:{panes:[pane]},env:{CLAUDE_CONFIG_DIR:join(dir,'claude')}}
 const observed=[],manager=new m.TranscriptManager(service,()=>{},u=>observed.push(u));t.after(()=>manager.dispose())
 const subscription=manager.subscribeOffice('pane');await started.promise
 pane.agent_session.value='fresh';manager.onSnapshot(service.snapshot);pause.resolve();await subscription
 await until(()=>observed.some(u=>u.meta?.sessionId==='fresh'))
 assert.ok(observed.every(u=>u.error!=='office-history-limit'))
 assert.equal(manager.subs.get('pane').sessionId,'fresh')
})
test('input deduplication consumes one receipt per identical prompt and per incarnation',async t=>{
 const s=setup(t);s.office.init();await drain()
 const a=s.office.endpoint('w1:p1'),b=s.office.endpoint('w1:p2')
 s.office.userPrompt(a,'same');s.office.userPrompt(a,'same');s.office.userPrompt(b,'same')
 s.send({kind:'user',id:'a1',text:'same',images:[],ts:stamp},{kind:'user',id:'a2',text:'same',images:[],ts:stamp})
 s.office.onTranscript({paneId:'w1:p2',reset:false,meta:{located:'exact',sessionId:'synthetic-2'},items:[{kind:'user',id:'b1',text:'same',images:[],ts:stamp}]})
 assert.deepEqual(s.office.getState().recentEvents.map(e=>e.kind),['user_prompt','user_prompt','user_prompt'])
 s.send({kind:'user',id:'a3',text:'same',images:[],ts:stamp})
 assert.equal(s.office.getState().recentEvents.at(-1).kind,'input_observed')
})
test('polling cannot consume a UI write before its attributed refresh',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'office-ui-board-lock-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
 mkdirSync(join(dir,'.drover'));const file=join(dir,'.drover/tasks.json')
 writeFileSync(file,JSON.stringify({tasks:[{id:'a',title:'Task',status:'todo'}]}))
 let boards
 const s=setup(t,{watchBoard:cwd=>boards.watchOffice(cwd),unwatchBoard:cwd=>boards.unwatchOffice(cwd)})
 for(const pane of s.panes)pane.cwd=dir
 boards=new m.TaskBoards(()=>{},(board,write)=>s.office.onBoard(board,write));t.after(()=>boards.dispose())
 s.office.init();await until(()=>s.office.boards.get(dir)?.board?.tasks.length===1)
 const entered=deferred(),finish=deferred()
 const mutation=boards.mutate(dir,async()=>{
   writeFileSync(file,JSON.stringify({tasks:[{id:'a',title:'Task',status:'done'}]}));entered.resolve();await finish.promise
 },()=>({taskId:'a',status:'done'}))
 await entered.promise
 const polling=boards.poll();await drain()
 assert.equal(s.office.getState().recentEvents.length,0)
 finish.resolve();await mutation;await polling
 const events=s.office.getState().recentEvents
 assert.equal(events.length,1);assert.equal(events[0].kind,'task_status');assert.equal(events[0].from,'user')
})
