import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { Check } from 'lucide-react'
import { CLAUDE_EFFORTS, modelsFor, prettyModel, supportsModels, type ModelCatalog, type ModelChoice, type ModelOption } from '@shared/models'
import { t } from '../i18n'
import type { Thread } from '../model'
import { switchModel, useStore } from '../store'
import { Spinner } from './primitives'

const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

export function effortLabel(effort: string): string {
  switch (effort) {
    case 'none':
      return t('No reasoning')
    case 'minimal':
      return t('Minimal')
    case 'low':
      return t('Low')
    case 'medium':
      return t('Medium')
    case 'high':
      return t('High')
    case 'xhigh':
      return t('Extra high')
    case 'max':
      return t('Max')
    case 'ultra':
      return t('Ultra')
    default:
      return effort
  }
}

function describe(kind: string, m: ModelOption): string | undefined {
  if (kind !== 'claude') return m.description
  switch (m.id) {
    case 'opus':
      return t('For complex work and everyday tasks')
    case 'fable':
      return t('For the toughest challenges')
    case 'sonnet':
      return t('Efficient for simpler tasks')
    case 'haiku':
      return t('Fastest, for quick answers')
    default:
      return m.description
  }
}

/** Reasoning levels to offer: the model's own, or every level the agent knows. */
function effortsFor(kind: string, options: ModelOption[], model: string | null | undefined): string[] {
  const picked = model ? options.find((o) => o.id === model) : undefined
  if (picked) return picked.efforts
  if (kind === 'claude') return CLAUDE_EFFORTS
  const all = new Set(options.flatMap((o) => o.efforts))
  return EFFORT_ORDER.filter((e) => all.has(e))
}

/** Model and reasoning level selects for starting an agent. */
export function ModelFields({
  kind,
  value,
  onChange,
  compact,
  disabled
}: {
  kind: string | null
  value: ModelChoice
  onChange: (v: ModelChoice) => void
  compact?: boolean
  disabled?: boolean
}) {
  const catalog = useStore((s) => s.models)
  if (!supportsModels(kind)) return null
  const options = modelsFor(catalog, kind)
  const known = !value.model || options.some((o) => o.id === value.model)
  const efforts = effortsFor(kind, options, value.model)
  const setModel = (model: string) => {
    const next = effortsFor(kind, options, model)
    onChange({ model: model || null, effort: value.effort && next.includes(value.effort) ? value.effort : null })
  }
  return (
    <div className={clsx('model-fields', compact && 'compact')}>
      <select
        className="input select"
        value={value.model ?? ''}
        disabled={disabled}
        title={t('Model')}
        onChange={(e) => setModel(e.target.value)}
      >
        <option value="">{compact ? t('Default model') : t('Default (from the agent’s settings)')}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id} title={describe(kind, o)}>
            {compact ? o.label : `${o.label}${describe(kind, o) ? ' — ' + describe(kind, o) : ''}`}
          </option>
        ))}
        {!known && <option value={value.model!}>{value.model}</option>}
      </select>
      <select
        className="input select"
        value={value.effort ?? ''}
        disabled={disabled || efforts.length === 0}
        title={t('Reasoning')}
        onChange={(e) => onChange({ ...value, effort: e.target.value || null })}
      >
        <option value="">{t('Default reasoning')}</option>
        {efforts.map((e) => (
          <option key={e} value={e}>
            {effortLabel(e)}
          </option>
        ))}
      </select>
    </div>
  )
}

/** What the composer chip shows: the model picked in the chat, else what the transcript reports. */
export function shownModel(
  thread: Thread,
  meta: { model?: string; effort?: string } | null | undefined,
  picked: { label: string; effort?: string; base: string | null } | undefined,
  catalog: ModelCatalog | null
): string | null {
  if (picked && picked.base === (meta?.model ?? null)) return picked.effort ? `${picked.label} · ${picked.effort}` : picked.label
  if (!meta?.model) return null
  const label = modelsFor(catalog, thread.kind).find((o) => o.id === meta.model)?.label ?? prettyModel(meta.model)
  return meta.effort ? `${label} · ${effortLabel(meta.effort)}` : label
}

function isCurrent(kind: string, o: ModelOption, current: string | null): boolean {
  if (!current) return false
  if (kind === 'codex') return o.id === current
  return prettyModel(current).toLowerCase().startsWith(o.label.toLowerCase())
}

/** Popover over the composer chip: switch the running agent's model for this chat. */
export function ModelMenu({ thread, onClose }: { thread: Thread; onClose: () => void }) {
  const catalog = useStore((s) => s.models)
  const switching = useStore((s) => !!s.modelSwitching[thread.paneId])
  const meta = useStore((s) => s.transcripts[thread.paneId]?.meta ?? null)
  const kind = thread.kind ?? ''
  const options = useMemo(() => {
    const list = modelsFor(catalog, kind)
    return kind === 'claude' ? [{ id: 'default', label: t('Default model'), description: t('The one set in Claude Code’s own settings'), efforts: CLAUDE_EFFORTS }, ...list] : list
  }, [catalog, kind])
  const [model, setModel] = useState<string | null>(null)
  const [effort, setEffort] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const efforts = effortsFor(kind, options, model ?? (kind === 'codex' ? meta?.model : null))
  const busy = thread.status === 'working' || thread.status === 'blocked'

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  const apply = async () => {
    const picked = options.find((o) => o.id === model)
    const label = picked?.label ?? shownModel(thread, meta, undefined, catalog)?.split(' · ')[0] ?? ''
    const ok = await switchModel(thread, { model, effort: effort && efforts.includes(effort) ? effort : null }, {
      label,
      effort: effort ? effortLabel(effort) : undefined
    })
    if (ok) onClose()
  }

  return (
    <div className="model-menu" ref={ref} role="dialog" aria-label={t('Model for this chat')}>
      <div className="model-menu-head">{t('Model for this chat')}</div>
      <div className="model-menu-list">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            className={clsx('model-row', model === o.id && 'active')}
            onClick={() => {
              setModel(model === o.id ? null : o.id)
              if (effort && !effortsFor(kind, options, o.id).includes(effort)) setEffort(null)
            }}
          >
            <span className="model-row-name">
              {o.label}
              {isCurrent(kind, o, meta?.model ?? null) && <span className="model-row-now">{t('now')}</span>}
            </span>
            {describe(kind, o) && <span className="model-row-desc">{describe(kind, o)}</span>}
            {model === o.id && <Check size={14} className="model-row-check" />}
          </button>
        ))}
        {options.length === 0 && <div className="hint">{t('No models found. Start Codex once so it can fetch its model list.')}</div>}
      </div>
      {efforts.length > 0 && (
        <div className="model-menu-efforts">
          <span className="model-menu-label">{t('Reasoning')}</span>
          <div className="segmented small">
            {efforts.map((e) => (
              <button key={e} type="button" className={clsx(effort === e && 'active')} onClick={() => setEffort(effort === e ? null : e)}>
                {effortLabel(e)}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="model-menu-foot">
        <span className="model-menu-note">
          {busy ? t('The agent is busy. You can switch when it finishes.') : t('Only for this chat — your default model stays the same.')}
        </span>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || switching || (!model && !effort)} onClick={() => void apply()}>
          {switching ? <Spinner size={12} /> : null}
          {switching ? t('Switching…') : t('Switch')}
        </button>
      </div>
    </div>
  )
}
