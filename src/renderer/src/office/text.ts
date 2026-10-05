import type { OfficeState, OfficeUIEvent } from '@shared/office'
import { statusLabel } from './labels'
import { language, locale, t } from '../i18n'
const messages = {
  'All halls': ['Все залы', 'Alle Räume', 'Todas las salas', '所有大厅'],
  'My hall': ['К моему залу', 'Zu meinem Raum', 'Mi sala', '我的大厅'],
  'Links': ['Связи', 'Verbindungen', 'Conexiones', '联系'],
  'Team': ['Команда', 'Team', 'Equipo', '团队'],
  'Journal': ['Журнал', 'Protokoll', 'Registro', '日志'],
  'Map': ['Карта', 'Karte', 'Mapa', '地图'],
  'On map': ['На карте', 'Auf der Karte', 'En el mapa', '在地图上'],
  'Agent card': ['Карточка агента', 'Agentenkarte', 'Ficha del agente', '代理详情'],
  'Close card': ['Закрыть карточку', 'Karte schließen', 'Cerrar ficha', '关闭详情'],
  '{n} waiting': ['{n} ждут', '{n} warten', '{n} esperan', '{n} 等待'],
  'No events in 30 minutes': ['Нет событий за 30 минут', 'Keine Ereignisse in 30 Minuten', 'Sin eventos en 30 minutos', '30 分钟内无事件'],
  'No matching agents': ['Подходящих агентов нет', 'Keine passenden Agenten', 'No hay agentes coincidentes', '没有匹配的代理'],
  'Last task': ['Последняя задача', 'Letzte Aufgabe', 'Última tarea', '最近任务'],
  'No assigned task': ['Нет назначенной задачи', 'Keine zugewiesene Aufgabe', 'Sin tarea asignada', '没有分配的任务'],
  'Task sent': ['Задача отправлена', 'Aufgabe gesendet', 'Tarea enviada', '任务已发送'],
  'Not confirmed': ['Не подтверждено', 'Nicht bestätigt', 'Sin confirmar', '未确认'],
  'Task created': ['Задача создана', 'Aufgabe erstellt', 'Tarea creada', '任务已创建'],
  'Task assigned': ['Задача назначена', 'Aufgabe zugewiesen', 'Tarea asignada', '任务已分配'],
  'Task status changed': ['Статус задачи изменён', 'Aufgabenstatus geändert', 'Estado de tarea cambiado', '任务状态已更改'],
  'Input observed': ['Входящее сообщение · не подтверждено', 'Eingabe erkannt · nicht bestätigt', 'Entrada observada · sin confirmar', '已观察到输入 · 未确认'],
  'SSH attempt': ['Попытка SSH', 'SSH-Versuch', 'Intento SSH', 'SSH 尝试'],
  'Status changed': ['Статус изменён', 'Status geändert', 'Estado cambiado', '状态已更改'],
  'Hall filter': ['Фильтр залов', 'Raumfilter', 'Filtro de salas', '大厅筛选'],
  'Status filter': ['Фильтр статусов', 'Statusfilter', 'Filtro de estados', '状态筛选'],
  'Now': ['Сейчас', 'Jetzt', 'Ahora', '现在'],
  'Retry': ['Повторить', 'Erneut versuchen', 'Reintentar', '重试'],
  'Move camera on map': ['Переместить камеру по карте', 'Kamera auf der Karte bewegen', 'Mover cámara en el mapa', '在地图上移动相机'],
  'Reception': ['Приёмная', 'Empfang', 'Recepción', '接待处'],
  'Server room': ['Серверная', 'Serverraum', 'Sala de servidores', '服务器机房']
} as const
export type OfficeText = keyof typeof messages
const positions = { ru: 0, de: 1, es: 2, zh: 3 } as const
export function officeText(key: OfficeText, params?: Record<string, string | number>): string {
  const lang = language(), value = lang === 'en' ? key : messages[key][positions[lang]]
  return value.replace(/\{(\w+)\}/g, (all, name: string) => params?.[name] === undefined ? all : String(params[name]))
}
export function eventAge(ts: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - ts) / 1000))
  if (seconds < 2) return officeText('Now')
  const r = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto', style: 'short' })
  return seconds < 60 ? r.format(-seconds, 'second') : r.format(-Math.floor(seconds / 60), 'minute')
}
export const officeMessages = messages

/** The Russian summary is already a safe display template from the collector. */
export function journalText(event: OfficeUIEvent, state: OfficeState) {
  if (language() === 'ru') return event.summary
  const name = (id: string | null) => id === 'user' ? t('You') : state.agents.find(a => a.id === id)?.name || state.departments.find(d => d.id === id)?.name || state.externalNodes.find(n => n.id === id)?.name || t('Agent')
  const pair = `${name(event.from)} → ${name(event.to)}`
  switch (event.kind) {
    case 'prompt': case 'user_prompt': return `${pair} · ${officeText('Task sent')}`
    case 'prompt_attempt': return `${pair} · ${officeText('Not confirmed')}`
    case 'input_observed': return `${name(event.to)} · ${officeText('Input observed')}`
    case 'task_created': return `${name(event.from)} · ${officeText('Task created')}`
    case 'task_assigned': return `${event.to ? pair : name(event.from)} · ${officeText('Task assigned')}`
    case 'task_status': return `${name(event.to || event.from)} · ${officeText('Task status changed')}`
    case 'ssh_attempt': return `${pair} · ${officeText('SSH attempt')} · ${officeText('Not confirmed')}`
    case 'agent_status': return `${name(event.from)} · ${statusLabel(event.status ?? 'unknown')}`
    default: return event.summary
  }
}
