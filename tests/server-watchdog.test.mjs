import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const bundle = mkdtempSync(join(tmpdir(), 'drover-watchdog-bundle-'))
await build({ entryPoints: { watchdog: 'src/main/herdr/watchdog.ts', worker: 'src/main/herdr/watchdog-worker.ts' }, bundle: true, platform: 'node', format: 'cjs', outdir: bundle, outExtension: { '.js': '.cjs' }, logLevel: 'silent' })
const { ServerWatchdog } = createRequire(import.meta.url)(join(bundle, 'watchdog.cjs'))
process.on('exit', () => rmSync(bundle, { recursive: true, force: true }))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn) {
  const deadline = performance.now() + 3000
  do { if (fn()) return; await delay(10) } while (performance.now() < deadline)
  assert.fail('watchdog did not reach expected state within 3 seconds')
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'drover-watchdog-case-'))
  const commands = join(dir, 'commands.jsonl')
  const herdr = join(dir, 'herdr')
  writeFileSync(herdr, `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.CAPTURE,JSON.stringify({args:process.argv.slice(2),controller:process.env.HERDR_CONTROLLER_ID,electron:process.env.ELECTRON_RUN_AS_NODE,login:process.env.LOGIN_FIXTURE})+'\\n')\n`, { mode: 0o700 })
  const parent = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  const events = []
  const watchers = [], children = []
  const create = () => {
    const w = new ServerWatchdog(dir, (event, details) => events.push({ event, ...details }), join(bundle, 'worker.cjs'), parent.pid)
    const update = w.update.bind(w)
    w.update = (...args) => { update(...args); const child = w.active?.child; if (child && !children.includes(child)) children.push(child) }
    watchers.push(w); return w
  }
  const target = (session = 'isolation', generation = 1) => ({ session, generation, socketPath: join(dir, session, 'herdr.sock'), herdrPath: herdr, env: { PATH: process.env.PATH, CAPTURE: commands, LOGIN_FIXTURE: 'login env' } })
  const log = () => { try { return readFileSync(join(dir, 'herdr-watchdog.log'), 'utf8') } catch { return '' } }
  const calls = () => {
    if (!existsSync(commands)) return []
    // The fake CLI appends JSONL while this reader polls. Only newline-ended
    // records are complete; parse errors in complete records still fail.
    const content = readFileSync(commands, 'utf8'), end = content.lastIndexOf('\n')
    return end < 0 ? [] : content.slice(0, end).split('\n').filter(Boolean).map(JSON.parse)
  }
  const exited = child => child.exitCode !== null || child.signalCode !== null
  const childClosed = async child => {
    if (exited(child)) return
    let timer
    try {
      await Promise.race([once(child, 'close'), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Watchdog fixture process did not close within 5 seconds')), 5000) })])
    } finally { clearTimeout(timer) }
  }
  t.after(async () => {
    const closures = [...children, parent].map(childClosed)
    watchers.forEach(w => w.disarm()); if (!exited(parent)) parent.kill('SIGKILL')
    await Promise.all(closures)
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, parent, events, children, create, target, log, calls, childClosed }
}

test('abrupt parent death stops only the named attached session, using login env and controller attribution', async t => {
  const f = fixture(t), w = f.create()
  w.update(true, f.target())
  await until(() => f.log().includes('"event":"watching"'))
  const started = Date.now(); f.parent.kill('SIGKILL')
  await until(() => f.calls().length === 1)
  assert.ok(Date.now() - started < 3000)
  assert.deepEqual(f.calls()[0], { args: ['--session', 'isolation', 'server', 'stop'], controller: 'drover-watchdog', login: 'login env' })
  await until(() => !existsSync(join(f.dir, 'isolation', 'drover-watchdog.json')))
})

test('OFF, unattached sessions and normal disarm never send server stop after parent death', async t => {
  const f = fixture(t), w = f.create()
  w.update(false, f.target()); w.update(true, null)
  assert.equal(f.events.length, 0)
  w.update(true, f.target())
  await until(() => f.log().includes('"event":"watching"'))
  const stopped = f.childClosed(f.children.at(-1))
  w.update(false, f.target())
  assert.equal(existsSync(join(f.dir, 'isolation', 'drover-watchdog.json')), false)
  await stopped
  const parentClosed = f.childClosed(f.parent)
  f.parent.kill('SIGKILL'); await parentClosed
  assert.deepEqual(f.calls(), [])
})

test('repeated snapshots keep one watcher; reconnect and session switch replace it without stopping old sessions', async t => {
  const f = fixture(t), w = f.create()
  w.update(true, f.target()); w.update(true, f.target())
  assert.equal(f.events.filter(e => e.event === 'herdr-watchdog-armed').length, 1)
  w.update(true, f.target('isolation', 2))
  w.update(true, f.target('new-session', 3))
  assert.equal(f.events.filter(e => e.event === 'herdr-watchdog-armed').length, 3)
  assert.equal(existsSync(join(f.dir, 'isolation', 'drover-watchdog.json')), false)
  await until(() => f.log().split('\n').some(line => line.includes('"event":"watching"') && line.includes('"session":"new-session"')))
  f.parent.kill('SIGKILL'); await until(() => f.calls().length === 1)
  assert.deepEqual(f.calls()[0].args, ['--session', 'new-session', 'server', 'stop'])
})

test('a replacement session owner invalidates older watchers; default is always explicitly targeted', async t => {
  const f = fixture(t), old = f.create(), current = f.create()
  old.update(true, f.target('default'))
  await until(() => f.log().includes('"event":"watching"'))
  current.update(true, f.target('default'))
  old.disarm()
  assert.equal(existsSync(join(f.dir, 'default', 'drover-watchdog.json')), true)
  f.parent.kill('SIGKILL'); await until(() => f.calls().length === 1)
  assert.deepEqual(f.calls()[0].args, ['--session', 'default', 'server', 'stop'])
})
