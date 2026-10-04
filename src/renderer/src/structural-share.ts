/** JSON-shaped state: reuse equal children, including nested metadata. */
export function structuralShare<T>(previous: T | undefined, next: T): T {
  if (Object.is(previous, next)) return previous as T
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object' || Array.isArray(previous) !== Array.isArray(next)) return next
  const before = previous as Record<string, unknown>
  const after = next as Record<string, unknown>
  const keys = Object.keys(after)
  let equal = keys.length === Object.keys(before).length
  const shared = (Array.isArray(next) ? [] : {}) as Record<string, unknown>
  for (const key of keys) {
    shared[key] = structuralShare(before[key], after[key])
    if (!Object.hasOwn(before, key) || shared[key] !== before[key]) equal = false
  }
  return (equal ? previous : shared) as T
}
