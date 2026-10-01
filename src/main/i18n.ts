import { app } from 'electron'

// Native menu and notification strings. The renderer has its own, larger
// dictionaries; these few live in the main process.

type Lang = 'en' | 'ru' | 'es' | 'de' | 'zh'

const DICT: Record<Exclude<Lang, 'en'>, Record<string, string>> = {
  ru: {
    'Settings…': 'Настройки…',
    File: 'Файл',
    'New Agent…': 'Новый агент…',
    'New Project…': 'Новый проект…',
    'New Terminal Tab': 'Новая вкладка терминала',
    'Attach Files…': 'Прикрепить файлы…',
    Edit: 'Правка',
    'Find Thread…': 'Найти тред…',
    View: 'Вид',
    'Toggle Sidebar': 'Боковая панель',
    'Toggle Terminal Panel': 'Панель терминала',
    'Switch Chat / Terminal': 'Чат / терминал',
    'Toggle Preview': 'Превью сайта',
    'Pick Element in Preview': 'Выбрать элемент в превью',
    'Stop Agent': 'Остановить агента',
    Go: 'Переход',
    'Next Thread': 'Следующий тред',
    'Previous Thread': 'Предыдущий тред',
    'Next Needing Attention': 'Следующий, кто ждёт внимания',
    'Thread {n}': 'Тред {n}',
    'herdr Documentation': 'Документация herdr',
    'Show Window': 'Показать окно',
    '{name} finished': '{name} закончил',
    '{name} needs your input': '{name} ждёт вашего ответа'
  },
  es: {
    'Settings…': 'Ajustes…',
    File: 'Archivo',
    'New Agent…': 'Nuevo agente…',
    'New Project…': 'Nuevo proyecto…',
    'New Terminal Tab': 'Nueva pestaña de terminal',
    'Attach Files…': 'Adjuntar archivos…',
    Edit: 'Edición',
    'Find Thread…': 'Buscar hilo…',
    View: 'Ver',
    'Toggle Sidebar': 'Barra lateral',
    'Toggle Terminal Panel': 'Panel de terminal',
    'Switch Chat / Terminal': 'Chat / terminal',
    'Toggle Preview': 'Vista previa',
    'Pick Element in Preview': 'Elegir elemento en la vista previa',
    'Stop Agent': 'Detener agente',
    Go: 'Ir',
    'Next Thread': 'Hilo siguiente',
    'Previous Thread': 'Hilo anterior',
    'Next Needing Attention': 'Siguiente que requiere atención',
    'Thread {n}': 'Hilo {n}',
    'herdr Documentation': 'Documentación de herdr',
    'Show Window': 'Mostrar ventana',
    '{name} finished': '{name} ha terminado',
    '{name} needs your input': '{name} necesita tu respuesta'
  },
  de: {
    'Settings…': 'Einstellungen…',
    File: 'Ablage',
    'New Agent…': 'Neuer Agent…',
    'New Project…': 'Neues Projekt…',
    'New Terminal Tab': 'Neuer Terminal-Tab',
    'Attach Files…': 'Dateien anhängen…',
    Edit: 'Bearbeiten',
    'Find Thread…': 'Thread suchen…',
    View: 'Darstellung',
    'Toggle Sidebar': 'Seitenleiste',
    'Toggle Terminal Panel': 'Terminal-Bereich',
    'Switch Chat / Terminal': 'Chat / Terminal',
    'Toggle Preview': 'Vorschau',
    'Pick Element in Preview': 'Element in der Vorschau wählen',
    'Stop Agent': 'Agent stoppen',
    Go: 'Gehe zu',
    'Next Thread': 'Nächster Thread',
    'Previous Thread': 'Vorheriger Thread',
    'Next Needing Attention': 'Nächster, der Aufmerksamkeit braucht',
    'Thread {n}': 'Thread {n}',
    'herdr Documentation': 'herdr-Dokumentation',
    'Show Window': 'Fenster anzeigen',
    '{name} finished': '{name} ist fertig',
    '{name} needs your input': '{name} braucht deine Antwort'
  },
  zh: {
    'Settings…': '设置…',
    File: '文件',
    'New Agent…': '新建智能体…',
    'New Project…': '新建项目…',
    'New Terminal Tab': '新建终端标签页',
    'Attach Files…': '附加文件…',
    Edit: '编辑',
    'Find Thread…': '查找会话…',
    View: '视图',
    'Toggle Sidebar': '侧边栏',
    'Toggle Terminal Panel': '终端面板',
    'Switch Chat / Terminal': '聊天 / 终端',
    'Toggle Preview': '预览',
    'Pick Element in Preview': '在预览中选取元素',
    'Stop Agent': '停止智能体',
    Go: '前往',
    'Next Thread': '下一个会话',
    'Previous Thread': '上一个会话',
    'Next Needing Attention': '下一个需要处理的',
    'Thread {n}': '会话 {n}',
    'herdr Documentation': 'herdr 文档',
    'Show Window': '显示窗口',
    '{name} finished': '{name} 已完成',
    '{name} needs your input': '{name} 需要你的回复'
  }
}

let lang: Lang = 'en'

export function setMainLanguage(setting: string | undefined) {
  let l = setting && setting !== 'system' ? setting : app.getLocale().split('-')[0]
  if (!['en', 'ru', 'es', 'de', 'zh'].includes(l)) l = 'en'
  lang = l as Lang
}

export function mt(key: string, params?: Record<string, string | number>): string {
  const s = lang === 'en' ? key : DICT[lang][key] ?? key
  return params ? s.replace(/\{(\w+)\}/g, (m, k: string) => (params[k] === undefined ? m : String(params[k]))) : s
}
