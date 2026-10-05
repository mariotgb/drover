import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'drover-office-analyze-'))
let m
try {
  await build({ stdin: { contents: `export * from './src/main/office/analyze/index';
      export { ClaudeParser } from './src/main/transcripts/claude';
      export { CodexParser } from './src/main/transcripts/codex';`, resolveDir: root, loader: 'ts' }, bundle: true,
    platform: 'node', format: 'cjs', outfile: join(dir, 'index.cjs'),
    alias: { '@shared': join(root, 'src/shared') }, logLevel: 'silent' })
  m = createRequire(import.meta.url)(join(dir, 'index.cjs'))
} finally { rmSync(dir, { recursive: true, force: true }) }

const agent = { id: 'office:backend:incarnation1', paneId: 'w1:p2', name: 'backend' }
const reviewer = { id: 'office:reviewer:incarnation1', paneId: 'w1:p3', name: 'reviewer' }
const context = { session: 'office-test', from: 'office:sender:incarnation1', observedAt: 123456789,
  resolveAgent: (session, target) => session !== 'office-test' ? null :
    [agent, reviewer].find((a) => a.name === target || a.paneId === target) ?? null,
  resolveMachine: (alias) => ['pc', 'homeserver', 'builder'].includes(alias) ? `machine:${alias}` : null }
const boardContext = { ...context, departmentId: 'department:w1' }
const prompt = 'herdr agent prompt backend "secret prompt"'
const receipt = (a = agent) => ({ id: 'cli:agent:prompt', result: {
  type: 'agent_prompted', agent: { pane_id: a.paneId, name: a.name, agent_status: 'working' } } })
const run = (input = prompt, output, name = 'Bash', ctx = context) => m.analyzeToolCall({
  id: 'tool-1', name, input: name === 'Bash' ? { command: input } : input, output }, ctx)
const board = (tasks, error) => ({ cwd: '/synthetic/project', exists: true, tasks, ...(error ? { error } : {}) })

test('shell argv preserves quotes, escapes, empty strings and chained commands', () => {
  assert.deepEqual(m.parseShellCommands(`herdr agent prompt 'back'end "a \\"quote\\" and \\$VAR"; ssh pc && echo ''`), [
    { argv: ['herdr', 'agent', 'prompt', 'backend', 'a "quote" and $VAR'] },
    { argv: ['ssh', 'pc'] }, { argv: ['echo', ''] }
  ])
  assert.deepEqual(m.parseShellCommands('herdr agent prompt backend hello\\ world'), [{ argv: ['herdr', 'agent', 'prompt', 'backend', 'hello world'] }])
  assert.deepEqual(m.parseShellCommands("herdr agent prompt backend 'a\\b'"), [{ argv: ['herdr', 'agent', 'prompt', 'backend', 'a\\b'] }])
  assert.deepEqual(m.parseShellCommands('herdr \\\nagent prompt backend hello'), [{ argv: ['herdr', 'agent', 'prompt', 'backend', 'hello'] }])
})

test('env prefixes and nested bash/sh wrappers retain explicit session', () => {
  const found = m.recognizeOfficeCommands(`HERDR_SESSION=other env FOO=bar bash -lc 'sh -c "herdr --session office-test agent prompt backend hi --wait --timeout 10"'`, context)
  assert.deepEqual(found, [{ kind: 'prompt', target: 'backend', session: 'office-test', commandIndex: 0, wait: true }])
  assert.equal(m.recognizeOfficeCommands('env HERDR_SESSION=custom herdr agent prompt backend hi', context)[0].session, 'custom')
  assert.equal(m.recognizeOfficeCommands('env -i herdr agent prompt backend hi', context)[0].session, 'default')
  assert.equal(m.recognizeOfficeCommands('env -u HERDR_SESSION herdr agent prompt backend hi', context)[0].session, 'default')
  assert.equal(m.recognizeOfficeCommands('herdr --session=office-test agent prompt backend hi', context)[0].session, 'office-test')
})

test('echo, comments, quoted documentation, heredocs and output are not commands', () => {
  for (const input of [
    `echo '${prompt}'`, `printf '%s' '${prompt}'`, `# ${prompt}`,
    `cat <<'DOC'\n${prompt}\nDOC`, `cat <<DOC\n${prompt}\nDOC`,
    `node -e 'const doc = "${prompt.replaceAll('"', '\\"')}"'`
  ]) assert.deepEqual(run(input, JSON.stringify(receipt())), [], input)
  assert.deepEqual(run('echo done', prompt + '\n' + JSON.stringify(receipt())), [])
  assert.equal(run(`${prompt} # documentation: herdr agent prompt reviewer x`)[0].kind, 'prompt_attempt')
})

test('dynamic shell targets, sessions, substitutions and unsupported control flow are not guessed', () => {
  for (const input of [
    'herdr agent prompt $TARGET hello', 'herdr --session "$SESSION" agent prompt backend hi',
    'HERDR_SESSION=$SESSION herdr agent prompt backend hi', 'herdr agent prompt backend "$(cat file)"',
    'herdr agent prompt backend `cat file`', 'if false; then herdr agent prompt backend hi; fi',
    'false || herdr agent prompt backend hi', `${prompt} | cat`, `${prompt} > out`,
    'eval "herdr agent prompt backend hi"', 'herdr agent prompt backend "unterminated'
  ]) assert.deepEqual(run(input, JSON.stringify(receipt())), [], input)
})

test('real Claude tool_use Bash + correlated tool_result confirms exactly one prompt', () => {
  const use = { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: prompt } }
  const result = { type: 'tool_result', tool_use_id: 'bash-1', content: [{ type: 'text', text: JSON.stringify(receipt()) }] }
  const events = m.analyzeToolCall({ id: use.id, name: use.name, input: use.input, output: result.content }, context)
  assert.deepEqual(events, [{ from: context.from, to: agent.id, kind: 'prompt', ts: context.observedAt,
    summary: 'Сообщение доставлено', commandIndex: 0, confidence: 'confirmed' }])
})

test('done/working, failure, blocked and wait timeout alone are only attempts', () => {
  for (const output of [undefined, 'done', { result: { agent_status: 'working' } },
    { id: 'cli:agent:prompt', error: { code: 'agent_blocked', message: 'blocked secret' } },
    { id: 'cli:agent:prompt', error: { code: 'timeout', message: 'wait timeout' } },
    { id: 'cli:agent:prompt', error: { code: 'agent_prompt_stalled' } },
    { id: 'cli:agent:get', result: { type: 'agent_prompted', agent: { pane_id: agent.paneId, name: agent.name } } }
  ]) assert.equal(run(prompt + ' --wait', output)[0].kind, 'prompt_attempt')
  const timeout = JSON.stringify({ id: 'cli:agent:prompt', error: { code: 'timeout' } })
  assert.equal(run(prompt + ' --wait', JSON.stringify(receipt()) + '\n' + timeout)[0].kind, 'prompt')
})

test('unknown targets/sessions and mismatched panes cannot make an agent link', () => {
  assert.equal(run('herdr agent prompt missing hi', JSON.stringify(receipt()))[0].to, null)
  const otherSession = run('herdr --session other agent prompt backend hi', JSON.stringify(receipt()))[0]
  assert.deepEqual([otherSession.kind, otherSession.to], ['prompt_attempt', null])
  assert.equal(run(prompt, JSON.stringify(receipt(reviewer)))[0].kind, 'prompt_attempt')
  assert.equal(run('herdr agent prompt w1:p2 hi', JSON.stringify(receipt()))[0].kind, 'prompt')
  const renamed = { ...context, resolveAgent: () => ({ ...agent, name: 'new-owner' }) }
  assert.equal(run(prompt, JSON.stringify(receipt()), 'Bash', renamed)[0].kind, 'prompt_attempt')
  const mixedSessions = `herdr --session other agent prompt backend hi; ${prompt}`
  assert.deepEqual(run(mixedSessions, JSON.stringify(receipt())).map((e) => e.kind), ['prompt_attempt', 'prompt_attempt'])
})

test('a result with a different tool call ID cannot confirm this command', () => {
  const result = { type: 'tool_result', tool_use_id: 'different-call', content: JSON.stringify(receipt()) }
  assert.equal(run(prompt, result)[0].kind, 'prompt_attempt')
  const codexResult = { type: 'function_call_output', call_id: 'different-call', output: JSON.stringify(receipt()) }
  assert.equal(run({ cmd: prompt }, codexResult, 'exec_command')[0].kind, 'prompt_attempt')
  assert.deepEqual(run({ cmd: prompt }, JSON.stringify(receipt()), 'unknown.exec_command'), [])
})

test('receipts are consumed once, repeated targets need an unambiguous result count', () => {
  const source = `${prompt}; ${prompt}`
  assert.deepEqual(run(source, JSON.stringify(receipt())).map((e) => e.kind), ['prompt_attempt', 'prompt_attempt'])
  assert.deepEqual(run(source, JSON.stringify(receipt()) + '\n' + JSON.stringify(receipt())).map((e) => [e.kind, e.commandIndex]), [['prompt', 0], ['prompt', 1]])
  const distinct = run(`${prompt}; herdr agent prompt reviewer hi`, JSON.stringify(receipt(reviewer)))
  assert.deepEqual(distinct.map((e) => e.kind), ['prompt_attempt', 'prompt'])
})

test('mixed output-producing chains cannot forge delivery evidence', () => {
  assert.equal(run(`echo '${JSON.stringify(receipt())}'; ${prompt}`, JSON.stringify(receipt()))[0].kind, 'prompt_attempt')
  assert.equal(run(prompt, `documentation: ${JSON.stringify(receipt())}`)[0].kind, 'prompt_attempt')
  assert.equal(run(prompt, JSON.stringify({ doc: receipt() }))[0].kind, 'prompt_attempt')
})

test('skipped exec and dynamic segments poison receipts for the entire chain', () => {
  const fake = JSON.stringify(receipt())
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
  for (const extra of [
    `exec printf '%s\\n' ${quote(fake)}`, `env FOO=bar exec echo ${quote(fake)}`,
    `printf '%s' "$FAKE_RECEIPT"`, `$PRINTER ${quote(fake)}`,
    'DYNAMIC=$VALUE herdr agent prompt reviewer hi',
    `bash -c ${quote(`exec printf '%s' ${quote(fake)}`)}`,
    `bash -c ${quote(`printf '%s' "$FAKE_RECEIPT"`)}`,
    `bash -c ${quote(`env DYNAMIC=$VALUE herdr agent prompt reviewer hi`)}`,
    `bash -c ${quote(`if false; then echo ${quote(fake)}; fi`)}`,
    'bash --unsupported', `bash -c ''`
  ]) {
    const source = `${prompt}; ${extra}`
    assert.equal(m.parseShellCommandChain(source).complete, false, source)
    assert.equal(run(source, fake)[0].kind, 'prompt_attempt', source)
    assert.deepEqual(m.extractOfficeToolEvidence('Bash', { command: source }, fake).results, [], source)
    const cached = { version: 1, input: { command: source }, results: [{ paneId: agent.paneId, name: agent.name }] }
    assert.equal(m.analyzeToolCall({ id: 'cached', name: 'Bash', evidence: cached }, context)[0].kind, 'prompt_attempt', source)
  }
})

test('fake exec/printf/echo/heredoc receipts never confirm through shell or exec JS wrappers', () => {
  const fake = JSON.stringify(receipt())
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
  const extras = [
    `exec printf '%s\\n' ${quote(fake)}`, `exec echo ${quote(fake)}`,
    `printf '%s' ${quote(fake)}`, `echo ${quote(fake)}`,
    `eval ${quote(`printf '%s' ${quote(fake)}`)}`, 'source /synthetic/receipt.sh', '. /synthetic/receipt.sh',
    `cat <<'RECEIPT'\n${fake}\nRECEIPT`,
    `printf '%s' $(echo ${quote(fake)})`, `printf '%s' \`echo ${quote(fake)}\``,
    `fake() { printf '%s' ${quote(fake)}; }; fake`
  ]
  const wrappers = [
    (source) => source,
    (source) => `bash -lc ${quote(source)}`,
    (source) => `env FOO=bar sh -c ${quote(source)}`,
    (source) => `bash -lc ${quote(`sh -c ${quote(source)}`)}`,
    (source) => `${prompt}; bash -c ${quote(source)}`,
    (source) => `${prompt}; sh -c ${quote(`bash -lc ${quote(source)}`)}`,
    (source) => `${prompt}; ${Array.from({ length: 6 }).reduce((s) => `sh -c ${quote(s)}`, source)}`
  ]
  for (const extra of extras) for (const wrap of wrappers) {
    const source = wrap(`${prompt}; ${extra}`)
    const code = `text(await tools.exec_command({cmd: ${JSON.stringify(source)}}));`
    for (const [name, input] of [['Bash', source], ['exec_command', { cmd: source }], ['shell', { command: ['bash', '-lc', source] }], ['exec', code]]) {
      const events = run(input, fake, name)
      assert.ok(events.every((e) => e.kind === 'prompt_attempt' && e.confidence === 'attempt'), `${name}: ${source}`)
    }
  }
  // A skipped JS shell source must also poison receipts for earlier shell calls.
  const code = `await tools.exec_command({cmd: ${JSON.stringify(prompt)}}); text(await tools.exec_command({cmd: ${JSON.stringify(`exec echo ${quote(fake)}`)}}));`
  assert.equal(run(code, fake, 'exec')[0].kind, 'prompt_attempt')
  // Supported pure nested wrappers still accept genuine correlated receipts.
  assert.equal(run(`bash -lc ${quote(`sh -c ${quote(prompt)}`)}`, fake)[0].kind, 'prompt')
})

test('Codex function_call arguments, shell argv, output wrappers and raw exec literals', () => {
  const output = JSON.stringify({ output: JSON.stringify(receipt()), metadata: { exit_code: 0 } })
  assert.equal(run(JSON.stringify({ cmd: prompt }), output, 'exec_command')[0].kind, 'prompt')
  assert.equal(run({ command: ['bash', '-lc', prompt] }, output, 'shell')[0].kind, 'prompt')
  assert.equal(run({ command: ['herdr', 'agent', 'prompt', 'backend', 'a b'] }, output, 'container.exec')[0].kind, 'prompt')
  const code = `const result = await tools.exec_command({cmd: ${JSON.stringify(prompt)}, yield_time_ms: 1000}); text(result.output);`
  assert.equal(run(code, output, 'exec')[0].kind, 'prompt')
  assert.equal(run(`text(await tools.exec_command({cmd: ${JSON.stringify(prompt)}}));`, output, 'exec')[0].kind, 'prompt')
  assert.equal(run({ code: `await tools.exec_command({cmd: ${JSON.stringify(prompt)}})` }, output, 'exec')[0].kind, 'prompt')
  assert.equal(run({ cmd: prompt }, `Chunk ID: a\nWall time: 0.1 seconds\nProcess exited with code 0\nFinal output:\n${JSON.stringify(receipt())}`, 'exec_command')[0].kind, 'prompt')
})

test('static JS promise calls and two receipts preserve both command indexes', () => {
  const code = `const results = await Promise.allSettled([tools.exec_command({cmd: ${JSON.stringify(prompt)}}), tools.exec_command({cmd: ${JSON.stringify(prompt)}})]); results.forEach(text);`
  const output = [{ type: 'text', text: JSON.stringify({ output: JSON.stringify(receipt()) }) }, { type: 'text', text: JSON.stringify({ output: JSON.stringify(receipt()) }) }]
  assert.deepEqual(run(code, output, 'exec').map((e) => [e.kind, e.commandIndex]), [['prompt', 0], ['prompt', 1]])
})

test('dynamic JS, interpolations, string lookalikes, dormant functions and conditions are rejected', () => {
  const literal = JSON.stringify(prompt)
  for (const code of [
    `// await tools.exec_command({cmd: ${literal}})`,
    `text('tools.exec_command({cmd: ${literal.replaceAll("'", "\\'")}})');`,
    `const docs = {cmd: ${literal}};`,
    'await tools.exec_command({cmd: `herdr agent prompt ${target} hi`})',
    `await tools.exec_command({cmd: ${literal} + suffix})`,
    `if (false) { await tools.exec_command({cmd: ${literal}}); }`,
    `async function later() { await tools.exec_command({cmd: ${literal}}); }`,
    `tools.exec_command({cmd: ${literal}})`,
    `const tools = await tools.exec_command({cmd: ${literal}});`,
    `await tools.exec_command({cmd: ${literal}, cmd: 'echo x'});`,
    `const r = await tools.exec_command({cmd: ${literal}, workdir: directory}); text(r);`,
    `await tools.exec_command({cmd: ${literal}}); text(${JSON.stringify(JSON.stringify(receipt()))});`
  ]) assert.deepEqual(run(code, JSON.stringify(receipt()), 'exec'), [], code)
  assert.deepEqual(m.commandsFromExecScript(`/* hidden */ await tools.exec_command({cmd: 'ssh pc'});`), ['ssh pc'])
})

test('evidence survives display truncation; candidate payloads contain no raw text', () => {
  const evidence = m.extractOfficeToolEvidence('Bash', { command: prompt }, 'x'.repeat(20000) + '\n' + JSON.stringify({ ...receipt(), secret: 'output-secret' }))
  assert.deepEqual(evidence.results, [{ paneId: agent.paneId, name: agent.name }])
  assert.ok(!JSON.stringify(evidence.results).includes('output-secret'))
  const tool = { id: 'tool1', kind: 'tool', name: 'Bash', category: 'command', title: 'display',
    status: 'done', commands: [prompt], output: 'truncated', officeEvidence: evidence, ts: 10 }
  const events = m.analyzeTranscriptTool(tool, context)
  assert.equal(events[0].kind, 'prompt')
  assert.equal(events[0].ts, 10)
  assert.ok(!JSON.stringify(events).includes('secret'))
  assert.deepEqual(m.analyzeTranscriptTool({ ...tool, officeEvidence: undefined }, context), [])
  assert.equal(m.analyzeTranscriptTool(tool, { ...context, from: null })[0].from, null)
})

test('actual Claude and Codex parsers preserve correlated receipts before output truncation', () => {
  const J = JSON.stringify
  const output = 'warning '.repeat(15000) + '\n' + J(receipt())
  const claude = new m.ClaudeParser()
  claude.feed([J({ type: 'assistant', uuid: 'a1', message: { content: [
    { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: prompt } }
  ] } })])
  assert.equal(m.analyzeTranscriptTool(claude.store.get('c1'), context)[0].kind, 'prompt_attempt')
  claude.feed([J({ type: 'user', uuid: 'u1', message: { content: [
    { type: 'tool_result', tool_use_id: 'unrelated', content: J(receipt()) }
  ] } })])
  assert.equal(m.analyzeTranscriptTool(claude.store.get('c1'), context)[0].kind, 'prompt_attempt')
  claude.feed([J({ type: 'user', uuid: 'u2', message: { content: [
    { type: 'tool_result', tool_use_id: 'c1', content: output }
  ] } })])
  const tool = claude.store.get('c1')
  assert.ok(tool.output.length < output.length)
  assert.ok(!tool.output.includes('agent_prompted'))
  assert.equal(m.analyzeTranscriptTool(tool, context)[0].kind, 'prompt')

  for (const [type, name, args] of [
    ['function_call', 'exec_command', { arguments: J({ cmd: prompt }) }],
    ['custom_tool_call', 'exec', { input: `text(await tools.exec_command({cmd: ${J(prompt)}}));` }],
    ['local_shell_call', 'shell', { action: { command: ['bash', '-lc', prompt] } }]
  ]) {
    const codex = new m.CodexParser()
    codex.feed([J({ type: 'response_item', payload: { type, call_id: 'call1', name, ...args } })])
    assert.equal(m.analyzeTranscriptTool(codex.store.get('call1'), context)[0].kind, 'prompt_attempt')
    const resultType = type === 'local_shell_call' ? 'local_shell_call_output' : `${type}_output`
    codex.feed([J({ type: 'response_item', payload: { type: resultType, call_id: 'call1', output: [
      { type: 'input_text', text: J({ output, metadata: { exit_code: 0 } }) }
    ] } })])
    assert.equal(m.analyzeTranscriptTool(codex.store.get('call1'), context)[0].kind, 'prompt', type)
  }
})

test('SSH only reports a launch attempt to known aliases, with options and configurable aliases', () => {
  for (const input of ['ssh pc', 'ssh -p 22 homeserver', 'ssh -o BatchMode=yes -i key pc uptime', 'ssh -p2222 -T pc']) {
    const events = run(input, 'connected successfully')
    assert.equal(events.length, 1)
    assert.equal(events[0].kind, 'ssh_attempt')
    assert.equal(events[0].confidence, 'attempt')
  }
  for (const input of ['echo ssh pc', 'ssh arbitrary', 'ssh user@pc', 'ssh $HOST', '# ssh homeserver']) assert.deepEqual(run(input), [])
  assert.equal(run('ssh builder', undefined, 'Bash', { ...context, sshAliases: ['builder'] })[0].to, 'machine:builder')
  assert.equal(run('ssh pc', undefined, 'Bash', { ...context, resolveMachine: undefined })[0].to, null)
})

test('board baseline is silent, IDs survive reorder/title/note edits', () => {
  const tasks = [{ id: 'a', title: 'Secret A', status: 'todo' }, { id: 'b', title: 'B', status: 'done' }]
  assert.deepEqual(m.diffTaskBoard(null, board(tasks), boardContext), [])
  assert.deepEqual(m.diffTaskBoard(board(tasks), board([{ ...tasks[1], notes: 'secret' }, { ...tasks[0], title: 'changed' }]), boardContext), [])
})

test('board creation, assignment, reassignment, unassignment and status use observed time', () => {
  const created = { id: 'a', title: 'secret task', status: 'todo', assignee: 'backend', since: 1, notes: 'secret note' }
  const events = m.diffTaskBoard(board([]), board([created]), boardContext)
  assert.deepEqual(events.map((e) => [e.kind, e.from, e.to, e.ts, e.confidence]), [
    ['task_created', boardContext.departmentId, null, context.observedAt, 'confirmed'],
    ['task_assigned', boardContext.departmentId, agent.id, context.observedAt, 'confirmed']
  ])
  assert.ok(!JSON.stringify(events).includes('secret'))
  const changed = m.diffTaskBoard(board([created]), board([{ ...created, assignee: 'reviewer', status: 'in_progress' }]), boardContext)
  assert.deepEqual(changed.map((e) => [e.kind, e.from, e.to]), [
    ['task_assigned', boardContext.departmentId, reviewer.id], ['task_status', boardContext.departmentId, reviewer.id]
  ])
  assert.equal(m.diffTaskBoard(board([created]), board([{ ...created, assignee: undefined }]), boardContext)[0].to, null)
  assert.equal(m.diffTaskBoard(board([]), board([{ ...created, assignee: 'missing' }]), boardContext)[1].to, null)
  assert.equal(m.diffTaskBoard(board([]), board([created]), { ...boardContext, author: 'user' })[1].from, 'user')
  assert.deepEqual(m.diffTaskBoard(board([created]), board([]), boardContext), [])
})

test('damaged board JSON keeps the last accepted snapshot, recovery diffs against it', () => {
  const previous = [{ id: 'a', title: 'A', status: 'todo' }]
  const bad = m.analyzeTaskBoardJson(previous, '{"tasks":[', boardContext)
  assert.equal(bad.snapshot, previous)
  assert.deepEqual(bad.events, [])
  assert.ok(bad.error)
  const good = m.analyzeTaskBoardJson(bad.snapshot, '{"tasks":[{"id":"a","title":"A","status":"done"}]}', boardContext)
  assert.deepEqual(good.events.map((e) => e.kind), ['task_status'])
  assert.deepEqual(m.diffTaskBoard(board(previous), board(previous, 'broken secret path'), boardContext), [])
  assert.equal(m.analyzeTaskBoard(previous, board([], 'broken'), boardContext).snapshot, previous)
  assert.deepEqual(m.analyzeTaskBoardJson(null, 'broken', boardContext).events, [])
})

test('duplicate task IDs do not create arbitrary changes', () => {
  const a = { id: 'a', title: 'A', status: 'todo' }
  assert.deepEqual(m.diffTaskBoard(board([]), board([a, { ...a, status: 'done' }]), boardContext), [])
  assert.deepEqual(m.diffTaskBoard(board([a, { ...a, status: 'done' }]), board([a]), boardContext), [])
})
