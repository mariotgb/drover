/** Capture the navigation action, including reselecting the same pane/board. */
export function isSidebarNavigation(target: EventTarget | null, key?: string): boolean {
  if (key !== undefined && key !== 'Enter') return false
  const element = target as Element | null
  if (typeof element?.closest !== 'function') return false
  return !!element.closest('.sidebar .thread') && !element.closest('button, a, input')
}
