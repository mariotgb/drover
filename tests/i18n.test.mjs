import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(f)) out.push(p)
  }
  return out
}

/** Every English key used by the UI: t('…'), tp({ one, other }), slash descriptions, tool titles. */
function usedKeys() {
  const SQ = String.raw`'((?:[^'\\]|\\.)*)'`
  const keys = new Set()
  for (const f of walk(join(root, 'src/renderer/src'))) {
    if (f.includes('/i18n/')) continue
    const s = readFileSync(f, 'utf8')
    for (const m of s.matchAll(new RegExp(String.raw`\bt\(\s*` + SQ, 'g'))) keys.add(m[1].replace(/\\'/g, "'"))
    for (const m of s.matchAll(new RegExp(String.raw`\btp\(\s*\{\s*one:\s*` + SQ + String.raw`,\s*other:\s*` + SQ, 'g'))) keys.add(m[2])
    for (const m of s.matchAll(new RegExp(String.raw`desc:\s*` + SQ, 'g'))) keys.add(m[1])
  }
  for (const f of walk(join(root, 'src/main/transcripts'))) {
    const s = readFileSync(f, 'utf8')
    for (const m of s.matchAll(new RegExp(String.raw`\bT\(\s*` + SQ, 'g'))) keys.add(m[1])
  }
  return [...keys].filter((k) => /[A-Za-z]/.test(k))
}

async function dictionaries() {
  const out = join(mkdtempSync(join(tmpdir(), 'herdr-i18n-')), 'dicts.cjs')
  await build({
    stdin: { contents: "export { ru } from './ru'\nexport { es } from './es'\nexport { de } from './de'\nexport { zh } from './zh'", resolveDir: join(root, 'src/renderer/src/i18n'), loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent'
  })
  return createRequire(import.meta.url)(out)
}

test('every UI string is translated in every language', async () => {
  const keys = usedKeys()
  assert.ok(keys.length > 300, `found ${keys.length} keys`)
  const dicts = await dictionaries()
  for (const [lang, dict] of Object.entries(dicts)) {
    const missing = keys.filter((k) => !(k in dict))
    assert.deepEqual(missing, [], `${lang} is missing ${missing.length} strings`)
    for (const k of keys) {
      const want = new Set([...k.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))
      const v = dict[k]
      for (const form of typeof v === 'string' ? [v] : Object.values(v)) {
        const got = new Set([...form.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))
        for (const p of got) assert.ok(want.has(p) || p === 'n', `${lang}: unknown placeholder {${p}} in “${k}”`)
      }
    }
  }
})
