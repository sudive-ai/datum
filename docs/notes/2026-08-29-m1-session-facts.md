# 2026-08-29 — M1 会话事实层（`@sudive-ai/datum-session`）

## Problem

The runtime needs its single source of truth: an append-only place where
every fact a session produces lands exactly once, in order, and from which
everything else — chat history today, UI projections and forks later — can be
recomputed. The layer must also make corruption loud: a log written by a
future or foreign vocabulary must refuse to load instead of degrading into a
partially-derived view.

## Decision

- **`SessionLog`** — the only writer. `append(type, payload)` assigns the
  gap-free monotonic `seq` (0-based), stamps epoch-ms `time`, validates the
  payload against the persisted JSON vocabulary with an explicit walk
  (`JSON.stringify` alone silently *drops* functions/`undefined`, which would
  persist a lossy fact), deep-freezes the entry, and broadcasts it as
  `session/event` on the mounted kernel context. No edit/delete path exists.
- **JSONL** — `serializeSessionLog` writes one envelope per line with a
  single trailing newline; `parseSessionLog` is the fail-closed reader: bad
  JSON, malformed envelopes, or a broken gap-free seq sequence refuse with
  `SessionFormatError`; an event type absent from the reader's vocabulary
  refuses with `SessionFormatUnsupportedError`. Nothing is skipped.
- **`deriveMessages`** — a pure fold over the entries producing the chat
  history (`user/message`, `assistant/message`). Chunk entries are not
  consulted (the assembled message references its chunks); lifecycle and tool
  events contribute nothing to the history. LLM-seam and tool folds land in
  M2/M3 on the same projection pattern.
- **Effect discipline is pinned, not reimplemented**: the M1 gate test drives
  the vendored kernel's fiber directly — teardown replays disposers in exact
  reverse order exactly once, effect creation on an inactive context throws
  (`cannot create effect on inactive context`), and child fibers unwind
  before their parent.

## Consequences

- The reader cannot type-validate payload *contents* against
  `SessionEventMap` at runtime (no schema compiler in L1); it validates
  envelope structure, seq continuity, and the event-type vocabulary. Payload
  schemas become a schemastery concern when governance needs them.
- `SessionEvent` is a distributive tagged union, so narrowing `event.type`
  narrows `payload` — projections need no casts.
- The append-time JSON walk means class instances, Maps, and Dates are
  rejected at the door; writers must serialize their facts into plain words
  before they become facts. This is the "model-visible ⟺ logged" invariant's
  storage-side half: nothing enters the log that the format cannot carry.
- Broadcast (`session/event`) is synchronous and happens before `append`
  returns, so persistence plugins and UI projections can rely on ordering
  (P4 will subscribe with exactly this guarantee).
