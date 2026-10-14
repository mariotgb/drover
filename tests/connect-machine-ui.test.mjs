import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { chromium } from 'playwright-core'

// Connect a machine imported from herdr: explicit server-key click (even when known), login key from
// the suggested list or the file picker, install the agents key, then the project scope.
test('Connect flow confirms the server key, installs with the chosen login key and sets the project scope', async t => {
  const executablePath = process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()
  if (!existsSync(executablePath)) { t.skip('Local Chromium is required for the UI regression'); return }
  const root = mkdtempSync(join(tmpdir(), 'drover-connect-ui-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  await build({ stdin: { resolveDir: resolve('.'), loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client'
    import { useState } from 'react'
    import { useStore } from './src/renderer/src/store'
    import { ConnectMachineWizard } from './src/renderer/src/components/ConnectMachineWizard'
    const pane = { pane_id: 'p', terminal_id: 'x', workspace_id: 'w', tab_id: 't', focused: false, agent_status: 'idle', cwd: '/projects/api', foreground_cwd: '/projects/api' }
    useStore.setState({ snapshot: { version: 'x', protocol: 1, workspaces: [{ workspace_id: 'w', label: 'api', number: 1, focused: true, pane_count: 1, tab_count: 1, active_tab_id: 't', agent_status: 'idle' }], tabs: [{ tab_id: 't', workspace_id: 'w', number: 1, label: '', focused: true, pane_count: 1 }], panes: [pane], layouts: [], agents: [] } })
    window.calls = []
    const machine = { id: 'm1', name: 'staging', kind: 'direct', alias: 'drover-staging', host: '198.51.100.20', port: 2222, user: 'deploy', publicIp: true, origin: 'herdr', permissions: { mode: 'full', projects: [] }, status: { state: 'unknown', error: { code: 'key_not_installed' } } }
    const api = {
      probeHostKey: async (...a) => { window.calls.push(['probe', ...a]); return { algorithm: 'ED25519', fingerprint: 'SHA256:host', known: true, passwordAllowed: false } },
      loginKeyCandidates: async (host) => { window.calls.push(['candidates', host]); return [{ path: '/k/deploy', name: 'deploy', fingerprint: 'SHA256:a', algorithm: 'ED25519', comment: '' }, { path: '/k/id', name: 'id', fingerprint: 'SHA256:b', algorithm: 'ED25519', comment: '' }] },
      chooseBridgeKeyFile: async () => { window.calls.push(['choose']); return '/k/picked' },
      installKey: async (id, o) => { window.calls.push(['install', id, o]); if (window.reachableOnly) return {...machine,status:{state:'online',checks:{tcp:true,auth:false},error:{code:'key_not_installed'}}}; if (window.refuse) throw new Error("Error invoking remote method 'machines:install-key': Error: [auth_failed] denied"); return { ...machine, status: { state: 'online', checks: {tcp:true,auth:true} } } },
      setPermissions: async (id, p) => { window.calls.push(['permissions', id, p]) }
    }
    function Root() { const [open, setOpen] = useState(true); return open ? <ConnectMachineWizard api={api} state={{ machines: [machine], bridgeMachineId: null }} machineId="m1" onClose={() => setOpen(false)} /> : <p id="closed">closed</p> }
    createRoot(document.getElementById('root')).render(<Root/>)
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
  const calls = () => page.evaluate(() => window.calls)

  // Server key: probed for this login; known keys still need an explicit click; nothing installed yet.
  const right = page.getByRole('button', { name: 'This is the right server' })
  await right.waitFor()
  await page.getByText('known_hosts').waitFor()
  assert.deepEqual((await calls()).find(c => c[0] === 'probe'), ['probe', '198.51.100.20', 2222, 'deploy'])
  assert.equal((await calls()).some(c => c[0] === 'install'), false)
  await right.click()

  // Login key: best match preselected; the file picker adds and selects its file.
  const install = page.getByRole('button', { name: 'Install agents key' })
  await install.waitFor()
  assert.equal(await page.locator('input[name="connect-key"]').first().isChecked(), true)
  await page.getByRole('button', { name: 'Choose key file…' }).click()
  await page.waitForFunction(() => document.querySelectorAll('input[name="connect-key"]').length === 3)

  // A refused key says so in this flow's words and allows another try.
  await page.evaluate(() => { window.refuse = true })
  await install.click()
  await page.getByText('The server refused this key for deploy.', { exact: false }).waitFor()
  assert.deepEqual((await calls()).filter(c => c[0] === 'install').at(-1), ['install', 'm1', { keyPath: '/k/picked', acceptedFingerprint: 'SHA256:host' }])

  // TCP reachability alone must keep the wizard on sign-in with a visible error.
  await page.evaluate(() => { window.refuse = false; window.reachableOnly = true })
  await install.click()
  await page.getByRole('alert').waitFor()
  assert.equal(await install.isVisible(), true)
  await page.evaluate(() => { window.reachableOnly = false })

  // Success with the suggested key, then the project scope.
  await page.evaluate(() => { window.refuse = false })
  await page.locator('input[name="connect-key"]').nth(1).check()
  await install.click()
  await page.getByText('is connected', { exact: false }).waitFor()
  assert.deepEqual((await calls()).filter(c => c[0] === 'install').at(-1), ['install', 'm1', { keyPath: '/k/deploy', acceptedFingerprint: 'SHA256:host' }])
  await page.getByRole('radio', { name: 'Selected projects' }).click()
  await page.getByRole('button', { name: 'api' }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await page.waitForFunction(() => window.calls.some(c => c[0] === 'permissions'))
  assert.deepEqual((await calls()).find(c => c[0] === 'permissions'), ['permissions', 'm1', { mode: 'projects', projects: ['/projects/api'] }])
  assert.deepEqual(errors, [])
})
