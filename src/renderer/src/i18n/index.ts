// Minimal i18n: English source strings are the keys; other languages map them.
// Missing entries fall back to English. Plurals follow Intl.PluralRules.

import { de } from './de'
import { es } from './es'
import { ru } from './ru'
import { zh } from './zh'

export type Lang = 'en' | 'ru' | 'es' | 'de' | 'zh'
export type LangSetting = Lang | 'system'
export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string }
export type Dict = Record<string, string | PluralForms>

export const LANGUAGES: { id: Lang; name: string }[] = [
  { id: 'en', name: 'English' },
  { id: 'ru', name: 'Русский' },
  { id: 'es', name: 'Español' },
  { id: 'de', name: 'Deutsch' },
  { id: 'zh', name: '中文' }
]

const DICTS: Record<Lang, Dict> = { en: {}, ru, es, de, zh }
const LOCALES: Record<Lang, string> = { en: 'en-US', ru: 'ru-RU', es: 'es-ES', de: 'de-DE', zh: 'zh-CN' }

let current: Lang = 'en'
const plural = new Map<Lang, Intl.PluralRules>()

export function resolveLang(setting: LangSetting | undefined): Lang {
  if (setting && setting !== 'system') return setting
  const nav = (navigator.languages?.[0] ?? navigator.language ?? 'en').toLowerCase()
  const base = nav.split('-')[0] as Lang
  return base in DICTS ? base : 'en'
}

export function setLanguage(lang: Lang) {
  current = lang
  document.documentElement.lang = lang
}

export function language(): Lang {
  return current
}

export function locale(): string {
  return LOCALES[current]
}

function fill(s: string, params?: Record<string, string | number>): string {
  if (!params) return s
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (params[k] === undefined ? m : String(params[k])))
}

/** Translate an English UI string. `{name}` placeholders are filled from params. */
export function t(key: string, params?: Record<string, string | number>): string {
  const v = DICTS[current][key]
  return fill(typeof v === 'string' ? v : key, params)
}

/** Translate a counted phrase. English forms are given inline; `{n}` is the count. */
export function tp(forms: { one: string; other: string }, n: number, params?: Record<string, string | number>): string {
  let rules = plural.get(current)
  if (!rules) {
    rules = new Intl.PluralRules(LOCALES[current])
    plural.set(current, rules)
  }
  const cat = rules.select(n)
  const v = DICTS[current][forms.other]
  let s: string
  if (v && typeof v === 'object') s = v[cat] ?? v.other
  else if (typeof v === 'string') s = v
  else s = n === 1 ? forms.one : forms.other
  return fill(s, { n, ...params })
}
