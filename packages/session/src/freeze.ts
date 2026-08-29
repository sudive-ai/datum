/**
 * Deep-freeze a value so no consumer can mutate a logged fact in place.
 *
 * The log is the single source of truth; handing out mutable references to
 * entries would allow derived state and the log to drift apart. Frozen facts
 * make drift impossible instead of merely discouraged.
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
