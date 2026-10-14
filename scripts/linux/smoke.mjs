// Run only in a disposable Linux container with packaged Drover and synthetic fixtures.
// --desktop uses an explicitly supplied X11 desktop instead of our private Xvfb.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright-core'
import { createServer } from 'node:net'
import { createServer as httpServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, execFileSync } from 'node:child_process'

if (process.platform !== 'linux' || !existsSync('/.dockerenv')) throw new Error('Use a disposable Linux container')
let executablePath = process.argv[2]
if (!executablePath) throw new Error('Pass the packaged Drover executable')
const desktop = process.argv.includes('--desktop')
const qemuAppImage = process.argv.includes('--qemu-appimage')
if (desktop && !process.env.DISPLAY) throw new Error('--desktop requires DISPLAY and X11 authorization')
if (qemuAppImage && process.arch !== 'arm64') throw new Error('--qemu-appimage requires an arm64 container')
// Start our own virtual display: xvfb-run's signal-based readiness can hang on
// some container kernels. Only this synthetic display/process is managed here.
const display = 97
const xvfb = desktop ? null : spawn('Xvfb', [`:${display}`, '-screen', '0', '1280x1024x24', '-nolisten', 'tcp'], { stdio: 'ignore' })
const displayDeadline = Date.now() + 10000
while (!desktop && !existsSync(`/tmp/.X11-unix/X${display}`) && Date.now() < displayDeadline) await new Promise(resolve => setTimeout(resolve, 50))
if (!desktop && !existsSync(`/tmp/.X11-unix/X${display}`)) { xvfb.kill(); throw new Error('Xvfb did not start') }
const root = mkdtempSync(join(tmpdir(), 'drover-platform-smoke-'))
if (executablePath.endsWith('.AppImage')) {
  const localImage = join(root, 'Drover.AppImage')
  copyFileSync(executablePath, localImage); chmodSync(localImage, 0o700)
  if (qemuAppImage) {
    // AppImage's AI marker occupies ELF padding that binfmt requires to be zero.
    // Normalize only our disposable copy so QEMU can execute its extraction runtime.
    const bytes = readFileSync(localImage)
    assert.equal(bytes.subarray(0, 4).toString('hex'), '7f454c46')
    assert.equal(bytes.readUInt16LE(18), 183)
    assert.equal(bytes.subarray(8, 11).toString('hex'), '414902')
    bytes.fill(0, 8, 11); writeFileSync(localImage, bytes)
  }
  execFileSync(localImage, ['--appimage-extract'], { cwd: root, stdio: 'ignore', timeout: 30000 })
  executablePath = join(root, 'squashfs-root/drover')
}
const home = join(root, 'home'), profile = join(root, 'profile'), capture = join(root, 'commands.jsonl')
const session = 'platform-smoke', socket = join(home, '.config/herdr/sessions', session, 'herdr.sock')
mkdirSync(join(home, '.local/bin'), { recursive: true }); mkdirSync(profile); mkdirSync(join(socket, '..'), { recursive: true })
writeFileSync(join(profile, 'settings.json'), JSON.stringify({ session, autoStartServer: false, stopServerOnQuit: true, notifications: false, showLimits: false }))
const terminalCapture = join(root, 'terminal.jsonl')
writeFileSync(join(home, '.local/bin/herdr'), `#!${process.execPath}\nconst fs=require('node:fs'),args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify(args)+'\\n');if(args.includes('terminal')){console.log(JSON.stringify({type:'terminal.frame',seq:1,full:true,width:80,height:24,bytes:Buffer.from('synthetic shell> ').toString('base64')}));process.stdin.on('data',data=>fs.appendFileSync(${JSON.stringify(terminalCapture)},data));process.stdin.on('end',()=>process.exit(0));}else if(args.includes('--version'))console.log('herdr 0.9.4');else if(args[0]==='session'&&args[1]==='list')console.log(JSON.stringify({sessions:[{name:${JSON.stringify(session)},running:true,socket_path:${JSON.stringify(socket)}}]}));else if(args.includes('status'))console.log('codex: not installed');\n`, { mode: 0o700 })
const pane = { workspace_id: 'w1', tab_id: 'w1:t1', pane_id: 'w1:p1', terminal_id: 'synthetic-terminal', cwd: home, foreground_cwd: home, command: 'sh', agent: null, agent_status: 'idle' }
const snapshot = { version: '0.9.4', protocol: 22, workspaces: [{ workspace_id: 'w1', label: 'Fixture shell', number: 1 }], tabs: [{ workspace_id: 'w1', tab_id: 'w1:t1', label: 'Shell', number: 1 }], panes: [pane], layouts: [{ workspace_id: 'w1', tab_id: 'w1:t1', panes: [{ pane_id: 'w1:p1', rect: { x: 0, y: 0, width: 80, height: 24 } }] }], agents: [] }
const sockets = new Set()
const api = createServer(client => {
  sockets.add(client); client.on('close', () => sockets.delete(client)); client.on('error', () => {})
  let buffer = ''
  client.on('data', bytes => {
    buffer += bytes
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1)
      const result = message.method === 'ping' ? { version: '0.9.4' } : message.method === 'session.snapshot' ? { snapshot } : {}
      client.write(JSON.stringify({ id: message.id, result }) + '\n')
    }
  })
})
api.listen(socket); await once(api, 'listening')
// A synthetic HTTP process exercises Linux lsof port/cwd discovery.
const preview = httpServer((_req, response) => response.end('platform fixture'))
preview.listen(0, '127.0.0.1'); await once(preview, 'listening')
let app, child
const errors = []
try {
  // QEMU cannot reliably launch Chromium's zygote/GPU subprocesses.
  app = await electron.launch({ executablePath, args: ['--no-sandbox', '--disable-gpu', ...(qemuAppImage ? ['--no-zygote', '--in-process-gpu'] : [])], timeout: qemuAppImage ? 120000 : 30000, env: {
    ...process.env, DISPLAY: desktop ? process.env.DISPLAY : `:${display}`, HOME: home, SHELL: '/bin/sh', DROVER_SESSION: session,
    DROVER_USER_DATA: profile, DROVER_BACKGROUND: '1', DROVER_READONLY: '0',
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share')
  } })
  child = app.process()
  const page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(async () => (await window.herdr.init()).connection.status === 'connected', null, { timeout: 20000 })
  const info = await page.evaluate(() => window.herdr.init())
  assert.equal(info.platform, 'linux'); assert.equal(info.connection.session, session)
  assert.equal(info.attachmentsDir, join(home, '.local/share/drover/attachments'))
  const visibleDeadline = Date.now() + 20000
  while (!await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()) && Date.now() < visibleDeadline) await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true)
  assert.ok(await page.evaluate(() => window.herdr.officeInit()))
  const servers = await page.evaluate(() => window.herdr.previewServers())
  assert.ok(servers.some(server => server.port === preview.address().port), 'Linux lsof discovered the fixture HTTP listener')
  const terminal = page.locator('.xterm-helper-textarea').first()
  await terminal.waitFor({ state: 'attached', timeout: 10000 })
  if (desktop) {
    const xid = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readUInt32LE(0))
    execFileSync('xdotool', ['windowactivate', '--sync', String(xid)], { timeout: 10000 })
    execFileSync('xdotool', ['windowfocus', '--sync', String(xid)], { timeout: 10000 })
  }
  await terminal.focus()
  if (desktop) {
    // A fresh GNOME session can retain its overview grab after activation.
    execFileSync('xdotool', ['key', '--clearmodifiers', 'Escape'], { timeout: 10000 })
    await page.waitForFunction(() => document.hasFocus() && document.activeElement?.classList.contains('xterm-helper-textarea'), null, { timeout: 10000 })
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  for (const key of ['a', 'e', 'r', 'w']) {
    if (desktop) execFileSync('xdotool', ['key', '--clearmodifiers', 'ctrl+' + key], { timeout: 10000 })
    else await page.keyboard.press('Control+' + key)
  }
  await new Promise(resolve => setTimeout(resolve, 300))
  const input = readFileSync(terminalCapture, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(message => message.type === 'terminal.input').map(message => message.text || '').join('')
  for (const code of [1, 5, 18, 23]) assert.ok(input.includes(String.fromCharCode(code)), 'Readline key Ctrl+' + String.fromCharCode(code + 64) + ' reached the synthetic shell transport')
  const beforeSidebar = await page.locator('.sidebar').count()
  if (desktop) execFileSync('xdotool', ['key', '--clearmodifiers', 'ctrl+shift+b'], { timeout: 10000 })
  else await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'B', modifiers: ['control', 'shift'] })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'B', modifiers: ['control', 'shift'] })
  })
  let sidebarShortcut = false
  try {
    await page.waitForFunction(before => document.querySelectorAll('.sidebar').length !== before, beforeSidebar, { timeout: 3000 })
    sidebarShortcut = true
  } catch {
    if (desktop) throw new Error('Physical Ctrl+Shift+B did not toggle the sidebar on the X11 desktop')
    // CDP input may not invoke native GTK menu accelerators. Verify the installed
    // menu map/dispatch separately and report physical shortcut status honestly.
    const accelerator = await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu().items.flatMap(menu => menu.submenu?.items || []).find(item => item.label === 'Toggle Sidebar')
      item.click()
      return item.accelerator
    })
    assert.equal(accelerator, 'Ctrl+Shift+B')
    await page.waitForFunction(before => document.querySelectorAll('.sidebar').length !== before, beforeSidebar, { timeout: 3000 })
  }
  assert.deepEqual(errors, [])
  const lifecycleFile = join(profile, 'logs/lifecycle.log')
  assert.ok(readFileSync(lifecycleFile, 'utf8').includes('herdr-watchdog-armed'))
  const closed = once(child, 'exit'); child.kill('SIGKILL'); await closed
  const deadline = Date.now() + 10000
  while (Date.now() < deadline && !readFileSync(capture, 'utf8').includes('"server","stop"')) await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(readFileSync(capture, 'utf8').includes('["--session","platform-smoke","server","stop"]'), 'Crash watchdog stopped only the synthetic named session')
  console.log(JSON.stringify({ platform: info.platform, arch: process.arch, desktop, qemuAppImage, connected: info.connection.status, office: true, previewDiscovery: true, terminalReadlineKeys: true, sidebarShortcut, sidebarMenuDispatch: true, crashWatchdog: true, rendererErrors: errors }))
} finally {
  if (app && child?.exitCode === null && child.signalCode === null) await app.close().catch(() => {})
  for (const client of sockets) client.destroy()
  await Promise.all([new Promise(resolve => api.close(resolve)), new Promise(resolve => preview.close(resolve))])
  rmSync(root, { recursive: true, force: true })
  xvfb?.kill('SIGTERM')
}
