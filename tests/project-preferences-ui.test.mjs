import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { chromium } from 'playwright-core'

test('desktop drag, phone arrows, importance sync and explicit Codex repair work through real React controls', async t => {
  const executablePath = process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()
  if (!existsSync(executablePath)) { t.skip('Local Chromium is required for the UI regression'); return }
  const root = mkdtempSync(join(tmpdir(), 'drover-project-ui-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  await build({ stdin: { resolveDir: resolve('src/renderer/src'), loader: 'tsx', contents: `
    import {createRoot} from 'react-dom/client';
    import {useStore,getModel} from './store';import {DEFAULT_SETTINGS} from '@shared/types';
    import {Sidebar} from './components/Sidebar';import {MobileWebApp} from './components/MobileWeb';
    import {CommandPalette} from './components/CommandPalette';import {MenuHost} from './components/Menu';
    import './styles/tokens.css';import './styles/app.css';import './styles/dialogs.css';import './styles/mobile.css';import './styles/chat.css';import './styles/remote.css';import './styles/mobile-design.css';
    window.writes=[];window.installCalls=0;window.statusCalls=0;window.planCalls=0;window.restartCalls=[];window.bossFlow=[];window.bossOpenCalls=[];
    const warning={status:'warning',installed:true,outdated:true,reportErrors:0,integrationVersion:7,herdrVersion:'fixture',message:'fixture outdated hook'};
    window.fixtureApi={setSettings:async patch=>{window.writes.push(patch);if(patch.session){window.bossFlow.push('settings:'+patch.session);setTimeout(()=>useStore.setState({connection:{status:'connected',session:patch.session},snapshot:window.ownerSnapshot}),20)}return {...useStore.getState().settings,...patch}},
      init:async()=>{const state=useStore.getState();window.bossFlow.push('init:'+state.connection.session);return {settings:state.settings,connection:state.connection,snapshot:state.snapshot,platform:'darwin',home:'/fixture',appVersion:'fixture'}},
      bossSettings:async()=>({hqFolder:'/hq',excludedProjects:[]}),
      bossRoster:async()=>{const session=useStore.getState().connection.session;window.bossFlow.push('roster:'+session);return {session:'owner',needsSessionSwitch:session!=='owner',hqFolder:'/hq',projects:[],boss:{paneId:'owner:p1',kind:'codex',name:'drover-boss',status:'idle'}}},
      openBoss:async req=>{window.bossOpenCalls.push(req);window.bossFlow.push('open:'+useStore.getState().connection.session);return {ok:true,paneId:'owner:p1',existing:true,folder:'/hq'}},
      codexIntegrationStatus:async()=>{window.statusCalls++;return warning},
      codexIntegrationInstall:async()=>{window.installCalls++;return {code:0,stdout:'fixture hook installed',stderr:'',status:{...warning,status:'ok',outdated:false}}},
      codexDaemonRestartPlan:async()=>{window.planCalls++;const plan={token:'fixture-plan-'+window.planCalls,expiresAt:Date.now()+(window.expiredPlan?-1:60000),agents:[{session:'other-session',paneId:'w9:p1',name:'possibly-affected-agent',status:'working',hasSession:false}],busy:true,daemonRunning:true,canRestart:true,otherClientsMayBeAffected:true};return window.deferPlan?new Promise(resolve=>{window.resolveDeferredPlan=()=>resolve(plan)}):plan},
      codexDaemonRestart:async token=>{window.restartCalls.push(token);return {code:0,stdout:'fixture daemon restarted',stderr:'',status:warning}},
      request:async()=>({ok:true,result:{}}),setSelectedPane:()=>{},termOpen:async()=>({ok:true}),termClose:()=>{},termResize:()=>{},limits:async()=>({claude:null,codex:null}),refreshLimits:async()=>({claude:null,codex:null}),watchTasks:async()=>null,unwatchTasks:()=>{},
      previewServers:async()=>[],on:new Proxy({},{get:()=>()=>()=>{}})};
    const workspaces=['Alpha','Beta','Gamma'].map((label,i)=>({workspace_id:'w'+i,number:i+1,label}));
    const snapshot={workspaces,tabs:workspaces.map((w,i)=>({workspace_id:w.workspace_id,tab_id:'t'+i,number:1})),panes:workspaces.map((w,i)=>({pane_id:'p'+i,workspace_id:w.workspace_id,tab_id:'t'+i,agent:null,agent_status:'idle',cwd:'/project/'+w.label,revision:1})),agents:[],layouts:[]};
    window.ownerSnapshot={workspaces:[{workspace_id:'owner',number:1,label:'HQ'}],tabs:[{workspace_id:'owner',tab_id:'owner:t1',number:1}],panes:[{pane_id:'owner:p1',workspace_id:'owner',tab_id:'owner:t1',agent:'codex',agent_status:'idle',cwd:'/hq',revision:1}],agents:[],layouts:[]};
    useStore.setState({ready:true,platform:window.fixturePlatform??'darwin',settings:{...DEFAULT_SETTINGS,session:'fixture',language:'en',showLimits:false},connection:{status:'connected',session:'fixture'},snapshot,mobileDrawer:true});
    window.fixtureStore=useStore;window.modelFolders=()=>getModel().groups.map(g=>g.cwd);
    window.addDuplicateProject=()=>useStore.setState(s=>({settings:{...s.settings,projectOrder:[],projectImportance:{}},snapshot:{...s.snapshot,
      workspaces:[...s.snapshot.workspaces,{workspace_id:'w3',number:1.5,label:'Alpha'}],
      tabs:[...s.snapshot.tabs,{workspace_id:'w3',tab_id:'t3',number:1}],
      panes:[...s.snapshot.panes,{pane_id:'p3',workspace_id:'w3',tab_id:'t3',agent:null,agent_status:'idle',cwd:'/project/Alpha',revision:1}]}}));
    const Root=()=>{const palette=useStore(s=>s.paletteOpen);return <div className={window.fixtureRemote?'remote-shell':'fixture-shell'} style={{height:'100%'}}><div className="app">{window.fixtureRemote?<MobileWebApp offline={null}/>:<Sidebar/>}{palette&&<CommandPalette/>}<MenuHost/></div></div>};
    createRoot(document.getElementById('root')).render(<Root/>);
  ` }, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', outfile: join(root, 'fixture.js'), alias: { '@shared': resolve('src/shared') }, loader: { '.png': 'dataurl', '.md': 'text' }, logLevel: 'silent', plugins: [{ name: 'isolated-ui-api', setup(b) {
    b.onResolve({ filter: /(?:^|\/)api$/ }, () => ({ path: 'api', namespace: 'fixture' }))
    b.onResolve({ filter: /(?:^|\/)remote-api$/ }, () => ({ path: 'remote-api', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'remote-api'
      ? `export const useRemoteConnection=()=> 'connected';export const remoteSendPrompt=async()=>({ok:true});`
      : `export const api=new Proxy({},{get:(_,key)=>window.fixtureApi[key]});export const isRemote=!!window.fixtureRemote;export const call=async()=>({});export const errorText=String;export const humanizeError=String;`, loader: 'js' }))
  } }] })
  const server = createServer((req, res) => {
    const file = req.url === '/fixture.js' ? 'fixture.js' : req.url === '/fixture.css' ? 'fixture.css' : null
    res.setHeader('Content-Type', file?.endsWith('.js') ? 'text/javascript' : file ? 'text/css' : 'text/html')
    res.end(file ? readFileSync(join(root, file)) : '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)))
  const browser = await chromium.launch({ executablePath, headless: true }); t.after(() => browser.close())
  const url = 'http://127.0.0.1:' + server.address().port
  const desktop = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  const errors = []; desktop.on('pageerror', e => errors.push(e.message))
  await desktop.goto(url)
  const sections = desktop.locator('.ws')
  await sections.first().waitFor()
  const names = page => page.locator('.ws .ws-label').allTextContents()
  assert.deepEqual(await names(desktop), ['Alpha', 'Beta', 'Gamma'])
  const source = desktop.locator('.ws-head').filter({ hasText: 'Gamma' })
  const target = desktop.locator('.ws-head').filter({ hasText: 'Alpha' })
  const sourceRect = await source.boundingBox(), targetRect = await target.boundingBox()
  await desktop.mouse.move(sourceRect.x + 60, sourceRect.y + 15)
  await desktop.mouse.down(); await desktop.mouse.move(targetRect.x + 60, targetRect.y + 3, { steps: 10 })
  await desktop.mouse.move(targetRect.x + 60, targetRect.y + 3)
  await desktop.mouse.up()
  await desktop.waitForFunction(() => window.modelFolders()[0] === '/project/Gamma')
  assert.deepEqual(await names(desktop), ['Gamma', 'Alpha', 'Beta'])
  assert.deepEqual(await desktop.evaluate(() => window.writes[0].projectOrder), ['/project/Gamma', '/project/Alpha', '/project/Beta'])
  await desktop.evaluate(() => window.addDuplicateProject())
  await desktop.waitForFunction(() => document.querySelectorAll('.ws').length === 4)
  assert.deepEqual(await names(desktop), ['Alpha', 'Alpha', 'Beta', 'Gamma'])
  const duplicateSource = await desktop.locator('.ws-head').filter({ hasText: 'Alpha' }).first().boundingBox()
  const duplicateTarget = await desktop.locator('.ws-head').filter({ hasText: 'Gamma' }).boundingBox()
  await desktop.mouse.move(duplicateSource.x + 60, duplicateSource.y + 15)
  await desktop.mouse.down(); await desktop.mouse.move(duplicateTarget.x + 60, duplicateTarget.y + 3, { steps: 10 })
  await desktop.mouse.move(duplicateTarget.x + 60, duplicateTarget.y + 3); await desktop.mouse.up()
  await desktop.waitForFunction(() => window.modelFolders()[0] === '/project/Beta')
  assert.deepEqual(await names(desktop), ['Beta', 'Alpha', 'Alpha', 'Gamma'], 'desktop drag moves all workspaces of the folder together')
  assert.deepEqual(await desktop.evaluate(() => window.fixtureStore.getState().settings.projectOrder), ['/project/Beta', '/project/Alpha', '/project/Gamma'])
  // Incoming phone preferences change the same model without a new snapshot.
  await desktop.evaluate(() => window.fixtureStore.setState(s => ({ settings: { ...s.settings, projectOrder: [], projectImportance: { '/project/Beta': 'primary', '/project/Alpha': 'background' } }, paletteOpen: true })))
  await desktop.waitForFunction(() => window.modelFolders()[0] === '/project/Beta')
  assert.deepEqual(await names(desktop), ['Beta', 'Gamma', 'Alpha', 'Alpha'])
  assert.equal(await desktop.locator('.ws[data-importance="primary"] .project-importance-marker').getAttribute('title'), 'Primary project')
  assert.ok((await desktop.locator('.palette-sub').first().textContent()).startsWith('Beta'))
  await desktop.keyboard.press('Escape')
  assert.equal(await desktop.evaluate(() => window.installCalls), 0, 'mount and status reads never install')
  assert.deepEqual(await desktop.evaluate(() => window.restartCalls), [], 'mount never restarts the shared daemon')
  await desktop.getByRole('button', { name: 'Restart Codex service', exact: true }).click()
  const planDialog = desktop.getByRole('dialog', { name: 'Restart Codex service' })
  await planDialog.getByText('possibly-affected-agent', { exact: true }).waitFor()
  await planDialog.getByText('Codex clients in other terminals or IDEs may also be affected.', { exact: true }).waitFor()
  await desktop.evaluate(() => { window.deferPlan = true })
  await planDialog.getByRole('button', { name: 'Refresh agent list', exact: true }).click()
  await desktop.waitForFunction(() => typeof window.resolveDeferredPlan === 'function')
  await planDialog.getByRole('button', { name: 'Wait for agents', exact: true }).click()
  assert.deepEqual(await desktop.evaluate(() => window.restartCalls), [], 'viewing/cancelling the plan never executes it')
  await desktop.evaluate(async () => { window.deferPlan = false; window.resolveDeferredPlan(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))) })
  assert.equal(await planDialog.count(), 0, 'a cancelled refresh response must not reopen the confirmation dialog')
  await desktop.evaluate(() => { window.expiredPlan = true })
  await desktop.getByRole('button', { name: 'Restart Codex service', exact: true }).click()
  await planDialog.getByText('The agent list changed or expired. Refresh it before restarting.', { exact: true }).waitFor()
  assert.ok(await planDialog.getByRole('button', { name: 'Restart anyway', exact: true }).isDisabled())
  assert.deepEqual(await desktop.evaluate(() => window.restartCalls), [], 'an expired plan cannot execute')
  await desktop.evaluate(() => { window.expiredPlan = false })
  await planDialog.getByRole('button', { name: 'Refresh agent list', exact: true }).click()
  await planDialog.getByRole('button', { name: 'Restart anyway', exact: true }).click()
  await desktop.getByText('Codex service restarted, but the warning remains.', { exact: true }).waitFor()
  assert.deepEqual(await desktop.evaluate(() => window.restartCalls), ['fixture-plan-4'])
  await desktop.screenshot({ path: '/tmp/drover-docs-desktop.png' })
  await desktop.getByRole('button', { name: 'Reinstall Codex integration', exact: true }).click()
  await desktop.getByText('Codex integration reinstalled', { exact: true }).waitFor()
  assert.equal(await desktop.evaluate(() => window.installCalls), 1)
  await desktop.evaluate(() => window.fixtureStore.setState({ dialog: { type: 'boss' } }))
  await desktop.getByText('The Main boss already exists in herdr session owner.', { exact: true }).waitFor()
  assert.equal(await desktop.evaluate(() => window.writes.filter(p => p.session).length), 0)
  assert.equal(await desktop.evaluate(() => window.bossOpenCalls.length), 0, 'foreign boss never triggers creation')
  await desktop.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal(await desktop.evaluate(() => window.fixtureStore.getState().connection.session), 'fixture')
  await desktop.evaluate(() => window.fixtureStore.setState({ dialog: { type: 'boss' } }))
  await desktop.getByRole('button', { name: 'Switch session and open boss', exact: true }).click()
  await desktop.waitForFunction(() => window.fixtureStore.getState().selectedPaneId === 'owner:p1')
  assert.equal(await desktop.evaluate(() => window.bossOpenCalls.length), 1)
  assert.deepEqual(await desktop.evaluate(() => window.bossFlow.filter(call => /^(settings|init|open):/.test(call))), ['settings:owner', 'init:owner', 'open:owner'])
  assert.deepEqual(errors, [])

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const phoneErrors = []; phone.on('pageerror', e => phoneErrors.push(e.message))
  await phone.addInitScript(() => { window.fixtureRemote = true; window.droverRemote = true })
  await phone.goto(url)
  await phone.getByRole('button', { name: 'Projects and agents', exact: true }).click({ timeout: 5000 }).catch(async error => {
    throw new Error(error.message + '\n' + JSON.stringify({ phoneErrors, body: await phone.locator('body').innerText() }))
  })
  await phone.getByRole('button', { name: 'Edit project order', exact: true }).click()
  await phone.locator('.mw-project').last().getByRole('button', { name: 'Move project up' }).click({ timeout: 5000 }).catch(async error => {
    throw new Error(error.message + '\n' + JSON.stringify({ phoneErrors, body: await phone.locator('body').innerText(), store: await phone.evaluate(() => ({ drawer: window.fixtureStore.getState().mobileDrawer, groups: window.modelFolders() })) }))
  })
  await phone.waitForFunction(() => window.modelFolders()[1] === '/project/Gamma')
  assert.deepEqual(await phone.locator('.mw-project-label').allTextContents(), ['Alpha', 'Gamma', 'Beta'])
  await phone.getByRole('button', { name: 'Done', exact: true }).click()
  await phone.locator('.mw-project').filter({ hasText: 'Beta' }).getByRole('button', { name: 'Project importance' }).click()
  await phone.getByRole('menuitem', { name: 'Important project', exact: true }).click()
  await phone.waitForFunction(() => window.fixtureStore.getState().settings.projectImportance['/project/Beta'] === 'important')
  assert.deepEqual(await phone.locator('.mw-project-label').allTextContents(), ['Alpha', 'Gamma', 'Beta'], 'importance does not override manual order')
  await phone.getByRole('button', { name: 'Edit project order', exact: true }).click()
  await phone.getByRole('button', { name: 'Sort by importance', exact: true }).click()
  await phone.waitForFunction(() => window.modelFolders()[0] === '/project/Beta')
  await phone.evaluate(() => window.addDuplicateProject())
  await phone.waitForFunction(() => document.querySelectorAll('.mw-project').length === 4)
  assert.deepEqual(await phone.locator('.mw-project-label').allTextContents(), ['Alpha', 'Alpha', 'Beta', 'Gamma'])
  await phone.locator('.mw-project').filter({ hasText: 'Alpha' }).first().getByRole('button', { name: 'Move project down' }).click()
  await phone.waitForFunction(() => window.modelFolders()[0] === '/project/Beta')
  assert.deepEqual(await phone.locator('.mw-project-label').allTextContents(), ['Beta', 'Alpha', 'Alpha', 'Gamma'], 'phone down arrow skips another workspace of the same folder')
  assert.deepEqual(await phone.evaluate(() => window.fixtureStore.getState().settings.projectOrder), ['/project/Beta', '/project/Alpha', '/project/Gamma'])
  assert.equal(await phone.evaluate(() => window.statusCalls + window.installCalls + window.planCalls + window.restartCalls.length), 0, 'phone cannot access local integrations or daemon restart')
  await phone.screenshot({ path: '/tmp/drover-docs-phone.png' })
  assert.deepEqual(phoneErrors, [])
  const nonMac = await browser.newPage()
  await nonMac.addInitScript(() => { window.fixturePlatform = 'linux' })
  await nonMac.goto(url); await nonMac.locator('.ws').first().waitFor()
  assert.equal(await nonMac.locator('.codex-integration-warning').count(), 0)
  assert.equal(await nonMac.evaluate(() => window.statusCalls + window.installCalls + window.planCalls + window.restartCalls.length), 0, 'Codex repair UI is Mac-only')
})
