// Mock-up data: three project sizes with synthetic agents, links and live events.
const ROLES = ['backend', 'frontend', 'devops', 'docs', 'reviewer', 'designer', 'general']
const KINDS = ['codex', 'claude', 'gemini', 'claude', 'codex', 'general']
const STATUS = ['working', 'working', 'idle', 'working', 'blocked', 'done', 'working', 'idle', 'unknown', 'working']

export function team(prefix, n, { lead = true, names = [] } = {}) {
  const out = []
  if (lead) out.push({ name: `${prefix}-lead`, kind: 'claude', role: 'lead', status: 'working', lead: true })
  for (let i = 0; out.length < n; i++) {
    const role = ROLES[i % ROLES.length]
    const name = names[i] ?? (i < ROLES.length ? `${prefix}-${role}` : `${prefix}-${role}-${Math.floor(i / ROLES.length) + 1}`)
    out.push({ name, kind: KINDS[i % KINDS.length], role, status: STATUS[i % STATUS.length] })
  }
  return out
}

export const SCENES = {
  s: {
    title: 'Маленький проект: тимлид и 3 агента',
    projects: [
      { name: 'drover', agents: team('drover', 4), tasks: [2, 1, 1] },
      { name: 'notes', agents: [{ name: 'notes-writer', kind: 'claude', role: 'docs', status: 'idle' }], tasks: [1, 0, 2] }
    ],
    machines: ['homeserver'],
    events: [
      { type: 'prompt', from: 'drover-lead', to: 'drover-frontend', t: 0.5 },
      { type: 'done', at: 'drover-devops', t: 0.35 }
    ],
    links: [{ from: 'drover-lead', to: 'drover-backend', weight: 3, recent: 0.9 }, { from: 'Вы', to: 'drover-lead', weight: 2, recent: 0.6, kind: 'user' }]
  },
  m: {
    title: 'Средний проект: 8 агентов + сосед',
    projects: [
      { name: 'drover', agents: team('drover', 8), tasks: [4, 3, 2] },
      { name: 'site', agents: team('site', 3), tasks: [1, 1, 3] }
    ],
    machines: ['pc', 'homeserver'],
    events: [
      { type: 'prompt', from: 'drover-lead', to: 'drover-designer', t: 0.55 },
      { type: 'prompt', from: 'drover-lead', to: 'drover-frontend', t: 0.97 },
      { type: 'attempt', from: 'drover-lead', to: 'drover-reviewer', t: 0.8 },
      { type: 'user_prompt', to: 'site-lead', t: 0.45 },
      { type: 'done', at: 'drover-docs', t: 0.3 },
      { type: 'ssh', from: 'drover-devops', to: 'homeserver', t: 0.2 },
      { type: 'board', from: 'site-backend', t: 0.6 }
    ],
    links: [
      { from: 'drover-lead', to: 'drover-backend', weight: 3, recent: 1 },
      { from: 'drover-lead', to: 'drover-docs', weight: 1, recent: 0.3 },
      { from: 'drover-backend', to: 'drover-frontend', weight: 2, recent: 0.6 },
      { from: 'Вы', to: 'drover-lead', weight: 2, recent: 0.7, kind: 'user' }
    ]
  },
  l: {
    title: 'Большой проект: 30 агентов',
    projects: [
      { name: 'drover', agents: team('drover', 30), tasks: [9, 6, 12] },
      { name: 'site', agents: team('site', 4), tasks: [1, 2, 2] }
    ],
    machines: ['pc', 'homeserver'],
    events: [
      { type: 'prompt', from: 'drover-lead', to: 'drover-frontend-3', t: 0.5 },
      { type: 'prompt', from: 'drover-lead', to: 'drover-backend-2', t: 0.3 },
      { type: 'attempt', from: 'drover-lead', to: 'drover-docs-3', t: 1 },
      { type: 'done', at: 'drover-devops-2', t: 0.3 },
      { type: 'ssh', from: 'drover-devops', to: 'pc', t: 0.6 },
      { type: 'user_prompt', to: 'drover-lead', t: 0.6 }
    ],
    links: [
      { from: 'drover-lead', to: 'drover-backend', weight: 3, recent: 1 },
      { from: 'drover-lead', to: 'drover-frontend', weight: 2, recent: 0.8 },
      { from: 'drover-backend', to: 'drover-backend-2', weight: 1, recent: 0.4 },
      { from: 'Вы', to: 'drover-lead', weight: 2, recent: 0.7, kind: 'user' }
    ]
  }
}
