# Datum Roadmap

Build order: each milestone delivers a runnable layer and a mechanical acceptance gate. No milestone starts before the previous gate passes. The near-term goal is a minimal runnable vertical: L0 kernel → L1 vocabulary → session facts → LLM seam → default harness → local web workbench, with user-authored plugins as the only way domain logic enters.

## L0 — Vendored kernel (done)

`vendor/*` — Cordis 4.0.0-rc.7 + plugin set, source-pinned (see `vendor/README.md`).

## L1 — Type vocabulary (语言，固定) — done

Deliverable: `@sudive-ai/datum-vocabulary` — the fixed language: the 12 core persistent session events with the fail-closed reader contract, the five word maps (declaration-merging vocabularies), the agent runtime events (`agent/*` + the `session/event` broadcast bridge), branded IDs, and the five dispatch modes pinned against kernel behavior.

Acceptance gates:

- **Vocabulary gate**: `KNOWN_SESSION_EVENT_TYPES` covers `SessionEventMap` exactly (compile-time assertion both directions); a log entry with an unknown type refuses with `SessionFormatUnsupportedError`.
- **Kernel pin**: all five dispatch modes exercised against a real kernel `Context`; the waterfall draft-mutation contract (`next()` takes no arguments) is pinned by test.
- **Nominality**: branded IDs are mutually non-assignable at compile time; derived word-map unions are exhaustive under `assertNever`; declaration merging of a word map is proven by a test-side augmentation.

## M1 — Session (facts first) — done

Deliverable: `@sudive-ai/datum-session` — append-only log, `deriveMessages()`, JSONL serialization, fail-closed load.

Acceptance gates:

- **Replay fuzz**: random operation sequences → append → serialize → reload → derived projection is byte-identical to the original process.
- **Fail-closed load**: a log containing an event type absent from `SessionEventMap` refuses to load with `SessionFormatUnsupportedError`; nothing is silently skipped.
- **Effect discipline**: teardown replays disposers in exact reverse order, exactly once; effect creation during teardown is rejected. Pinned by a Datum-side test against `@sudive-ai/cordis` (the vendored fiber hardening), not by reimplementation.

## M2 — Loop (reliable execution) — done

Deliverable: `@sudive-ai/datum-loop` — Agent contract, inbox (next-turn / next-step), turn/step state machine, cancellation, `pre-step` / `request` waterfalls, factory seam (`setFactory`).

Acceptance gates:

- **Cancel-leak test**: cancel while the mock LLM hangs; the AbortSignal reaches every pending await; no orphaned work survives.
- **Rejection leaves a trace**: a rejected pre-step closes the turn as `blocked` with the attempt recorded in the log.
- **Vocabulary gate**: any input reaching a model request without a corresponding log event fails the invariant check.

## M3 — Tools + seams (composable capabilities) — done

Deliverable: `@sudive-ai/datum-tools` registry, one LLM seam with two adapters (one real provider, one **mock adapter that is the primary test infrastructure**), one execution seam (fs or shell) with two providers.

Acceptance gates:

- **Swap test**: replace a provider without touching any consumer; all tests green.
- **Snapshot replay**: recorded sessions replay keylessly through the mock adapter; any model-visible behavior change must update the snapshot.

## M4 — Workbench core (projection + governance) — core landed; approval UI and durable governance events deferred

Deliverable: JSONL persistence, UI projection layer (pure presenters), approval / ask-user / commands chokepoints, per-agent scopes, permission presets.

Acceptance gates:

- **Live = replay**: for the same event sequence, live rendering and historical replay produce identical DOM snapshots.
- **Approval fail-closed**: with no approver mounted, guarded actions refuse with `unavailable`; nothing degrades into allow.
- **Chokepoint audit**: every governance decision (preset switch, approval, permission change) appears as a durable event.
