import { useSyncExternalStore } from 'react'

const query = window.matchMedia('(max-width: 480px)')
const subscribe = (fn: () => void) => {
  query.addEventListener('change', fn)
  return () => query.removeEventListener('change', fn)
}
export function useMobile() {
  return useSyncExternalStore(subscribe, () => query.matches)
}

export function useMobileWeb() {
  return useMobile() && !!window.droverRemote
}

/** Safari's layout viewport stays tall when its keyboard opens. */
export function trackMobileViewport() {
  const viewport = window.visualViewport
  const update = () => {
    const root = document.documentElement
    if (!query.matches) {
      root.style.removeProperty('--mobile-height')
      root.style.removeProperty('--mobile-top')
      root.classList.remove('keyboard-open')
      return
    }
    root.style.setProperty('--mobile-height', `${viewport?.height ?? window.innerHeight}px`)
    root.style.setProperty('--mobile-top', `${viewport?.offsetTop ?? 0}px`)
    // With the keyboard up the home indicator is hidden: no bottom safe-area gap above the keyboard.
    root.classList.toggle('keyboard-open', !!viewport && window.innerHeight - viewport.height > 120)
  }
  viewport?.addEventListener('resize', update)
  viewport?.addEventListener('scroll', update)
  window.addEventListener('resize', update)
  query.addEventListener('change', update)
  update()
}
