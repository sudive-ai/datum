/**
 * Deep-freeze a value so no consumer can mutate it in place.
 *
 * Shared by the mock adapter (snapshots) — duplicated here rather than pulled
 * from datum-session to keep the seam packages decoupled.
 *
 * @param value — the value to freeze.
 * @returns the same value, deeply frozen.
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}
