import { useSyncExternalStore } from 'react'

const query = window.matchMedia('(max-width: 480px)')
const subscribe = (fn: () => void) => {
  query.addEventListener('change', fn)
  return () => query.removeEventListener('change', fn)
}
export function useMobile() {
  return useSyncExternalStore(subscribe, () => query.matches)
}

/** Safari's layout viewport stays tall when its keyboard opens. */
export function trackMobileViewport() {
  const viewport = window.visualViewport
  const update = () => {
    const root = document.documentElement
    if (!query.matches) {
      root.style.removeProperty('--mobile-height')
      root.style.removeProperty('--mobile-top')
      return
    }
    root.style.setProperty('--mobile-height', `${viewport?.height ?? window.innerHeight}px`)
    root.style.setProperty('--mobile-top', `${viewport?.offsetTop ?? 0}px`)
  }
  viewport?.addEventListener('resize', update)
  viewport?.addEventListener('scroll', update)
  window.addEventListener('resize', update)
  query.addEventListener('change', update)
  update()
}
