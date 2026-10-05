import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'drover-boss-ui-'))
await build({
  entryPoints: ['src/renderer/src/boss.ts'], bundle: true, platform: 'node', format: 'cjs',
  outfile: join(dir, 'boss.cjs'), alias: { '@shared': resolve('src/shared') }, logLevel: 'silent'
})
const { defaultBossProjects, mergeBossDeliveries } = createRequire(import.meta.url)(join(dir, 'boss.cjs'))
rmSync(dir, { recursive: true, force: true })

test('quick broadcast defaults include enabled projects, with busy and missing leads visible, skipping blocked agents', () => {
  const p = (key, enabled, status) => ({ key, enabled, lead: status ? { status } : null })
  const projects = [p('idle', true, 'idle'), p('busy', true, 'working'), p('blocked', true, 'blocked'), p('empty', true), p('excluded', false, 'idle')]
  assert.deepEqual([...defaultBossProjects(projects)], ['idle', 'busy', 'empty'])
  assert.deepEqual([...defaultBossProjects([])], [])
})

test('delivery completion wins over an older queued IPC response and subsequent updates stay per assignment', () => {
  const queued = { id: 'a', projectKey: '/shop', status: 'queued' }
  const delivered = { ...queued, status: 'delivered' }
  const other = { id: 'b', projectKey: '/docs', status: 'blocked' }
  assert.deepEqual(mergeBossDeliveries([delivered, other], [queued]), [delivered, other])
  assert.deepEqual(mergeBossDeliveries([queued, other], [delivered]), [delivered, other])
  const newer = { id: 'c', projectKey: '/shop', status: 'queued' }
  assert.deepEqual(mergeBossDeliveries([delivered], [newer]), [delivered, newer])
})

test('a queue failure replaces queued status without erasing other project results', () => {
  const queued = { id: 'a', projectKey: '/shop', status: 'queued' }
  const done = { id: 'b', projectKey: '/docs', status: 'delivered' }
  const error = { ...queued, status: 'error', code: 'agent_gone', error: 'Agent exited' }
  assert.deepEqual(mergeBossDeliveries([queued, done], [error]), [error, done])
  assert.equal(queued.status, 'queued')
})
