/**
 * @sudive-ai/datum-workbench — the Datum M4 workbench core.
 *
 * A local web workbench over the fixed language: config resolution is the one
 * explicit defaults step, the UI folds session events through a pure
 * presenter (live = replay), user plugins are plain cordis plugins resolved
 * from config, and approval-flagged tools sit behind a chokepoint that is
 * closed by default.
 */

/** Workbench config: schema, resolved shape, and the explicit resolve step. */
export * from './config.ts'
/** The pure presenter: session events → chat view (live and replay). */
export * from './presenter.ts'
/** The workbench server: HTTP + SSE, plugin loading, adapter mounting. */
export * from './server.ts'
/** The single static page. */
export * from './page.ts'
