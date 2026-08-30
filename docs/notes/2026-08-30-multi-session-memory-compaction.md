# 2026-08-30 — 多会话、长期记忆、长对话压缩

## Problem

Three gaps between the workbench and daily use: one session per process (the
storage seam listed sessions but nothing consumed it), no long-term memory
(an agent that forgets everything between conversations), and long
conversations that walk into the context-window ceiling with no way to fold
history.

## Decision

- **多会话** — the workbench holds one *active* session and binds a fresh
  loop + presenter on every switch. Semantics split deliberately:
  `activate(id)` restores a stored session through the engine's fail-closed
  read; `createSession()` always brands a genuinely new log (never a
  restore). Sessions register in `datum_sessions` at creation — before any
  fact lands — and `listSessions` left-joins the registry so empty sessions
  list too. The `session/event` broadcast only reaches the live stream for
  the *active* session, and switching pushes a `session` SSE frame so all
  clients reload. `DELETE /api/sessions/:id` removes log + registry (deleting
  the active one activates the latest remaining, or brands a fresh one).
- **长期记忆** — memory is *authored* content, not derived state: a
  `MemoryStore` on the storage seam (upsert-by-key / list / remove;
  `datum_memories` in both engines, an ephemeral Map for engine-less runs).
  The workbench's memory composition is the reference plugin pattern:
  `remember` / `recall` tools for the model, plus a digest injected into
  every step's system prompt through the **pre-step waterfall** (refreshed
  before each submit — the waterfall is synchronous by kernel contract, so
  the async fetch happens at the edge and the injection stays sync).
- **长对话压缩** — a `context/compacted` persistent fact: when the log
  outgrows `compaction.maxEntries` (checked at turn start), the oldest
  `entries - keepRecent` facts are summarized by the model into the logged
  summary; `deriveMessages` replaces everything before the latest compaction
  with that summary and resumes from `keptFromSeq`. Model-visible ⟺ logged
  holds: the summarizer's *input* is a pure projection of this very log
  (reconstructable), its *output* is the logged summary. A failed
  summarization is named and the turn proceeds uncompacted (availability over
  silence). Policy lives in `AgentSpec.compaction` / workbench config
  (`enabled`, `maxEntries` 200, `keepRecent` 40) — no hardcoded tunables.

## Consequences

- The compaction event count moved the vocabulary to 15 persistent types;
  both fuzz payload builders gained the new member (the exhaustiveness
  checks forced it — twice).
- `openPersistentSessionLog` now returns `{ session, disposePersistence }`:
  switching sessions must drain in-flight writes before rebinding, the same
  discipline the close path already had.
- Verified against the real DeepSeek endpoint end to end: the model stored a
  preference via `remember` in session A, and a brand-new session B answered
  a question about that preference purely from the injected memory digest —
  no conversation history carried it.
- Memory is cross-session by scope and keyed by slug; scoping per agent or
  per user is a natural next extension once identities exist.
- Compaction is per-turn-entry-count today; token-based budgeting is the
  honest next step once usage numbers flow from adapters (they already
  return `usage`).
