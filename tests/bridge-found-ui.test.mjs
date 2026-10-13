import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { chromium } from 'playwright-core'

// Found bridge card: the login decides the password probe. Re-probe ~300 ms after typing stops,
// drop stale answers, and keep Connect disabled while the current login is unchecked.
test('Found card re-probes the login with a debounce, ignores stale answers and waits before Connect', async t => {
  const executablePath = process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()
  if (!existsSync(executablePath)) { t.skip('Local Chromium is required for the UI regression'); return }
  const root = mkdtempSync(join(tmpdir(), 'drover-found-ui-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  await build({ stdin: { resolveDir: resolve('.'), loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client'
    import { MachinesSettings } from './src/renderer/src/components/MachinesSettings'
    window.probes = []
    const found = { host: '203.0.113.5', port: 22, users: ['bridge-mac'], phoneUrl: 'https://203-0-113-5.sslip.io', tunnelRunning: true, macTunnel: 'running', adminKey: false,
      adminKeyCandidates: [{ path: '/home/me/.ssh/admin', name: 'admin', fingerprint: 'SHA256:a', algorithm: 'ED25519', comment: '' }] }
    const state = { machines: [], bridgeMachineId: null, agentsKey: null, sshInclude: { installed: true, line: '', configPath: '~/.ssh/config' } }
    window.answer = (i, passwordAllowed) => window.probes[i].resolve({ algorithm: 'ED25519', fingerprint: 'SHA256:host', known: true, passwordAllowed })
    window.__droverMachinesApi = {
      state: async () => state, onChange: () => () => {},
      detectExistingBridge: async () => found, onBridgeProgress: () => () => {},
      adoptExistingBridge: async () => ({ machineId: 'm1', steps: [] }), chooseBridgeKeyFile: async () => null,
      probeHostKey: (host, port, user) => new Promise(resolve => window.probes.push({ host, port, user, at: performance.now(), resolve })),
    }
    window.probeUsers = () => window.probes.map(p => p.user)
    document.addEventListener('input', () => { window.lastEdit = performance.now() }, true)
    // Several edits in one synchronous burst, so test round trips cannot stretch them past the debounce.
    window.typeLogin = (...values) => {
      const input = document.getElementById('found-user'), set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      for (const v of values) { set.call(input, v); input.dispatchEvent(new Event('input', { bubbles: true })) }
    }
    createRoot(document.getElementById('root')).render(<MachinesSettings/>)
  ` }, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', outfile: join(root, 'fixture.js'), alias: { '@shared': resolve('src/shared') }, loader: { '.png': 'dataurl', '.md': 'text' }, logLevel: 'silent' })
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html')
    res.end(req.url === '/fixture.js' ? readFileSync(join(root, 'fixture.js')) : '<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)))
  const browser = await chromium.launch({ executablePath, headless: true }); t.after(() => browser.close())
  const page = await browser.newPage()
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  await page.goto('http://127.0.0.1:' + server.address().port)

  const connect = page.getByRole('button', { name: 'Connect this bridge' })
  const passwordLink = page.getByRole('button', { name: 'No key? Use a one-time password instead' })
  const login = page.locator('#found-user')
  const users = () => page.evaluate(() => window.probeUsers())
  const settle = ms => page.waitForTimeout(ms)

  // The first probe runs at once for the default login, and Connect waits for it.
  await page.waitForFunction(() => window.probes.length === 1)
  assert.deepEqual(await users(), ['root'])
  assert.equal(await page.evaluate(() => [window.probes[0].host, window.probes[0].port].join(':')), '203.0.113.5:22')
  assert.equal(await connect.isDisabled(), true)
  await page.evaluate(() => window.answer(0, true))
  await passwordLink.waitFor()
  assert.equal(await connect.isDisabled(), false)

  // Typing a new login hides the old answer at once and probes once, ~300 ms after the last edit.
  // Timing is measured inside the page, so a slow machine cannot fake or break the debounce.
  await page.evaluate(() => window.typeLogin('ad', 'admin'))
  assert.equal(await passwordLink.count(), 0)
  assert.equal(await connect.isDisabled(), true)
  await page.waitForFunction(() => window.probes.length === 2)
  await settle(400)
  assert.deepEqual(await users(), ['root', 'admin'], 'one probe for the final login only')
  const gap = await page.evaluate(() => window.probes[1].at - window.lastEdit)
  assert.ok(gap >= 250, `debounced after the last edit (${Math.round(gap)} ms)`)

  // A newer login wins: the answer for "admin" arrives after the login changed and must be ignored.
  await login.fill('ops')
  await page.waitForFunction(() => window.probes.length === 3)
  await page.evaluate(() => window.answer(1, true))
  await settle(50)
  assert.equal(await passwordLink.count(), 0, 'stale answer ignored')
  assert.equal(await connect.isDisabled(), true, 'still waiting for the current login')

  // Changing the login and back during the debounce also drops the answer already in flight.
  await page.evaluate(() => { window.typeLogin('ops-x', 'ops'); window.answer(2, true) })
  await settle(50)
  assert.equal(await passwordLink.count(), 0, 'in-flight answer dropped on edit')
  assert.equal(await connect.isDisabled(), true, 'a fresh probe is still due')
  await page.waitForFunction(() => window.probes.length === 4)
  assert.deepEqual(await users(), ['root', 'admin', 'ops', 'ops'])
  await page.evaluate(() => window.answer(3, false))
  await page.waitForFunction(() => !document.querySelector('.bridge-actions .btn-primary').disabled)
  assert.equal(await passwordLink.count(), 0, 'no password option where the server refuses passwords')

  // An empty login sends no probe and keeps Connect disabled.
  await login.fill('')
  await settle(450)
  assert.deepEqual(await users(), ['root', 'admin', 'ops', 'ops'])
  assert.equal(await connect.isDisabled(), true)

  assert.deepEqual(errors, [])
})
