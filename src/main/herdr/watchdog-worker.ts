import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'

// A separate Node process: Electron's quit/signal handlers cannot run after SIGKILL.
const { file, token, parentPid, herdrPath, session } = JSON.parse(process.argv[2]) as {
  file: string; token: string; parentPid: number; herdrPath: string; session: string
}
const env: NodeJS.ProcessEnv = { ...process.env, HERDR_CONTROLLER_ID: 'drover-watchdog' }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_NO_ATTACH_CONSOLE
let parentGone = false
let stopping = false
let attempts = 0
const ownsSession = () => {
  try { return JSON.parse(readFileSync(file, 'utf8')).token === token }
  catch { return false }
}
const record = (event: string, details: Record<string, unknown> = {}) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, parentPid, watchdogPid: process.pid, session, ...details }))
}
function check(): void {
  if (!ownsSession()) process.exit(0)
  if (!parentGone) {
    try { process.kill(parentPid, 0) }
    catch (error) { parentGone = (error as NodeJS.ErrnoException).code === 'ESRCH' }
  }
  if (!parentGone || stopping) return
  stopping = true
  record('parent-exited')
  // Always name the attached session, including "default"; never use caller context.
  const result = spawnSync(herdrPath, ['--session', session, 'server', 'stop'], { env, timeout: 2000, encoding: 'utf8' })
  record('herdr-stop', { code: result.status, error: result.error?.message, stderr: result.stderr })
  if (result.status === 0 || ++attempts >= 3) {
    if (ownsSession()) rmSync(file, { force: true })
    process.exit(result.status === 0 ? 0 : 1)
  }
  stopping = false
}
// EOF also detects death if the OS has already reused the parent PID.
process.stdin.on('end', () => { parentGone = true; check() })
process.stdin.resume()
record('watching')
setInterval(check, 1000)
check()
