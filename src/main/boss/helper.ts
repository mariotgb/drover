/** Runs with Electron's embedded Node runtime; no separate Node installation. */
export const BOSS_HELPER_SOURCE = String.raw`'use strict'
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const folder = path.join(__dirname, '..')
const args = process.argv.slice(2)
const command = args.shift()
let request
if (command === 'roster' && args.length === 0) request = { method: 'roster' }
else if (command === 'send' && (args.length === 2 || (args.length === 4 && args[2] === '--id'))) {
  request = { method: 'send', project: args[0], text: args[1], paneId: process.env.HERDR_PANE_ID, session: process.env.HERDR_SESSION, ...(args.length === 4 ? { id: args[3] } : {}) }
} else if (command === 'reply' && args.length === 3) {
  request = { method: 'reply', project: args[0], id: args[1], text: args[2], paneId: process.env.HERDR_PANE_ID, session: process.env.HERDR_SESSION }
} else {
  console.error('Usage: boss roster | boss send <project-key|unique-name|all> "text" [--id original-id] | boss reply <project-key> <id> "text"')
  process.exit(2)
}
function offlineReply(config) {
    const roster = JSON.parse(fs.readFileSync(path.join(folder, 'roster.json'), 'utf8'))
    const ledger = JSON.parse(fs.readFileSync(path.join(folder, '.drover', 'boss-requests.json'), 'utf8'))
    const assignment = ledger.requests.find(r => r.id === request.id && r.session === roster.session)
    const project = assignment && assignment.projects.find(p => p.projectKey === request.project)
    if (!roster.boss || !project || !project.lead || project.status !== 'delivered') throw new Error('No delivered assignment matches this project and ID')
    if (!request.paneId || request.paneId !== project.lead.paneId || (request.session && request.session !== roster.session)) throw new Error('Run boss reply from the assigned lead agent pane in the same herdr session')
    if (!request.text.trim() || request.text.length > 256 * 1024) throw new Error('Invalid reply text')
    const env = { ...process.env, HERDR_CONTROLLER_ID: 'drover-boss' }
    const cli = args => {
      const output = execFileSync(config.herdrPath || 'herdr', ['--session', roster.session, ...args], { env, encoding: 'utf8', timeout: 25000, maxBuffer: 2 * 1024 * 1024 })
      const lines = output.trim().split('\n')
      for (let i = lines.length - 1; i >= 0; i--) { try { const value = JSON.parse(lines[i]); if (value.result || value.error) return value } catch {} }
      throw new Error('herdr returned no JSON receipt')
    }
    const identity = agent => JSON.stringify([agent.terminal_id, agent.agent_session, agent.agent, agent.name])
    const sender = cli(['agent', 'get', request.paneId]).result?.agent
    if (!sender || sender.pane_id !== project.lead.paneId || sender.name !== project.lead.name || sender.agent !== project.lead.kind || !project.leadIdentity || identity(sender) !== project.leadIdentity) throw new Error('The assigned lead has changed')
    const boss = cli(['agent', 'get', roster.boss.paneId]).result?.agent
    if (!boss || boss.name !== roster.boss.name || boss.pane_id !== roster.boss.paneId || !assignment.bossIdentity || identity(boss) !== assignment.bossIdentity) throw new Error('The Main boss has changed')
    if (boss.agent_status === 'blocked' || boss.launch_pending || boss.interactive_ready === false) throw new Error('The Main boss is blocked or not ready; ask the user to answer it')
    // Once accepted, do not resend if local receipt persistence fails.
    const receipt = cli(['agent', 'prompt', roster.boss.paneId, '[Ответ ' + request.project + ' · ' + request.id + '] ' + request.text])
    if (receipt.id !== 'cli:agent:prompt' || receipt.result?.type !== 'agent_prompted' || receipt.result.agent?.pane_id !== roster.boss.paneId || receipt.result.agent?.name !== roster.boss.name) throw new Error('Reply was not confirmed by herdr')
    const id = randomUUID(), ts = Date.now()
    const directory = path.join(folder, '.drover', 'boss-receipts')
    const metadata = { version: 1, type: 'boss_reply', confirmation: 'unconfirmed', id, ts, assignmentId: request.id, projectKey: request.project, session: roster.session,
      fromPaneId: sender.pane_id, fromName: sender.name, toPaneId: boss.pane_id,
      fromTerminalId: sender.terminal_id, toTerminalId: boss.terminal_id,
      fromSessionId: sender.agent_session?.value, toSessionId: boss.agent_session?.value,
      receipt: { id: receipt.id, result: { type: 'agent_prompted', agent: { pane_id: boss.pane_id, name: boss.name } } } }
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
      const temporary = path.join(directory, id + '.tmp')
      fs.writeFileSync(temporary, JSON.stringify(metadata) + '\n', { mode: 0o600, flag: 'wx' })
      fs.renameSync(temporary, path.join(directory, id + '.json'))
    } catch (error) { console.error('Reply delivered; could not save its local receipt. Do not resend: ' + error.message); process.exitCode = 1; return }
    console.log(JSON.stringify({ id: request.id, projectKey: request.project, status: 'delivered', confirmed: false, code: 'replyUnconfirmed' }))
    return
}
try {
  const config = JSON.parse(fs.readFileSync(path.join(folder, '.drover', 'boss-runtime.json'), 'utf8'))
  const socket = net.createConnection(config.socket)
  let output = '', complete = false, connected = false
  const fail = error => { if (complete) return; complete = true; console.error(error.message || String(error)); socket.destroy(); process.exitCode = 1 }
  socket.setTimeout(180000, () => fail(new Error('Drover HQ request timed out; inspect boss-requests.json before retrying with the same ID')))
  socket.on('error', error => {
    // Fall back only when no server exists, never after a connected or rejected request.
    if (command === 'reply' && !complete && !connected && ['ENOENT', 'ECONNREFUSED'].includes(error.code)) {
      complete = true
      socket.destroy()
      try { offlineReply(config) } catch (error) { console.error(error.message); process.exitCode = 1 }
      return
    }
    if (command === 'roster' && !complete && ['ENOENT', 'ECONNREFUSED'].includes(error.code)) {
      complete = true
      try { console.log(fs.readFileSync(path.join(folder, 'roster.json'), 'utf8').trim()) } catch (error) { console.error(error.message); process.exitCode = 1 }
      socket.destroy()
      return
    }
    fail(error)
  })
  socket.on('connect', () => { connected = true; socket.write(JSON.stringify({ token: config.token, ...request }) + '\n') })
  socket.on('data', bytes => {
    output += bytes.toString('utf8')
    if (output.length > 4 * 1024 * 1024) return fail(new Error('HQ response too large'))
    if (!output.includes('\n')) return
    try {
      const response = JSON.parse(output.slice(0, output.indexOf('\n')))
      if (!response.ok) return fail(new Error(response.error || 'HQ request failed'))
      complete = true
      console.log(JSON.stringify(response.result, null, 2))
      socket.end()
    } catch (error) { fail(error) }
  })
  socket.on('end', () => { if (!complete) fail(new Error('Drover HQ disconnected before returning a result')) })
} catch (error) { console.error(error.message || String(error)); process.exitCode = 1 }
`
