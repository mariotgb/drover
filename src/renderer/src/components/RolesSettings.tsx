import { useState } from 'react'
import clsx from 'clsx'
import { ChevronRight, Crown, Plus, Sparkles, Trash2 } from 'lucide-react'
import { AGENT_NAME_RE, toAgentName } from '@shared/agents'
import type { RoleTemplate } from '@shared/types'
import { t } from '../i18n'
import { defaultInstructions, previewHint, starterRoles } from '../roles'
import { updateSettings, useStore } from '../store'
import { AgentAvatar } from './primitives'
import { supportsModels } from '@shared/models'
import { ModelFields } from './ModelPicker'

export function RolesSettingsPane() {
  const roles = useStore((s) => s.settings.roles)
  const kinds = useStore((s) => s.kinds)
  const hint = useStore((s) => s.settings.agentPreviewHint)
  const [open, setOpen] = useState<string | null>(null)
  const save = (next: RoleTemplate[]) => void updateSettings({ roles: next })
  const patch = (id: string, p: Partial<RoleTemplate>) => save(roles.map((r) => (r.id === id ? { ...r, ...p } : r)))
  const installed = kinds.filter((k) => k.installed)

  const add = () => {
    const id = `custom:${Date.now().toString(36)}`
    save([...roles, { id, name: 'agent', label: t('New role'), kind: installed[0]?.kind ?? 'claude', args: '', instructions: '', source: 'custom' }])
    setOpen(id)
  }

  const addStarters = () => {
    const have = new Set(roles.map((r) => r.name))
    const fresh = starterRoles()
      .filter((r) => !have.has(r.name))
      .map((r) => ({ ...r, id: `custom:${r.name}-${Date.now().toString(36)}` }))
    save([...roles, ...fresh])
  }

  return (
    <div className="settings-section">
      <p className="setting-hint block">
        {t('Roles are agent templates: which agent, its name, launch arguments and the instructions it gets right after it starts. Pick one in “New agent”, or start several at once with “Start team”.')}
      </p>
      <p className="setting-hint block">
        {t('Project roles are picked up automatically from markdown files in .ai/roles/ (or .herdr/roles/) of a project — the agent is told to read its file.')}
      </p>
      <div className="role-list">
        {roles.map((r) => {
          const isOpen = open === r.id
          const validName = AGENT_NAME_RE.test(r.name)
          return (
            <div key={r.id} className={clsx('role-card', isOpen && 'open')}>
              <button type="button" className="role-card-head" onClick={() => setOpen(isOpen ? null : r.id)}>
                <ChevronRight size={13} className={clsx('chev', isOpen && 'open')} />
                <AgentAvatar kind={r.kind} size={20} />
                <span className="role-card-label">{r.label}</span>
                {r.orchestrator && <Crown size={12} className="crown" />}
                <span className="role-card-name">{r.name}</span>
              </button>
              {isOpen && (
                <div className="role-card-body">
                  <div className="field-row">
                    <div className="field grow">
                      <label>{t('Label')}</label>
                      <input className="input" value={r.label} onChange={(e) => patch(r.id, { label: e.target.value })} />
                    </div>
                    <div className="field">
                      <label>{t('Agent name')}</label>
                      <input
                        className={clsx('input mono', !validName && 'invalid')}
                        value={r.name}
                        onChange={(e) => patch(r.id, { name: e.target.value.toLowerCase() })}
                        onBlur={() => !validName && patch(r.id, { name: toAgentName(r.name) })}
                        spellCheck={false}
                      />
                    </div>
                    <div className="field">
                      <label>{t('Agent')}</label>
                      <select className="input select" value={r.kind} onChange={(e) => patch(r.id, { kind: e.target.value, model: undefined, effort: undefined })}>
                        {(installed.length ? installed : kinds).map((k) => (
                          <option key={k.kind} value={k.kind}>
                            {k.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {supportsModels(r.kind) && (
                    <div className="field">
                      <label>{t('Model')}</label>
                      <ModelFields
                        kind={r.kind}
                        value={{ model: r.model || null, effort: r.effort || null }}
                        onChange={(v) => patch(r.id, { model: v.model || undefined, effort: v.effort || undefined })}
                      />
                    </div>
                  )}
                  <div className="field">
                    <label>{t('Launch arguments')}</label>
                    <input className="input mono" value={r.args} onChange={(e) => patch(r.id, { args: e.target.value })} spellCheck={false} />
                  </div>
                  <div className="field">
                    <label>{t('Instructions')}</label>
                    <textarea
                      className="input"
                      rows={4}
                      value={r.instructions}
                      placeholder={defaultInstructions(r)}
                      onChange={(e) => patch(r.id, { instructions: e.target.value })}
                    />
                  </div>
                  <div className="role-card-foot">
                    <label className="check small">
                      <input type="checkbox" checked={!!r.orchestrator} onChange={(e) => patch(r.id, { orchestrator: e.target.checked })} />
                      <Crown size={12} /> {t('Orchestrator — gets the list of the team and how to reach it')}
                    </label>
                    <button type="button" className="btn btn-sm" onClick={() => save(roles.filter((x) => x.id !== r.id))}>
                      <Trash2 size={13} /> {t('Delete')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
        {!roles.length && <div className="hint">{t('No roles of your own yet.')}</div>}
      </div>
      <div className="appearance-actions">
        <button type="button" className="btn btn-sm" onClick={add}>
          <Plus size={13} /> {t('Add role')}
        </button>
        <button type="button" className="btn btn-sm" onClick={addStarters}>
          <Sparkles size={13} /> {t('Add starter roles')}
        </button>
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">{t('Tell agents about the preview panel')}</div>
          <div className="setting-hint">{previewHint()}</div>
        </div>
        <button type="button" role="switch" aria-checked={hint} className={clsx('toggle', hint && 'on')} onClick={() => void updateSettings({ agentPreviewHint: !hint })}>
          <span />
        </button>
      </div>
    </div>
  )
}
