import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'

test('settings writes keep the latest optimistic order across late replies and failures', async t => {
  const executablePath = process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()
  if (!existsSync(executablePath)) { t.skip('Local Chromium is required for the store regression'); return }
  const root = mkdtempSync(join(tmpdir(), 'drover-settings-order-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  await build({ stdin: { contents: `
    export { useStore, updateSettings } from './src/renderer/src/store'
    export { DEFAULT_SETTINGS } from './src/shared/types'
  `, resolveDir: resolve('.'), loader: 'ts' }, bundle: true, platform: 'browser', format: 'iife', globalName: 'Fixture', outfile: join(root, 'store.js'), alias: { '@shared': resolve('src/shared') }, loader: { '.md': 'text', '.png': 'dataurl' }, logLevel: 'silent' })
  const browser = await chromium.launch({ executablePath, headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.setContent('<!doctype html><body></body>')
  await page.evaluate(() => {
    window.pending = []
    window.herdr = { setSettings: patch => new Promise((resolve, reject) => window.pending.push({ patch, resolve, reject })) }
  })
  await page.addScriptTag({ path: join(root, 'store.js') })

  for (const olderFails of [false, true]) {
    for (const olderFinishesFirst of [false, true]) {
      await t.test(`older ${olderFails ? 'failure' : 'reply'} ${olderFinishesFirst ? 'before' : 'after'} latest reply`, async () => {
        const result = await page.evaluate(async ({ olderFails, olderFinishesFirst }) => {
          pending.length = 0
          Fixture.useStore.setState({ settings: { ...Fixture.DEFAULT_SETTINGS, language: 'en' }, toasts: [] })
          const first = Fixture.updateSettings({ projectOrder: ['/a', '/b'], language: 'de' })
          const firstReply = { ...Fixture.useStore.getState().settings }
          const second = Fixture.updateSettings({ projectOrder: ['/b', '/a'], language: 'es' })
          const secondReply = { ...Fixture.useStore.getState().settings }
          const settleOlder = async () => {
            if (olderFails) pending[0].reject(new Error('old request failed'))
            else pending[0].resolve(firstReply)
            await first
          }
          const states = [Fixture.useStore.getState().settings.projectOrder]
          if (olderFinishesFirst) { await settleOlder(); states.push(Fixture.useStore.getState().settings.projectOrder) }
          pending[1].resolve(secondReply)
          await second
          if (!olderFinishesFirst) await settleOlder()
          states.push(Fixture.useStore.getState().settings.projectOrder)
          return { states, language: Fixture.useStore.getState().settings.language, toasts: Fixture.useStore.getState().toasts }
        }, { olderFails, olderFinishesFirst })
        for (const order of result.states) assert.deepEqual(order, ['/b', '/a'])
        assert.equal(result.language, 'es', 'a stale completion must not restore the old language')
        assert.deepEqual(result.toasts, [], 'a superseded failure must not report the latest save as failed')
      })
    }
  }

  await t.test('a failed latest write still rolls back and reports the error', async () => {
    const result = await page.evaluate(async () => {
      pending.length = 0
      Fixture.useStore.setState({ settings: { ...Fixture.DEFAULT_SETTINGS, projectOrder: ['/a', '/b'], language: 'en' }, toasts: [] })
      const write = Fixture.updateSettings({ projectOrder: ['/b', '/a'] })
      pending[0].reject(new Error('disk full'))
      await write
      return { order: Fixture.useStore.getState().settings.projectOrder, toasts: Fixture.useStore.getState().toasts }
    })
    assert.deepEqual(result.order, ['/a', '/b'])
    assert.equal(result.toasts.length, 1)
    assert.match(result.toasts[0].text, /disk full/)
  })
})
