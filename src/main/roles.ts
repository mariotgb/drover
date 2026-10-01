import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RoleTemplate } from '@shared/types'
import { toAgentName } from '@shared/agents'

// Project roles: markdown files describing a role, e.g. .ai/roles/frontend.md.
// The agent is told to read its file, so the file stays the source of truth.

const ROLE_DIRS = ['.ai/roles', '.herdr/roles']

function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---/)
  const out: Record<string, string> = {}
  if (!m) return out
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  }
  return out
}

function titleOf(text: string, fallback: string): string {
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '')
  const h = body.match(/^#\s+(.+)$/m)
  if (!h) return fallback
  return h[1].replace(/^role\s*[:—-]\s*/i, '').replace(/[*_`]/g, '').trim() || fallback
}

export async function discoverRoles(cwd: string): Promise<RoleTemplate[]> {
  const roles: RoleTemplate[] = []
  for (const dir of ROLE_DIRS) {
    let files: string[] = []
    try {
      files = (await readdir(join(cwd, dir))).filter((f) => f.endsWith('.md')).sort()
    } catch {
      continue
    }
    for (const f of files) {
      const rel = `${dir}/${f}`
      let text = ''
      try {
        text = await readFile(join(cwd, rel), 'utf8')
      } catch {
        continue
      }
      const fm = frontmatter(text)
      const base = f.replace(/\.md$/, '')
      const name = toAgentName(fm.name || base)
      if (roles.some((r) => r.name === name)) continue
      roles.push({
        id: `project:${rel}`,
        name,
        label: fm.label || fm.title || titleOf(text, base),
        kind: (fm.agent || fm.kind || '').toLowerCase(),
        args: fm.args || '',
        instructions: '',
        source: 'project',
        file: rel,
        orchestrator: /orchestr|lead|boss|manager|coordinator/i.test(base) || fm.orchestrator === 'true'
      })
    }
  }
  return roles
}
