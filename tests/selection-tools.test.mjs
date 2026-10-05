import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(tmpdir(), 'drover-selection-'))
await build({ entryPoints: [join(root, 'src/renderer/src/selection-tools.ts')], bundle: true, format: 'cjs', platform: 'node', outfile: join(dir, 'm.cjs'), logLevel: 'silent' })
const m = createRequire(import.meta.url)(join(dir, 'm.cjs'))
const iife = await build({ entryPoints: [join(root, 'src/renderer/src/selection-tools.ts')], bundle: true, format: 'iife', globalName: 'Sel', write: false, logLevel: 'silent' })
rmSync(dir, { recursive: true })

const P = { clarifyInline: 'Уточни, пожалуйста: «{text}»', clarifyBlock: 'Уточни, пожалуйста:', explainInline: 'Объясни подробнее: «{text}»', explainBlock: 'Объясни подробнее:' }

test('short fragments become an inline clarify / explain draft with the caret at the end', () => {
  const d = m.draftFor('clarify', { text: 'бенч-колонки', code: false }, '', P)
  assert.equal(d.text, 'Уточни, пожалуйста: «бенч-колонки» ')
  assert.equal(d.caret, d.text.length)
  assert.equal(m.draftFor('explain', { text: 'emit', code: false }, '', P).text, 'Объясни подробнее: «emit» ')
})

test('long, multi-line and code fragments are quoted as a block; an existing draft is kept', () => {
  const multi = m.draftFor('clarify', { text: 'первая строка\nвторая строка', code: false }, 'мой текст  ', P)
  assert.equal(multi.text, 'мой текст\n\nУточни, пожалуйста:\n> первая строка\n> вторая строка\n\n')
  assert.equal(multi.caret, multi.text.length)
  const code = m.draftFor('explain', { text: 'const a = 1\n\nconst b = 2', code: true, lang: 'ts' }, '', P)
  assert.equal(code.text, 'Объясни подробнее:\n> ```ts\n> const a = 1\n>\n> const b = 2\n> ```\n\n')
  const long = 'x'.repeat(200)
  assert.ok(m.draftFor('clarify', { text: long, code: false }, '', P).text.startsWith('Уточни, пожалуйста:\n> x'))
})

test('quote goes to the start of the message, the caret right after it', () => {
  const q = m.draftFor('quote', { text: 'строка 1\nстрока 2', code: false }, '\n  уже написано', P)
  assert.equal(q.text, '> строка 1\n> строка 2\n\nуже написано')
  assert.equal(q.text.slice(0, q.caret), '> строка 1\n> строка 2\n\n')
  const fenced = m.quoteBlock({ text: 'a ``` b', code: true })
  assert.ok(fenced.startsWith('> ````'), 'the fence is longer than any backticks inside')
})

test('normalizeFragment trims, unifies newlines and collapses blank runs', () => {
  assert.equal(m.normalizeFragment('\r\n  a  \r\n\r\n\r\n\nb \n\n'), '  a\n\nb')
})

test('DOM: across messages, inside a code block, chrome excluded, outside → null (WebKit)', async (t) => {
  let webkit
  try { ({ webkit } = await import('playwright-core')) } catch { t.skip('playwright-core missing'); return }
  let browser
  try { browser = await webkit.launch() } catch { t.skip('WebKit is not installed'); return }
  try {
    const page = await browser.newPage()
    await page.setContent(`<div class="chat-scroll"><div class="chat-column">
      <div class="msg-user"><div class="bubble"><div class="bubble-text">Сделай API доски</div></div><time>12:00</time></div>
      <div class="msg-assistant"><div class="md"><p id="p1">Готово. Ниже код:</p>
        <div class="code-block"><div class="code-head"><span>ts</span><button class="copy-btn">Copy</button></div><pre><code class="language-ts">const a = 1
const b = 2</code></pre></div></div>
        <div class="msg-actions"><button class="copy-btn">Copy</button></div></div>
    </div></div><p id="outside">вне чата</p>`)
    await page.addScriptTag({ content: iife.outputFiles[0].text })
    const run = (fn) => page.evaluate(fn)
    const across = await run(() => {
      const r = document.createRange(); r.setStart(document.querySelector('.bubble-text').firstChild, 6); r.setEnd(document.querySelector('#p1').firstChild, 6)
      return Sel.extractSelection(r, document.querySelector('.chat-scroll'))
    })
    assert.deepEqual(across, { text: 'API доски\n\nГотово', code: false })
    const code = await run(() => {
      const t = document.querySelector('pre code').firstChild, r = document.createRange(); r.setStart(t, 0); r.setEnd(t, t.length)
      return Sel.extractSelection(r, document.querySelector('.chat-scroll'))
    })
    assert.deepEqual(code, { text: 'const a = 1\nconst b = 2', code: true, lang: 'ts' })
    const whole = await run(() => {
      const r = document.createRange(); r.selectNodeContents(document.querySelector('.chat-column'))
      return Sel.extractSelection(r, document.querySelector('.chat-scroll'))
    })
    assert.ok(!/Copy|12:00/.test(whole.text), 'buttons and times are not quoted')
    assert.ok(whole.text.includes('const b = 2'))
    const outside = await run(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector('#outside')); return Sel.extractSelection(r, document.querySelector('.chat-scroll')) })
    assert.equal(outside, null)
  } finally { await browser.close() }
})
