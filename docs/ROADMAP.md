# Datum Roadmap

Build order: each milestone delivers a runnable layer and a mechanical acceptance gate. No milestone starts before the previous gate passes.

## M1 — Kernel + Session (facts first)

Deliverable: the vendored L0 kernel — `vendor/cordis` → `@sudive-ai/cordis` (Context, Service+Inject, emit/waterfall events, Effect, Fiber lifecycle with hardening; see `vendor/README.md`) — and `@sudive-ai/datum-session` (append-only log, `deriveMessages()`, JSONL serialization, fail-closed load).

Acceptance gates:

- **Replay fuzz**: random operation sequences → append → serialize → reload → derived projection is byte-identical to the original process.
- **Fail-closed load**: a log containing an event type absent from `SessionEventMap` refuses to load with `SessionFormatUnsupportedError`; nothing is silently skipped.
- **Effect discipline**: teardown replays disposers in exact reverse order, exactly once; effect creation during teardown is rejected. Pinned by a Datum-side test against `@sudive-ai/cordis` (the vendored fiber hardening), not by reimplementation.

## M2 — Loop (reliable execution)

Deliverable: `@sudive-ai/datum-loop` — Agent contract, inbox (next-turn / next-step), turn/step state machine, cancellation, `pre-step` / `request` waterfalls, factory seam (`setFactory`).

Acceptance gates:

- **Cancel-leak test**: cancel while the mock LLM hangs; the AbortSignal reaches every pending await; no orphaned work survives.
- **Rejection leaves a trace**: a rejected pre-step closes the turn as `blocked` with the attempt recorded in the log.
- **Vocabulary gate**: any input reaching a model request without a corresponding log event fails the invariant check.

## M3 — Tools + seams (composable capabilities)

Deliverable: `@sudive-ai/datum-tools` registry, one LLM seam with two adapters (one real provider, one **mock adapter that is the primary test infrastructure**), one execution seam (fs or shell) with two providers.

Acceptance gates:

- **Swap test**: replace a provider without touching any consumer; all tests green.
- **Snapshot replay**: recorded sessions replay keylessly through the mock adapter; any model-visible behavior change must update the snapshot.

## M4 — Workbench core (projection + governance)

Deliverable: JSONL persistence, UI projection layer (pure presenters), approval / ask-user / commands chokepoints, per-agent scopes, permission presets.

Acceptance gates:

- **Live = replay**: for the same event sequence, live rendering and historical replay produce identical DOM snapshots.
- **Approval fail-closed**: with no approver mounted, guarded actions refuse with `unavailable`; nothing degrades into allow.
- **Chokepoint audit**: every governance decision (preset switch, approval, permission change) appears as a durable event.
