import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { chromium } from 'playwright-core'

// A dialog Drover detected in an agent's terminal: one answer per click, never a duplicate,
// and a fresh question re-enables the choices.
test('question card answers once per explicit click and resets for a new question', async t => {
  const executablePath = process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()
  if (!existsSync(executablePath)) { t.skip('Local Chromium is required for the UI regression'); return }
  const root = mkdtempSync(join(tmpdir(), 'drover-question-ui-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  await build({ stdin: { resolveDir: resolve('.'), loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client'
    import { useState } from 'react'
    import { QuestionCard } from './src/renderer/src/components/AgentQuestion'
    const q = (id, n) => ({ id, kind: 'codex', question: 'Allow ' + id + '?', choices: Array.from({ length: n }, (_, i) => ({ id: 'c' + i, label: 'Choice ' + i })), detectedAt: 1 })
    function Root() {
      const [question, setQuestion] = useState(q('q1', 3))
      window.nextQuestion = () => setQuestion(q('q2', 2))
      window.sameQuestionAgain = () => setQuestion({ ...question })
      return <QuestionCard thread={{ paneId: 'p1', name: 'agent', status: 'blocked', pane: { pane_id: 'p1', agent_question: question } }} />
    }
    createRoot(document.getElementById('root')).render(<Root/>)
  ` }, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', outfile: join(root, 'fixture.js'), alias: { '@shared': resolve('src/shared') }, logLevel: 'silent', plugins: [{ name: 'fake-api', setup(b) {
    b.onResolve({ filter: /(?:^|\/)api$/ }, () => ({ path: 'api', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `
      window.calls = []
      export const api = { answerAgentQuestion: async req => { window.calls.push(req); await new Promise(r => setTimeout(r, 120)); return window.answerResult ?? { ok: true } } }
      export const errorText = e => String(e?.message ?? e)
      export const isRemote = false
    ` }))
  } }] })
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html')
    res.end(req.url === '/fixture.js' ? readFileSync(join(root, 'fixture.js')) : '<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)))
  const browser = await chromium.launch({ executablePath, headless: true }); t.after(() => browser.close())
  const page = await browser.newPage()
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  await page.goto('http://127.0.0.1:' + server.address().port)
  const choices = page.locator('.aq-choice')
  await choices.first().waitFor()
  assert.equal(await choices.count(), 3)
  assert.equal(await page.evaluate(() => window.calls.length), 0, 'nothing is sent without a click')

  // A double click sends one answer with the exact ids, then the choices stay locked.
  await page.evaluate(() => { const b = document.querySelectorAll('.aq-choice')[1]; b.click(); b.click() })
  await page.locator('.aq-note.ok').waitFor()
  assert.deepEqual(await page.evaluate(() => window.calls), [{ paneId: 'p1', questionId: 'q1', choiceId: 'c1' }])
  assert.equal(await choices.nth(0).isDisabled(), true)
  await page.evaluate(() => window.sameQuestionAgain())
  assert.equal(await choices.nth(0).isDisabled(), true, 'the same question stays answered across snapshots')

  // A new question unlocks the card.
  await page.evaluate(() => window.nextQuestion())
  await page.waitForFunction(() => document.querySelectorAll('.aq-choice').length === 2)
  assert.equal(await choices.nth(0).isDisabled(), false)
  assert.equal(await page.locator('.aq-note.ok').count(), 0)

  // A refused answer says why and allows another try.
  await page.evaluate(() => { window.answerResult = { ok: false, code: 'question_changed' } })
  await choices.nth(0).click()
  await page.locator('.aq-note.bad').waitFor()
  assert.match(await page.locator('.aq-note.bad').textContent(), /question changed/)
  assert.equal(await choices.nth(0).isDisabled(), false)
  assert.deepEqual(errors, [])
})
