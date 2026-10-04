/** Manual integration check. Requires an explicitly started, disposable drover-test-be session.
 * Builds a private copy, uses only shell panes and synthetic transcript files, never the live app/site.
 * node scripts/remote-latency.mjs [--assert]
 */
import { mkdtemp, cp, mkdir, writeFile, readFile, appendFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { createServer as tcpServer, connect } from 'node:net'
import { createServer as tlsServer } from 'node:tls'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const root = await mkdtemp(join(tmpdir(), 'drover-latency-'))
const label = `Latency-${root.split('/').at(-1)}`
const copy = join(root, 'app'), profile = join(root, 'profile')
const cli = (...args) => JSON.parse(execFileSync('herdr', ['--session', 'drover-test-be', ...args], { env: { ...process.env, HERDR_CONTROLLER_ID: 'codex-be' }, encoding: 'utf8' }) || '{}')
let app, browser, tls, proxy, writer
const sockets = new Set(), panes = [], errors = []
const listen = async (server) => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port }
const report = { delayMs: [150, 400], errors, opens: [], socketsClosed: 0 }
try {
  const workspace = cli('workspace', 'create', '--cwd', root, '--label', label, '--no-focus').result
  for (let i = 0; i < 3; i++) {
    const pane = i === 0 ? workspace.root_pane : cli('tab', 'create', '--workspace', workspace.workspace.workspace_id, '--cwd', root, '--label', `Fixture-${i}`, '--no-focus').result.root_pane
    const session = `11111111-1111-4111-8111-${String(i + 1).padStart(12, '0')}`
    panes.push({ id: pane.pane_id, session })
    cli('pane', 'report-agent', pane.pane_id, '--source', 'drover-test-be-fixture', '--agent', 'claude', '--state', 'idle', '--agent-session-id', session)
  }
  await mkdir(copy)
  for (const entry of ['src', 'resources', 'package.json', 'electron.vite.config.ts', 'tsconfig.node.json', 'tsconfig.web.json']) {
    try { await cp(resolve(entry), join(copy, entry), { recursive: true }) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  await symlink(resolve('node_modules'), join(copy, 'node_modules'))
  const fixtures = join(root, 'fixtures'), claude = join(fixtures, 'claude'), codex = join(fixtures, 'codex')
  const project = join(claude, 'projects', root.replace(/[^A-Za-z0-9]/g, '-'))
  await mkdir(project, { recursive: true }); await mkdir(codex, { recursive: true })
  const line = (session, n) => JSON.stringify({ type: 'user', uuid: `${session}-${n}`, sessionId: session, cwd: root, timestamp: new Date().toISOString(), message: { role: 'user', content: `Fixture ${session.slice(-1)} message ${n}` } }) + '\n'
  for (const { session } of panes) await writeFile(join(project, session + '.jsonl'), Array.from({ length: 120 }, (_, i) => line(session, i)).join(''))
  // Fixture-only isolation: no home transcript/model cache reads, no scans/HEAD requests to live Mac servers.
  const locate = join(copy, 'src/main/transcripts/locate.ts')
  await writeFile(locate, (await readFile(locate, 'utf8')).replace("return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')", `return ${JSON.stringify(claude)}`).replace("return env.CODEX_HOME || join(homedir(), '.codex')", `return ${JSON.stringify(codex)}`))
  const index = join(copy, 'src/main/index.ts')
  await writeFile(index, (await readFile(index, 'utf8')).replace("handle('preview:servers', () => detectServers())", "handle('preview:servers', () => [])").replace("handle('roles:discover', (_e, cwd: string) => (typeof cwd === 'string' && cwd.startsWith('/') ? discoverRoles(cwd) : []))", "handle('roles:discover', async (_e, cwd: string) => { if (cwd === '/fixture-slow') await new Promise(r => setTimeout(r, 3000)); return [] })").replace("if (agent && !u.reset", "if (false && agent && !u.reset"))
  // Some herdr builds omit session reports from the pane projection. Only our fixture panes get synthetic IDs.
  const service = join(copy, 'src/main/herdr/service.ts')
  await writeFile(service, (await readFile(service, 'utf8')).replace('const snap = res.snapshot', `const snap = res.snapshot; for (const p of snap.panes) { const s = ${JSON.stringify(Object.fromEntries(panes.map(p => [p.id, p.session])))}[p.pane_id]; if(s) p.agent_session = {value:s} as any }`))
  await build({ stdin: { contents: "export {RemoteAuthStore} from './src/main/remote/store'", resolveDir: resolve('.'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: join(root, 'seed.cjs'), alias: { '@shared': resolve('src/shared') }, logLevel: 'silent' })
  const { RemoteAuthStore } = createRequire(import.meta.url)(join(root, 'seed.cjs'))
  await mkdir(profile)
  const reserve = tcpServer(); const backendPort = await listen(reserve); await new Promise(r => reserve.close(r))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem'), '-days', '1', '-subj', '/CN=drover-test.invalid'], { stdio: 'ignore' })
  tls = tlsServer({ key: await readFile(join(root, 'key.pem')), cert: await readFile(join(root, 'cert.pem')) }, s => { const upstream = connect(backendPort, '127.0.0.1'); sockets.add(s); sockets.add(upstream); s.on('close', () => sockets.delete(s)); upstream.on('close', () => sockets.delete(upstream)); s.on('error', () => upstream.destroy()); upstream.on('error', () => s.destroy()); s.pipe(upstream).pipe(s); s.on('close', () => upstream.destroy()) })
  const tlsPort = await listen(tls)
  proxy = tcpServer(s => {
    const up = connect(tlsPort, '127.0.0.1'); sockets.add(s); sockets.add(up)
    for (const [from, to] of [[s, up], [up, s]]) {
      let at = 0
      from.on('data', data => { at = Math.max(at, Date.now() + 150 + Math.random() * 250); from.pause(); setTimeout(() => { if (!to.destroyed) to.write(data); from.resume() }, Math.max(0, at - Date.now())) })
      from.on('error', () => to.destroy()); from.on('end', () => to.end()); from.on('close', () => { sockets.delete(from); to.destroy() })
    }
  })
  const port = await listen(proxy), origin = `https://drover-test.invalid:${port}`
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ remoteEnabled: true, remotePort: backendPort, remotePublicUrl: origin, remoteBehindProxy: false, showLimits: false, notifyDone: false, notifyBlocked: false, playSound: false, syncFocus: false, language: 'en' }))
  const store = new RemoteAuthStore(join(profile, 'remote-auth.json'))
  const device = store.addDevice({ name: 'Fixture browser', rpID: 'drover-test.invalid', userID: 'fixture', credential: { id: 'fixture', publicKey: 'AA', counter: 0 } })
  const { token } = store.issueSession(device.id, origin)
  execFileSync(resolve('node_modules/.bin/electron-vite'), ['build'], { cwd: copy, stdio: ['ignore', 'ignore', 'pipe'], env: process.env })
  const appOutput = []
  app = spawn(resolve('node_modules/.bin/electron'), [join(copy, 'out/main/index.js')], { env: { ...process.env, DROVER_SESSION: 'drover-test-be', DROVER_USER_DATA: profile, DROVER_BACKGROUND: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  app.stdout.on('data', d => appOutput.push(String(d))); app.stderr.on('data', d => appOutput.push(String(d)))
  browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-proxy-server', '--host-resolver-rules=MAP drover-test.invalid 127.0.0.1'] })
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } })
  await context.addCookies([{ name: 'drover_session', value: token, url: origin, httpOnly: true, secure: true, sameSite: 'Strict' }])
  await context.addInitScript(() => { const Original = window.WebSocket; window.__sockets = []; window.__closes = []; window.WebSocket = class extends Original { constructor(...args) { super(...args); window.__sockets.push(this); this.addEventListener('close', e => window.__closes.push(e.code)) } } })
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message))
  for (let i = 0; i < 80; i++) { try { await fetch(`http://127.0.0.1:${backendPort}/auth/session`); break } catch { await new Promise(r => setTimeout(r, 250)) } }
  await page.goto(origin, { timeout: 90_000 }); await page.waitForSelector('.thread-header', { timeout: 60_000 })
  report.geometry = await page.evaluate(() => [...document.querySelectorAll('.sidebar-top,.traffic-space,.welcome-drag,.thread-header,.chat')].map(e => ({ class: e.className, height: e.getBoundingClientRect().height, top: e.getBoundingClientRect().top })))
  report.welcomeGeometry = await page.evaluate(() => { const e = document.createElement('div'); e.className = 'welcome-drag drag'; document.body.append(e); const web = e.getBoundingClientRect().height; document.documentElement.classList.remove('drover-remote'); const desktop = e.getBoundingClientRect().height; document.documentElement.classList.add('drover-remote'); e.remove(); return { web, desktop } })
  const init = await page.evaluate(() => window.api.init()); report.session = init.connection.session
  if (report.session !== 'drover-test-be') throw new Error('Isolation violated')
  const p = panes.at(-1).id
  report.duplicates = await page.evaluate(async id => await Promise.all(Array.from({ length: 3 }, () => window.api.transcriptSubscribe(id))), p)
  report.duplicates = report.duplicates.map(u => ({ count: u.items.length, reset: u.reset, error: u.error }))
  await page.evaluate(id => window.api.transcriptUnsubscribe(id), p)
  report.slowReads = await page.evaluate(async () => { const started = performance.now(); const slow = window.api.discoverRoles('/fixture-slow'); const init = await window.api.init(); const elapsed = performance.now() - started; await slow; return { elapsed } })
  report.burst = await page.evaluate(async () => { const values = await Promise.all(Array.from({ length: 48 }, () => window.api.init().then(() => 'ok', e => e.code))); return values.reduce((acc, v) => ({ ...acc, [v]: (acc[v] || 0) + 1 }), {}) })
  await page.waitForFunction(() => window.__sockets.at(-1)?.readyState === 1, { timeout: 30_000 })
  // Actual UI clicks, never new-agent/prompt actions. Repeated switching crosses subscribe/unsubscribe in flight.
  const rows = page.locator('.ws').filter({ has: page.locator('.ws-label', { hasText: label }) }).locator('.thread:not(.board-row)')
  report.buttons = await rows.count()
  for (let i = 0; i < 18; i++) { if (await rows.count()) await rows.nth(i % await rows.count()).click({ timeout: 5000 }); await page.waitForTimeout(35) }
  writer = setInterval(() => { for (const { session } of panes) void appendFile(join(project, session + '.jsonl'), line(session, 120 + Math.floor(Date.now() / 100))) }, 100)
  for (const s of sockets) s.destroy()
  await page.waitForFunction(() => window.__sockets.length > 1 && window.__sockets.at(-1)?.readyState === 1, { timeout: 30_000 })
  await page.waitForTimeout(2500)
  for (let i = 0; i < panes.length; i++) {
    await rows.nth(i).click()
    try { await page.waitForFunction(marker => { const messages = [...document.querySelectorAll('.msg-user')]; return messages.length >= 100 && messages.some(e => e.textContent.includes(marker)) }, `Fixture ${i + 1} message`, { timeout: 10_000 }) } catch { errors.push(`Chat fixture ${i + 1} did not appear`) }
    report.opens.push({ pane: panes[i].id, messages: await page.locator('.msg-user').count(), textFound: (await page.locator('body').innerText()).includes('Fixture') })
  }
  clearInterval(writer); writer = null
  report.socketsClosed = await page.evaluate(() => window.__closes)
  report.log = await readFile(join(profile, 'logs/remote.log'), 'utf8').catch(() => 'absent')
  // Summaries deliberately omit transcript contents and authorization data.
  if (report.log !== 'absent') report.log = report.log.split('\n').filter(Boolean).map(l => JSON.parse(l).event)
  console.log(JSON.stringify(report, null, 2))
  if (process.argv.includes('--assert') && (report.errors.length || report.duplicates.some(u => u.count < 120) || report.burst.ok !== 48 || report.opens.some(o => o.messages < 100) || report.welcomeGeometry.web !== 0 || report.welcomeGeometry.desktop !== 52 || report.slowReads.elapsed > 2500 || report.log === 'absent')) throw new Error('Latency regression failed')
} finally {
  clearInterval(writer)
  await browser?.close()
  if (app && app.exitCode === null) { app.kill('SIGTERM'); await once(app, 'exit') }
  for (const s of sockets) s.destroy()
  if (proxy) await new Promise(r => proxy.close(r)); if (tls) await new Promise(r => tls.close(r))
  // Only panes created by this harness, on the explicitly disposable session.
  for (const { id } of panes) { try { cli('pane', 'close', id) } catch {} }
  await rm(root, { recursive: true, force: true })
}
