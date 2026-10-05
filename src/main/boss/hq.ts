import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeBossFile } from './store'
import { BOSS_HELPER_SOURCE } from './helper'

export const HQ_START = '<!-- DROVER BOSS START -->'
export const HQ_END = '<!-- DROVER BOSS END -->'
const hash = (text: string) => createHash('sha256').update(text.trim()).digest('hex')

/** Replace only Drover's block. If a user edited inside it, retain their full
 * edited block as user content after the refreshed instructions too.
 */
export function mergeHqInstructions(current: string, template: string, version: string): string {
  const content = template.trim()
  const block = `${HQ_START}\n<!-- Drover ${version}; sha256:${hash(content)} -->\n${content}\n${HQ_END}`
  const start = current.indexOf(HQ_START), end = current.indexOf(HQ_END)
  if (start < 0 || end < start) return `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${block}\n`
  const previous = current.slice(start + HQ_START.length, end).trim()
  const metadata = previous.match(/^<!-- Drover ([^\n]+); sha256:([a-f0-9]{64}) -->\n([\s\S]*)$/)
  const edited = !metadata || hash(metadata[3]) !== metadata[2]
  const retained = edited ? `\n\n## Preserved user edits to HQ instructions\n\n${metadata?.[3] ?? previous}\n` : ''
  return current.slice(0, start) + block + current.slice(end + HQ_END.length) + retained
}

async function updateInstructions(file: string, template: string, version: string): Promise<void> {
  let current = ''
  try { current = await readFile(file, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const next = mergeHqInstructions(current, template, version)
  if (next !== current) await writeBossFile(file, next)
}

const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`

export async function provisionHq(folder: string, kind: string | null, template: string, version: string, executable: string): Promise<void> {
  await updateInstructions(join(folder, 'AGENTS.md'), template, version)
  for (const [agentKind, native] of [['claude', 'CLAUDE.md'], ['gemini', 'GEMINI.md']]) {
    const exists = await access(join(folder, native)).then(() => true, () => false)
    if (kind === agentKind || exists) await updateInstructions(join(folder, native), template + '\n\nAlso read AGENTS.md for user-authored HQ instructions.\n', version)
  }
  const helper = join(folder, 'bin', 'boss.cjs')
  await writeBossFile(helper, BOSS_HELPER_SOURCE)
  await writeBossFile(join(folder, 'bin', 'boss'), `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${quote(executable)} ${quote(helper)} "$@"\n`, 0o700)
}
