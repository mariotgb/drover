import { buildTranscriptWorker } from './_transcript-worker.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, rmSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

const temp = mkdtempSync(join(tmpdir(), 'drover-office-test-'))
const out = join(temp, 'office.cjs')
await build({ stdin: { contents: `
 export { OfficeCollector } from './src/main/office/collector'
 export { officeProjects } from './src/main/office/projects'
 export { sendPrompt } from './src/main/actions'
 export { HerdrApiError } from './src/shared/types'
 export { publicTranscript } from './src/main/office/transport'
 export { resolveOfficeRole } from './src/main/office/collector-role'
 export { validateRpcArgs } from './src/main/remote/validation'
 export { TranscriptManager } from './src/main/transcripts/manager'
 export { FileTailer } from './src/main/transcripts/tail'
 export { TranscriptWorkers } from './src/main/transcripts/workerClient'
 export { ClaudeParser } from './src/main/transcripts/claude'
 export { CodexParser } from './src/main/transcripts/codex'
 export { TaskBoards } from './src/main/tasks'
 export { extractOfficeToolEvidence } from './src/main/office/analyze'
 export { OFFICE_LIMITS } from './src/shared/office'
 export { REMOTE_METHOD_CHANNELS, REMOTE_EVENT_CHANNELS, REMOTE_LOCAL_ONLY_METHODS } from './src/shared/remote'
`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: out,
 alias: { '@shared': resolve('src/shared') }, logLevel: 'silent' })
await buildTranscriptWorker(temp)
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
 assert.deepEqual(fixture.departments[0].workspaceIds,['w1','w4'])
 assert.equal(Object.values(fixture.statusCounts).reduce((n,v)=>n+v,0),fixture.agents.length)
 assert.ok(fixture.recentEvents.some(e=>e.summary.endsWith(' · готово')))
 assert.ok(fixture.agents.every(a=>Object.hasOwn(a,'lastTask') && Object.hasOwn(a,'lastEventAt')))
})

test('projects merge all workspaces by sidebar folder, retain IDs/seats and one root board',async t=>{
 const s=setup(t)
 s.snapshot.workspaces.push({workspace_id:'w2',label:'Second workspace',number:2},{workspace_id:'w3',label:'Same label',number:3})
 s.snapshot.panes.push({...s.panes[1],pane_id:'w2:p1',workspace_id:'w2',cwd:'/synthetic-only/./',agent_session:{value:'third'}},
  {...s.panes[1],pane_id:'w3:p1',workspace_id:'w3',cwd:'/different-project',agent_session:{value:'fourth'}})
 s.office.init();await drain()
 let state=s.office.getState()
 assert.equal(state.departments.length,2)
 assert.deepEqual(state.departments[0].workspaceIds,['w1','w2'])
 assert.equal(new Set(state.agents.slice(0,3).map(a=>a.departmentId)).size,1)
 assert.deepEqual(s.boards,['/synthetic-only','/different-project'])
 const id=state.departments[0].id,seat=state.agents.find(a=>a.paneId==='w2:p1').seatId
 s.snapshot.workspaces=s.snapshot.workspaces.filter(w=>w.workspace_id!=='w1')
 s.snapshot.panes=s.snapshot.panes.filter(p=>p.workspace_id!=='w1')
 s.office.onSnapshot(s.snapshot);await drain();state=s.office.getState()
 assert.equal(state.departments[0].id,id)
 assert.equal(state.agents.find(a=>a.paneId==='w2:p1').seatId,seat)
 assert.equal(s.boards.length,2)
 assert.ok(!JSON.stringify(state).includes('/synthetic-only'))
 assert.ok(!JSON.stringify(state).includes('/different-project'))
})

test('project keys follow sidebar tab/layout order, ignore foreground cwd and do not merge unknown roots',()=>{
 const snapshot={workspaces:[{workspace_id:'w1',label:'One',number:1},{workspace_id:'w2',label:'One',number:2},{workspace_id:'w3',label:'One',number:3}],
  panes:[{pane_id:'b',workspace_id:'w1',tab_id:'t2',cwd:'/wrong'},
   {pane_id:'c',workspace_id:'w1',tab_id:'t1',cwd:'/also-wrong'},
   {pane_id:'a',workspace_id:'w1',tab_id:'t1',cwd:'/root/',foreground_cwd:'/root/src'},
   {pane_id:'d',workspace_id:'w2',tab_id:'t3',cwd:'/root',foreground_cwd:'/elsewhere'}],
  tabs:[{tab_id:'t2',workspace_id:'w1',number:2},{tab_id:'t1',workspace_id:'w1',number:1},{tab_id:'t3',workspace_id:'w2',number:1}],
  layouts:[{tab_id:'t1',panes:[{pane_id:'c',rect:{x:20,y:0}},{pane_id:'a',rect:{x:0,y:0}}]}]}
 const projects=m.officeProjects(snapshot,'fixture')
 assert.equal(projects.length,2);assert.equal(projects[0].root,'/root')
 assert.deepEqual(projects[0].department.workspaceIds,['w1','w2'])
 const stable=projects[0].department.id
 snapshot.workspaces[0].workspace_id='renumbered';snapshot.workspaces[0].number=10
 snapshot.panes=snapshot.panes.filter(p=>p.workspace_id!=='w1')
 assert.equal(m.officeProjects(snapshot,'fixture')[0].department.id,stable)
 snapshot.workspaces.push({workspace_id:'w4',label:'One',number:4})
 assert.equal(m.officeProjects(snapshot,'fixture').filter(p=>!p.root).length,3)
 assert.notEqual(m.officeProjects(snapshot,'other-session')[0].department.id,stable)
})

test('HUD journal uses templates, counters span projects and last-event time survives ring expiry',async t=>{
 const s=setup(t);s.office.init();await drain()
 s.snapshot.agents[1].name='designer';s.office.onSnapshot(s.snapshot)
 s.send(s.tool('sent',{command:'herdr agent prompt designer "SECRET_PROMPT"',output:receipt('w1:p2','designer')}))
 s.office.userPrompt(s.office.endpoint('w1:p1'),'SECRET_PROMPT')
 s.panes[1].agent_status='done';s.advance(1200);s.office.onSnapshot(s.snapshot);s.office.flush()
 let state=s.office.getState()
 assert.deepEqual(state.recentEvents.map(e=>e.summary),['lead → designer · задача','Вы → lead · задача','designer · готово'])
 assert.equal(state.recentEvents.at(-1).status,'done')
 assert.deepEqual(state.statusCounts,{working:1,done:1,blocked:0,idle:0,unknown:0,disconnect:0})
 assert.equal(state.agents[0].lastEventAt,stamp);assert.equal(state.agents[1].lastEventAt,stamp+1200)
 s.send(s.tool('attempt',{command:'herdr agent prompt designer "SECRET_COMMAND"',output:null,ts:stamp+1200}))
 assert.equal(s.office.getState().recentEvents.at(-1).summary,'lead → designer · не подтверждено')
 s.advance(m.OFFICE_LIMITS.historyMs+1);state=s.office.getState()
 assert.equal(state.recentEvents.length,0);assert.equal(state.agents[1].lastEventAt,stamp+1200)
 s.office.onConnection(false)
 assert.equal(s.office.getState().statusCounts.disconnect,2)
 assert.ok(!JSON.stringify(s.updates).includes('SECRET'))
})

test('last task is only an assigned board title, including baseline and title-only edits; private data never enters office IPC',async t=>{
 const board={cwd:'/synthetic-only',exists:true,tasks:[
  {id:'old',title:'Old board task',assignee:'lead',status:'done',since:1,notes:'PRIVATE_NOTES'},
  {id:'latest',title:'Build project hall',assignee:'lead',status:'todo',since:2,notes:'PRIVATE_COMMAND /private/project/path'}]}
 const s=setup(t,{watchBoard:async()=>board});s.office.init();await drain()
 assert.equal(s.office.getState().agents[0].lastTask,'Build project hall')
 assert.equal(s.office.getState().agents[1].lastTask,null)
 assert.equal(s.office.getState().recentEvents.length,0)
 s.office.userPrompt(s.office.endpoint('w1:p1'),'PRIVATE_PROMPT /private/project/path')
 s.send(s.tool('private',{command:'herdr agent prompt backend "PRIVATE_COMMAND /private/project/path"'}))
 assert.equal(s.office.getState().agents[0].lastTask,'Build project hall')
 board.tasks[1].title='Refine project hall';s.office.onBoard(board)
 assert.equal(s.office.getState().agents[0].lastTask,'Refine project hall')
 for(const title of ['/private/project/path','Fix /private/project/path','npm run private-command','`cat private-file`']){
  board.tasks[1].title=title;s.office.onBoard(board);s.office.flush()
  assert.equal(s.office.getState().agents[0].lastTask,null)
 }
 board.tasks[1].title='Safe label';board.tasks[1].assignee='backend';s.office.onBoard(board)
 assert.equal(s.office.getState().agents[0].lastTask,'Old board task')
 assert.equal(s.office.getState().agents[1].lastTask,'Safe label')
 s.office.onBoard({...board,tasks:[]});s.office.flush()
 assert.ok(s.office.getState().agents.every(a=>a.lastTask===null))
 const wire=JSON.stringify([s.office.getState(),...s.updates])
 for(const value of ['PRIVATE_PROMPT','PRIVATE_COMMAND','PRIVATE_NOTES','/private/project/path','/synthetic-only','herdr agent prompt','officeEvidence','sourceRef','observedAt','confidence']) assert.ok(!wire.includes(value),value)
})

test('board assignees resolve inside their project; another project with the same name cannot steal a task',async t=>{
 const s=setup(t)
 s.snapshot.workspaces.push({workspace_id:'w2',label:'Other',number:2})
 s.snapshot.panes.push({...s.panes[1],pane_id:'w2:p1',workspace_id:'w2',cwd:'/other-root',agent_session:{value:'other'}})
 s.snapshot.agents.push({...s.snapshot.panes.at(-1),name:'backend'})
 s.office.init();await drain()
 s.office.onBoard({cwd:'/synthetic-only',exists:true,tasks:[{id:'task',title:'Project task',assignee:'backend',status:'todo'}]})
 const state=s.office.getState(),target=state.agents.find(a=>a.paneId==='w1:p2')
 assert.equal(state.recentEvents.find(e=>e.kind==='task_assigned').to,target.id)
 assert.equal(target.lastTask,'Project task');assert.equal(state.agents.find(a=>a.paneId==='w2:p1').lastTask,null)
 assert.equal(state.statusCounts.working,3)
})

test('only accepted Drover agent.prompt sends create user journal events; failure, empty input, shell and fallback do not',async t=>{
 const s=setup(t);s.office.init();await drain()
 const req={paneId:'w1:p1',target:'w1:p1',agentKind:'claude',text:'PRIVATE_PROMPT',imagePaths:[],isShell:false}
 const callback=()=>s.office.userPrompt(s.office.endpoint(req.paneId),req.text)
 await m.sendPrompt({request:async()=>({})},req,{onAccepted:callback})
 for(const code of ['agent_blocked','agent_not_found','error']) await m.sendPrompt({request:async(method)=>{
  if(method==='agent.prompt')throw new m.HerdrApiError(code,'PRIVATE_ERROR')
  return {}
 }},req,{onAccepted:callback})
 await m.sendPrompt({request:async()=>({})},{...req,isShell:true},{onAccepted:callback})
 await m.sendPrompt({request:async()=>({})},{...req,text:''},{onAccepted:callback})
 s.office.flush()
 assert.deepEqual(s.office.getState().recentEvents.map(e=>e.summary),['Вы → lead · задача'])
 assert.ok(!JSON.stringify(s.updates).includes('PRIVATE'))
})

test('boss uses the office marker and genuine prompt receipt; quick broadcast remains user-to-lead without text',async t=>{
 const s=setup(t,{isBoss:paneId=>paneId==='w1:p1'})
 s.snapshot.agents[0].name='drover-boss'
 s.office.init();await drain()
 const boss=s.office.getState().agents.find(a=>a.paneId==='w1:p1')
 const lead=s.office.getState().agents.find(a=>a.paneId==='w1:p2')
 assert.equal(boss.isBoss,true);assert.equal(lead.isBoss,undefined)
 s.send(s.tool('boss-assignment'))
 s.office.userPrompt(s.office.endpoint('w1:p2'),'PRIVATE_BROADCAST')
 s.office.flush()
 const events=s.office.getState().recentEvents
 assert.ok(events.some(e=>e.kind==='prompt' && e.from===boss.id && e.to===lead.id))
 assert.ok(events.some(e=>e.kind==='user_prompt' && e.from==='user' && e.to===lead.id))
 assert.ok(!JSON.stringify(s.updates).includes('PRIVATE'))
})

test('unsafe pane/workspace labels cannot smuggle commands or paths into names and journal summaries',async t=>{
 const s=setup(t)
 s.snapshot.agents=[];s.panes[0].label='npm run PRIVATE_COMMAND';s.panes[1].label='/private/agent/path'
 s.snapshot.workspaces.push({workspace_id:'empty',label:'/private/project/path',number:3})
 s.office.init();await drain();s.office.userPrompt(s.office.endpoint('w1:p1'),'PRIVATE_PROMPT');s.office.flush()
 const state=s.office.getState()
 assert.deepEqual(state.agents.map(a=>a.name),['claude','codex'])
 assert.equal(state.departments.at(-1).name,'Проект')
 assert.equal(state.recentEvents[0].summary,'Вы → claude · задача')
 for(const text of ['PRIVATE','/private','npm run'])assert.ok(!JSON.stringify(s.updates).includes(text))
})

test('raw provider session metadata stays main-only while exact transcript provenance still works',async t=>{
 const s=setup(t);s.panes[0].agent_session.value='/private/provider/session-path'
 s.office.init();await drain();s.send(s.tool('exact'));s.office.flush()
 const state=s.office.getState()
 assert.equal(state.recentEvents[0].kind,'prompt')
 assert.match(state.agents[0].incarnation,/^[a-f0-9]{64}$/)
 assert.ok(!JSON.stringify([state,...s.updates]).includes('/private/provider/session-path'))
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
 assert.equal(s.updates.at(-1).delta.removedLinks.length,1)
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
 const board={cwd:'/synthetic-only',exists:true,tasks:[{id:'a',title:'Improve layout',notes:'SECRET_NOTE',status:'todo',assignee:'backend'}]}
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
test('two concurrent lookups and cancellation of queued panes never release chat refs',async t=>{
 let loads=0,max=0;const resolveLoads=[]
 const s=setup(t,{subscribe:pane=>{loads++;max=Math.max(max,loads);return new Promise(resolve=>resolveLoads.push(()=>{loads--;resolve({paneId:pane,reset:true,meta:null,items:[]})}))}})
 for(let i=3;i<=10;i++)s.snapshot.panes.push({...s.panes[0],pane_id:`w1:p${i}`,agent_session:{value:`session${i}`}})
 s.office.init();assert.equal(max,m.OFFICE_LIMITS.lookupConcurrency)
 s.office.dispose();assert.equal(s.releases.length,m.OFFICE_LIMITS.lookupConcurrency)
 for(const resolve of resolveLoads)resolve();await drain()
 assert.equal(loads,0);assert.equal(max,m.OFFICE_LIMITS.lookupConcurrency)
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
 const department=agent.departmentId
 s.snapshot.workspaces.push({workspace_id:'w2',label:'Other',number:2})
 s.panes[0].pane_id='w2:p3';s.panes[0].workspace_id='w2';s.snapshot.agents[0]={...s.panes[0],name:'renamed'}
 s.office.onSnapshot(s.snapshot);await drain()
 agent=s.office.getState().agents.find(a=>a.paneId==='w2:p3')
 assert.equal(agent.id,id);assert.equal(agent.roleSource,'binding');assert.equal(agent.departmentId,department)
 assert.deepEqual(s.office.getState().departments[0].workspaceIds,['w1','w2'])
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
 const line=id=>JSON.stringify({type:'user',uuid:id,message:{role:'user',content:'RAW_PRIVATE_TRANSCRIPT'}})+'\n'
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
 const pane={pane_id:'pane',agent:'claude',cwd,agent_session:{value:'old'}}
 const service={snapshot:{panes:[pane]},env:{CLAUDE_CONFIG_DIR:join(dir,'claude')}}
 const observed=[],manager=new m.TranscriptManager(service,()=>{},u=>observed.push(u));t.after(()=>manager.dispose())
 const subscription=manager.subscribeOffice('pane')
 pane.agent_session.value='fresh';manager.onSnapshot(service.snapshot);await subscription
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

test('credential and command shaped assigned titles never enter office snapshots or updates', async t => {
 const board={cwd:'/synthetic-only',exists:true,tasks:[{id:'private-title',title:'Document API key rotation',assignee:'lead',status:'todo',since:1}]}
 const s=setup(t,{watchBoard:async()=>board});s.office.init();await drain()
 assert.equal(s.office.getState().agents[0].lastTask,'Document API key rotation')
 const unsafe=['API_KEY=fixture-secret-value','SERVICE_AUTH_TOKEN = fixture-secret-value','SECRET=fixture-secret-value','PASSWORD=fixture-secret-value','Bearer fixture-secret-value',`Rotate ${'a1'.repeat(32)}`,`Inspect ${Buffer.from('fixture-secret-value:'.repeat(6)).toString('base64')}`,'make deploy',`${'Safe text '.repeat(20)} TOKEN=fixture-secret-value`]
 for(const title of unsafe){board.tasks[0].title=title;s.office.onBoard(board);s.office.flush();assert.equal(s.office.getState().agents[0].lastTask,null,title)}
 for(const title of ['Review token validation','Document password policy','Update the authentication secret rotation guide']){board.tasks[0].title=title;s.office.onBoard(board);assert.equal(s.office.getState().agents[0].lastTask,title)}
 const wire=JSON.stringify([s.office.getState(),...s.updates])
 for(const title of unsafe)assert.ok(!wire.includes(title),title)
 assert.ok(!wire.includes('fixture-secret-value'))
})

process.on('exit',()=>rmSync(temp,{recursive:true,force:true}))

test('routine office updates are ordered deltas; quiet links send no state or decay traffic', async t => {
 const s=setup(t);const initial=s.office.init();await drain()
 s.send(s.tool('link'));s.office.flush()
 const first=s.updates.at(-1)
 assert.equal(first.state,undefined);assert.equal(first.delta.baseVersion,initial.version)
 assert.equal(first.delta.version,initial.version+1)
 assert.equal(first.delta.events.length,1);assert.equal(first.delta.links.length,1)
 const n=s.updates.length
 for(let i=0;i<100;i++){s.advance(100);s.office.flush()}
 assert.equal(s.updates.length,n,'client computes fading from timestamps')
 s.office.userPrompt(s.office.endpoint('w1:p2'),'PRIVATE_NEW_INPUT');s.office.flush()
 const second=s.updates.at(-1).delta
 assert.equal(second.baseVersion,first.delta.version);assert.equal(second.events.length,1)
 assert.ok(second.agents.length<initial.agents.length)
 assert.equal(second.departments,undefined);assert.equal(second.seats,undefined)
 assert.ok(!JSON.stringify(second).includes('PRIVATE_NEW_INPUT'))
})

test('office tails large histories without chat diffs/images; actual workers retain complete chat independently', async t => {
 const dir=mkdtempSync(join(tmpdir(),'office-bounded-worker-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
 const folder=join(dir,'projects','fixture');mkdirSync(folder,{recursive:true})
 const file=join(folder,'session.jsonl'),user=(id,text)=>JSON.stringify({type:'user',uuid:id,message:{role:'user',content:text}})+'\n'
 const large=JSON.stringify({type:'assistant',uuid:'large',message:{content:[{type:'text',text:'x'.repeat(350000)}]}})+'\n'
 writeFileSync(file,user('old','OLD_USER')+large+user('baseline','RECENT_USER'))
 const service={env:{CLAUDE_CONFIG_DIR:dir},snapshot:{panes:[{pane_id:'p',agent:'claude',agent_session:{value:'session'}}]}}
 const publicUpdates=[],observed=[],manager=new m.TranscriptManager(service,u=>publicUpdates.push(u),u=>observed.push(u));t.after(()=>manager.dispose())
 const tail=await manager.subscribeOffice('p')
 assert.equal(tail.meta.coverage,'tail');assert.deepEqual(tail.items.map(i=>i.id),['baseline'])
 assert.equal(publicUpdates.length,0)
 const full=await manager.subscribe('p')
 assert.deepEqual(full.items.map(i=>i.kind),['user','assistant','user'])
 assert.equal(full.items[1].text.length,350000)
 const call=JSON.stringify({type:'assistant',uuid:'call',message:{content:[{type:'tool_use',id:'receipt',name:'Bash',input:{command:'herdr agent prompt w1:p2 "PRIVATE_COMMAND"'}}]}})
 const result=JSON.stringify({type:'user',uuid:'result',message:{content:[{type:'tool_result',tool_use_id:'receipt',content:receipt('w1:p2','backend')}]}})
 appendFileSync(file,call+'\n'+result+'\n')
 await until(()=>observed.some(u=>u.items.some(i=>i.kind==='tool'&&i.officeEvidence?.results.length===1)))
 const evidence=observed.flatMap(u=>u.items).findLast(i=>i.kind==='tool')
 assert.equal(evidence.output,undefined);assert.equal(evidence.diff,undefined)
 assert.equal(manager.workers.workers.size,2)
})

test('first successful office read after missing file still reads only a bounded tail', async t => {
 const dir=mkdtempSync(join(tmpdir(),'office-late-file-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
 const file=join(dir,'late.jsonl'),lines=[],errors=[]
 const tailer=new m.FileTailer(file,batch=>lines.push(...batch),e=>errors.push(e.code),()=>Infinity,{initialBytes:256*1024,maxLineBytes:128*1024})
 t.after(()=>tailer.stop());await tailer.start()
 writeFileSync(file,'{"n":1}\n'.repeat(100000));await tailer.sync()
 assert.deepEqual(errors,['ENOENT']);assert.ok(lines.length>0&&lines.length<33000)
})

test('worker error and unexpected exit reject pending sync and resolve initial waiters', async t => {
 const dir=mkdtempSync(join(tmpdir(),'office-worker-failure-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
 for(const crash of ['throw new Error("simulated failure")','process.exit(0)']) {
  const path=join(dir,'crash.cjs');writeFileSync(path,`const {parentPort}=require('node:worker_threads');parentPort.on('message',m=>{if(m.type==='open')parentPort.postMessage({type:'ready',id:m.id});if(m.type==='sync'){${crash}}})`)
  const errors=[],pool=new m.TranscriptWorkers(path);t.after(()=>pool.dispose())
  const stream=pool.open('unused','claude',false,()=>{},(error,fatal)=>errors.push({error,fatal}))
  await stream.loaded;await assert.rejects(stream.sync(),/failure|exited/)
  assert.equal(pool.syncing.size,0);assert.equal(pool.subscriptions.size,0);assert.equal(pool.workers.size,0)
  assert.equal(errors[0].fatal,true)
 }
})

test('manager invalidates a dead worker stream and the next subscription opens a new worker', async t => {
 const dir=mkdtempSync(join(tmpdir(),'office-worker-recover-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
 const folder=join(dir,'projects','fixture');mkdirSync(folder,{recursive:true});const file=join(folder,'session.jsonl')
 writeFileSync(file,JSON.stringify({type:'user',uuid:'a',message:{role:'user',content:'first'}})+'\n')
 const service={env:{CLAUDE_CONFIG_DIR:dir},snapshot:{panes:[{pane_id:'p',agent:'claude',agent_session:{value:'session'}}]}}
 const manager=new m.TranscriptManager(service,()=>{});t.after(()=>manager.dispose())
 await manager.subscribe('p');const before=manager.workers.workers.get(false)
 await before.terminate();await until(()=>manager.subs.get('p').tailer===null)
 const resumed=await manager.subscribe('p')
 assert.equal(resumed.error,undefined);assert.deepEqual(resumed.items.map(i=>i.id),['a'])
 assert.notEqual(manager.workers.workers.get(false),before)
})

test('office refs keep only the tail after the independent 90 second chat warm period', async t => {
 const dir=mkdtempSync(join(tmpdir(),'office-chat-warm-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
 const folder=join(dir,'projects','fixture');mkdirSync(folder,{recursive:true});const file=join(folder,'session.jsonl')
 const user=id=>JSON.stringify({type:'user',uuid:id,message:{role:'user',content:id}})+'\n';writeFileSync(file,user('a'))
 const service={env:{CLAUDE_CONFIG_DIR:dir},snapshot:{panes:[{pane_id:'p',agent:'claude',agent_session:{value:'session'}}]}}
 const office=[],manager=new m.TranscriptManager(service,()=>{},u=>office.push(u));t.after(()=>manager.dispose())
 await manager.subscribeOffice('p');await manager.subscribe('p')
 t.mock.timers.enable({apis:['setTimeout']});manager.unsubscribe('p')
 const sub=manager.subs.get('p');assert.ok(sub.teardown);assert.ok(sub.tailer)
 t.mock.timers.tick(89999);assert.ok(sub.tailer)
 t.mock.timers.tick(1);assert.equal(sub.tailer,null);assert.equal(sub.parser,null);assert.ok(sub.officeTailer)
 t.mock.timers.reset();appendFileSync(file,user('b'))
 await until(()=>office.some(u=>u.items.some(i=>i.id==='b')))
 assert.equal(manager.subs.size,1);assert.equal(sub.officeRefs,1)
 const reload=await manager.subscribe('p');assert.deepEqual(reload.items.map(i=>i.id),['a','b'])
})

test('every chunk of an atomic office history replacement is baseline, not a fresh event', async t => {
 const dir=mkdtempSync(join(tmpdir(),'office-replacement-baseline-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
 const folder=join(dir,'projects','fixture');mkdirSync(folder,{recursive:true});const file=join(folder,'session.jsonl')
 const user=(id,text)=>JSON.stringify({type:'user',uuid:id,message:{role:'user',content:text}})+'\n';writeFileSync(file,user('old','baseline'))
 const service={env:{CLAUDE_CONFIG_DIR:dir},snapshot:{panes:[{pane_id:'p',agent:'claude',agent_session:{value:'session'}}]}}
 const observed=[],manager=new m.TranscriptManager(service,()=>{},u=>observed.push(u));t.after(()=>manager.dispose())
 await manager.subscribeOffice('p');observed.length=0
 writeFileSync(file+'.new',Array.from({length:8},(_,i)=>user('history-'+i,'x'.repeat(32000))).join(''))
 renameSync(file+'.new',file);await manager.subs.get('p').officeTailer.sync()
 assert.ok(observed.length>=3);assert.ok(observed.every(u=>u.reset))
 appendFileSync(file,user('fresh','new live input'));await manager.subs.get('p').officeTailer.sync()
 assert.equal(observed.at(-1).reset,false)
})
