import { ArrowDown, ArrowUp, Circle, Flag, Star } from 'lucide-react'
import { PROJECT_IMPORTANCE, moveProjectOrder, projectFolders, projectImportance, type ProjectImportance } from '@shared/projects'
import type { WorkspaceGroup } from '../model'
import { getModel, updateSettings, useStore } from '../store'
import { t } from '../i18n'
import type { MenuItem } from './Menu'

export function importanceLabel(level: ProjectImportance): string {
  switch (level) {
    case 'primary': return t('Primary project')
    case 'important': return t('Important project')
    case 'background': return t('Background project')
    default: return t('Normal project')
  }
}

export function ProjectImportanceMarker({ group }: { group: WorkspaceGroup }) {
  const level = useStore(s => projectImportance(group.cwd, s.settings))
  if (level === 'normal') return null
  const Icon = level === 'primary' ? Star : level === 'important' ? Flag : Circle
  return <span className="project-importance-marker" data-importance={level} title={importanceLabel(level)} aria-label={importanceLabel(level)}><Icon size={13} /></span>
}

export function moveProject(source: string, target: string, after = false) {
  const settings = useStore.getState().settings
  const projectOrder = moveProjectOrder(getModel().groups, settings, source, target, after)
  if (projectOrder !== settings.projectOrder) void updateSettings({ projectOrder })
}

export function projectImportanceMenu(group: WorkspaceGroup): MenuItem[] {
  const settings = useStore.getState().settings
  const selected = projectImportance(group.cwd, settings)
  return [
    { header: t('Project importance') },
    ...PROJECT_IMPORTANCE.map(level => ({
      label: importanceLabel(level), hint: selected === level ? t('Selected') : undefined, disabled: !group.cwd,
      onClick: () => {
        if (!group.cwd) return
        const projectImportance = { ...useStore.getState().settings.projectImportance }
        if (level === 'normal') delete projectImportance[group.cwd]
        else projectImportance[group.cwd] = level
        void updateSettings({ projectImportance })
      }
    })),
    'separator',
    { label: t('Sort by importance'), disabled: !settings.projectOrder.length, onClick: () => { void updateSettings({ projectOrder: [] }) } }
  ]
}

/** Touch-friendly alternative to desktop drag and drop. */
export function ProjectOrderButtons({ group, disabled = false }: { group: WorkspaceGroup; disabled?: boolean }) {
  const folders = projectFolders(getModel().groups)
  const index = folders.indexOf(group.cwd ?? '')
  const move = (delta: number) => {
    const target = folders[index + delta]
    if (group.cwd && target) moveProject(group.cwd, target, delta > 0)
  }
  return <div className="project-order-buttons">
    <button type="button" className="icon-btn" aria-label={t('Move project up')} disabled={disabled || index <= 0} onClick={() => move(-1)}><ArrowUp size={18} /></button>
    <button type="button" className="icon-btn" aria-label={t('Move project down')} disabled={disabled || index < 0 || index >= folders.length - 1} onClick={() => move(1)}><ArrowDown size={18} /></button>
  </div>
}
