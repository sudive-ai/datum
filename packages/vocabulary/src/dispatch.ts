import type { DispatchMode } from '@sudive-ai/cordis'

export type { DispatchMode } from '@sudive-ai/cordis'

/**
 * The five dispatch modes of the fixed language, as a generated set.
 *
 * This tuple is the single runtime source of truth for "which dispatch modes
 * exist"; the kernel implements them, and every agent event declares exactly
 * one of them via an `@mode` tag in its JSDoc. Tooling compares declared
 * modes against actual dispatch sites.
 */
export const DISPATCH_MODES = ['emit', 'parallel', 'serial', 'bail', 'waterfall'] as const satisfies readonly DispatchMode[]

/**
 * The semantic class of a dispatch mode — what a listener is allowed to mean.
 *
 * - `notification`: listeners observe; neither return values nor order can
 *   influence the emitter (`emit`, `parallel`).
 * - `interrogation`: listeners answer; the first meaningful answer wins and
 *   the rest are not consulted (`serial`, `bail`).
 * - `composition`: listeners wrap the caller's default behavior around the
 *   innermost `next()`; skipping `next()` owns the decision (`waterfall`).
 */
export type DispatchSemantics = 'notification' | 'interrogation' | 'composition'

/** The semantic class of each dispatch mode. */
export const DISPATCH_SEMANTICS: Record<DispatchMode, DispatchSemantics> = {
  emit: 'notification',
  parallel: 'notification',
  serial: 'interrogation',
  bail: 'interrogation',
  waterfall: 'composition',
}
