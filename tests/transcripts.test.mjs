import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './_bundle.mjs'

const m = await load()
const J = (o) => JSON.stringify(o)

test('claude: user text + image, tool call paired with result, turn duration', () => {
  const p = new m.ClaudeParser()
  p.feed([
    J({ type: 'user', uuid: 'u1', timestamp: '2026-09-30T10:00:00Z', cwd: '/repo', message: { role: 'user', content: [
      { type: 'text', text: '[Image #1] What is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
    ] } }),
    J({ type: 'assistant', uuid: 'a1', message: { model: 'claude-opus-5-5', content: [
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la', description: 'List files' } }
    ], usage: { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 5 } } }),
    J({ type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt\nb.txt' }] } }),
    J({ type: 'assistant', uuid: 'a2', message: { content: [{ type: 'tool_use', id: 'toolu_2', name: 'Edit', input: { file_path: '/repo/src/x.ts', old_string: 'a\nb', new_string: 'a\nc' } }] } }),
    J({ type: 'user', uuid: 'u3', toolUseResult: { filePath: '/repo/src/x.ts', structuredPatch: [{ oldStart: 1, newStart: 1, lines: [' a', '-b', '+c'] }] }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok' }] } }),
    J({ type: 'system', uuid: 's1', subtype: 'turn_duration', durationMs: 4200 }),
    J({ type: 'ai-title', aiTitle: 'Look at a screenshot' }),
    J({ type: 'user', uuid: 'meta', isMeta: true, message: { role: 'user', content: 'Base directory for this skill' } }),
    J({ type: 'assistant', uuid: 'side', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent noise' }] } })
  ])
  const items = p.store.items
  assert.deepEqual(items.map((i) => i.kind), ['user', 'assistant', 'tool', 'tool', 'event'])
  assert.equal(items[0].text, 'What is this?')
  assert.equal(items[0].images.length, 1)
  assert.match(items[0].images[0].src, /^data:image\/png;base64,/)
  const bash = items[2]
  assert.equal(bash.category, 'command')
  assert.equal(bash.title, 'List files')
  assert.equal(bash.status, 'done')
  assert.equal(bash.output, 'a.txt\nb.txt')
  const edit = items[3]
  assert.equal(edit.category, 'edit')
  assert.equal(edit.title, 'Edited src/x.ts')
  assert.equal(edit.diff[0].added, 1)
  assert.equal(edit.diff[0].removed, 1)
  assert.equal(items[4].variant, 'turn-end')
  assert.equal(items[4].durationMs, 4200)
  assert.equal(p.meta.title, 'Look at a screenshot')
  assert.equal(p.meta.model, 'claude-opus-5-5')
  assert.equal(p.meta.contextTokens, 1015)
})

test('claude: slash commands and interruptions', () => {
  const p = new m.ClaudeParser()
  p.feed([
    J({ type: 'user', uuid: 'c1', message: { role: 'user', content: '<command-name>/compact</command-name>\n<command-args></command-args>' } }),
    J({ type: 'assistant', uuid: 'a1', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }] } }),
    J({ type: 'user', uuid: 'i1', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } })
  ])
  const [cmd, tool, ev] = p.store.items
  assert.equal(cmd.command, '/compact')
  assert.equal(tool.status, 'error')
  assert.equal(ev.variant, 'interrupted')
})

test('claude: a message sent while Claude was busy shows up as the user’s', () => {
  const p = new m.ClaudeParser()
  p.feed([
    J({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'first task' } }),
    J({ type: 'queue-operation', operation: 'enqueue', content: 'second task' }),
    J({ type: 'queue-operation', operation: 'dequeue', content: 'second task' }),
    J({ type: 'attachment', uuid: 'q1', attachment: { type: 'queued_command', prompt: 'second task', commandMode: 'prompt', origin: { kind: 'human' }, humanTurn: true, timestamp: '2026-10-02T09:23:03.573Z' } }),
    J({ type: 'attachment', uuid: 'q2', attachment: { type: 'queued_command', prompt: 'done', origin: { kind: 'task-notification' } } }),
    J({ type: 'attachment', uuid: 'q3', attachment: { type: 'hook_success', content: 'ok' } })
  ])
  const users = p.store.items.filter((i) => i.kind === 'user')
  assert.deepEqual(users.map((u) => u.text), ['first task', 'second task'])
  assert.equal(users[1].ts, Date.parse('2026-10-02T09:23:03.573Z'))
})

test('codex: filters injected context, dedupes user turns, pairs exec calls', () => {
  const p = new m.CodexParser()
  const meta = { turn_id: 'T1' }
  p.feed([
    J({ type: 'session_meta', payload: { id: 'S1', cwd: '/repo' } }),
    J({ type: 'turn_context', payload: { turn_id: 'T1', model: 'gpt-6.1', cwd: '/repo' } }),
    J({ type: 'response_item', payload: { type: 'message', role: 'user', content: [
      { type: 'input_text', text: '# AGENTS.md instructions for /repo\n<INSTRUCTIONS>..</INSTRUCTIONS>' },
      { type: 'input_text', text: '<environment_context>\n<cwd>/repo</cwd>\n</environment_context>' }
    ], internal_chat_message_metadata_passthrough: meta } }),
    J({ type: 'response_item', payload: { type: 'message', role: 'user', content: [
      { type: 'input_text', text: '<image name=[Image #1] path="/tmp/a.png">' },
      { type: 'input_image', image_url: 'data:image/png;base64,BBBB' },
      { type: 'input_text', text: '</image>' },
      { type: 'input_text', text: '[Image #1] Fix the layout' }
    ], internal_chat_message_metadata_passthrough: meta } }),
    J({ type: 'event_msg', payload: { type: 'item_completed', turn_id: 'T1', item: { type: 'UserMessage', content: [
      { type: 'local_image', path: '/tmp/a.png' }, { type: 'text', text: '[Image #1] Fix the layout' }
    ] } } }),
    J({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Looking.' }] } }),
    J({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'await tools.exec_command({cmd:"rg -n layout src"}); await tools.exec_command({cmd:"cat src/app.css"})' } }),
    J({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'src/app.css:1:.layout' }] } }),
    J({ type: 'response_item', payload: { type: 'function_call', call_id: 'c2', name: 'shell', arguments: J({ command: ['bash', '-lc', 'npm test'] }) } }),
    J({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c2', output: J({ output: 'FAIL', metadata: { exit_code: 1 } }) } }),
    J({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c3', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: src/app.css\n@@\n-.a{}\n+.a{display:flex}\n*** End Patch' } }),
    J({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 900, output_tokens: 100 }, model_context_window: 10000 }, rate_limits: { primary: { used_percent: 12.5 } } } }),
    J({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'T1', duration_ms: 65000 } })
  ])
  const items = p.store.items
  const users = items.filter((i) => i.kind === 'user')
  assert.equal(users.length, 1, 'one user turn')
  assert.equal(users[0].text, 'Fix the layout')
  assert.equal(users[0].images.length, 1)
  const tools = items.filter((i) => i.kind === 'tool')
  assert.equal(tools[0].title, 'Ran 2 commands')
  assert.deepEqual(tools[0].commands, ['rg -n layout src', 'cat src/app.css'])
  assert.equal(tools[0].status, 'done')
  assert.equal(tools[1].title, 'npm test')
  assert.equal(tools[1].status, 'error')
  assert.equal(tools[1].output, 'FAIL')
  assert.equal(tools[2].category, 'edit')
  assert.equal(tools[2].diff[0].added, 1)
  assert.equal(tools[2].status, 'done', 'calls without output settle when the turn ends')
  const end = items[items.length - 1]
  assert.equal(end.variant, 'turn-end')
  assert.equal(end.durationMs, 65000)
  assert.equal(p.meta.contextTokens, 1000)
  assert.equal(p.meta.contextWindow, 10000)
  assert.equal(p.meta.model, 'gpt-6.1')
})

test('diff helpers', () => {
  const d = m.lineDiff('a\nb\nc', 'a\nB\nc')
  assert.equal(d.added, 1)
  assert.equal(d.removed, 1)
  assert.deepEqual(d.lines, [' a', '-b', '+B', ' c'])
  const files = m.parseApplyPatch('*** Begin Patch\n*** Add File: new.txt\n+hello\n*** Delete File: old.txt\n*** End Patch')
  assert.deepEqual(files.map((f) => [f.path, f.kind, f.added]), [['new.txt', 'add', 1], ['old.txt', 'delete', 0]])
})

test('claude: unwraps pasted_content wrappers from long pastes', () => {
  const p = new m.ClaudeParser()
  p.feed([J({ type: 'user', uuid: 'u1', message: { role: 'user', content: [
    { type: 'text', text: '[Image #1] <selected_element page="http://localhost:5199/">\nselector: #buy\n</selected_element>\n\n<pasted_content id="ab12">\n\n\nMake it bigger\n</pasted_content id="ab12">' }
  ] } })])
  const u = p.store.items[0]
  assert.equal(u.text, '<selected_element page="http://localhost:5199/">\nselector: #buy\n</selected_element>\n\nMake it bigger')
})
