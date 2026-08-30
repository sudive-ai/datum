/**
 * @sudive-ai/datum-tools — the Datum M3 capability seams.
 *
 * Every capability is a seam in three roles: a Definition (the interface a
 * consumer may rely on), Providers (at least two, so swapping is proven), and
 * Consumers (services on the context that never import a concrete provider).
 */

/** LLM seam Definition: normalized chat request/response and the adapter contract. */
export * from './llm/seam.ts'
/** LLM seam Consumer: `ctx.llm` with reversible adapter mounting. */
export * from './llm/service.ts'
/** LLM Provider: OpenAI-compatible REST adapter (real). */
export * from './llm/openai-compatible.ts'
/** LLM Provider: mock adapter with snapshot replay (test infrastructure). */
export * from './llm/mock.ts'
/** Tool registry: reversible capability registration, mounted as `ctx.tools`. */
export * from './tools/service.ts'
/** Execution seam Definition: exact-argv machine access. */
export * from './execution/seam.ts'
/** Execution Provider: local filesystem over exact argv, root-confinement policy. */
export * from './execution/fs-local.ts'
/** Execution Provider: local processes over exact argv, allowlist policy. */
export * from './execution/shell-local.ts'
