// Bundles the TypeScript modules under test into a temporary CommonJS file.
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export async function load() {
  const out = join(mkdtempSync(join(tmpdir(), 'drover-test-')), 'bundle.cjs')
  await build({
    stdin: {
      contents: `
        export { ClaudeParser } from './src/main/transcripts/claude'
        export { CodexParser } from './src/main/transcripts/codex'
        export { lineDiff, parseApplyPatch } from './src/main/transcripts/diff'
        export { codexLimitsFromLine } from './src/main/limits'
        export { installStatusline, uninstallStatusline, statuslineState, readClaudeStatusLimits, scriptContent } from './src/main/claudeStatusline'
        export { sendPrompt, createAgent } from './src/main/actions'
        export { HerdrApiError } from './src/shared/types'
      `,
      resolveDir: root,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: out,
    alias: { '@shared': join(root, 'src/shared') },
    logLevel: 'silent'
  })
  return createRequire(import.meta.url)(out)
}
