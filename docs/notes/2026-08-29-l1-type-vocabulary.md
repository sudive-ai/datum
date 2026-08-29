# 2026-08-29 — L1 类型词表（`@sudive-ai/datum-vocabulary`）

## Problem

The vendored kernel (L0) provides mechanics — context, services, effects, five
dispatch modes — but no domain language. Every higher layer (session, loop,
tools, workbench) needs one shared, fixed vocabulary for what a fact is, what
an identifier is, and which runtime events exist; without it each package
invents its own names and the "fail closed" reader contract has nothing to
check against.

## Decision

New package `packages/vocabulary/` → `@sudive-ai/datum-vocabulary`, the **L1
language layer**: types and contracts only, runtime surface deliberately
minimal (constants, one error class, two brand constructors). Members, pinned
to the DSH architecture map:

1. **Session Event Map — 12 core persistent events** (`session-events.ts`):
   `turn/start · turn/end · step/start · step/end · user/message ·
   assistant/chunk · assistant/message · tool/call · tool/result ·
   request/header · request/context · session/end-seed`.
   Envelope `{ seq, time, type, payload }`; payloads fully required
   (required-on-read); `SESSION_FORMAT_VERSION = 0`;
   `KNOWN_SESSION_EVENT_TYPES` is the reader's known set;
   `assertKnownSessionEventType` + `SessionFormatUnsupportedError` implement
   fail-closed reading (never skip unknown entries).
2. **Five word maps** (`vocabulary.ts`): `ContentMap · ContentBlockMap ·
   MessageSourceMap · FinishReasonMap · TurnEndReasonMap` — open interfaces
   extended by declaration merging; derived tagged unions (`WordOf`) close
   with `assertNever`, so a merged word surfaces as a compile error at every
   consumer that has not caught up.
3. **Agent runtime events** (`agent-events.ts`): `agent/session-start`,
   `agent/status`, `agent/inbox/next-turn`, `agent/inbox/next-step`,
   `agent/pre-step` (@mode waterfall), `agent/request` (@mode waterfall),
   `agent/request-error`, `agent/turn-stopping` (@mode serial), plus the
   `session/event` broadcast bridge (log → persistence/UI projections).
   Each declares its dispatch mode with an `@mode` JSDoc tag; the map merges
   into the kernel's `Events` interface, so `ctx.emit('agent/…')` is fully
   typed.
4. **Branded IDs** (`brand.ts`, `ids.ts`): `Branded<B, T = string>` phantom
   brands; `SessionId · TopCallId` (per the map) plus `TurnId · StepId ·
   MessageId · ToolCallId · EntrySeq`. Branded values stay primitives at
   runtime — serializable, comparable, wrapper-free.
5. **Five dispatch modes** (`dispatch.ts`): re-export of the kernel's
   `DispatchMode` + `DISPATCH_MODES` generated set + semantic classes
   (notification / interrogation / composition). Pinned against real kernel
   behavior by `test/dispatch.test.ts`.

**Model-visible ⟺ logged** is type-enforced where it bites first:
`RequestSpec` (the `agent/request` waterfall draft) deliberately has no
message-content field, and `request/context` is the logged counterpart of
whatever was actually sent.

## Consequences

- **Kernel waterfall contract discovered and pinned**: Cordis's
  `waterfall` composes listeners outermost-first around the innermost
  `next()`, but `next()` takes **no arguments** — value threading happens by
  mutating the draft object a listener received, never by passing values
  through `next()` (`test/dispatch.test.ts` pins this). Accordingly
  `StepSpec`/`RequestSpec` are mutable drafts (identity fields stay
  `readonly`), and a pre-step refusal is a returned `StepVeto`, closing the
  turn as `blocked`.
- **SessionEventMap extension is an owner-side act for now**: the
  compile-time coverage assertion (`KNOWN set ⇔ map keys`, both directions)
  lives in `session-events.ts`, so adding a member means editing the
  vocabulary package and regenerating the known set. The five word maps are
  the plugin-merging surface; if third parties ever need to add persistent
  event types without touching the owner, a `registerSessionEventType`
  runtime registry replaces the compile-time assertion (deferred until a
  concrete need).
- **Module augmentation caveat**: augmenting through a *re-export barrel*
  with a relative specifier does not merge; augmenting via the package
  specifier (resolving to the built `lib/index.d.ts`) does. Type-level tests
  therefore compile against the package name.
- **Test discipline**: runtime tests run on `node --test
  --experimental-strip-types` (per the CI convention), so all shipped source
  must stay *erasable* — no enums, namespaces, or parameter properties.
  Compile-time assertions live in `test/types.test-d.ts` and run under
  `pnpm typecheck` (`tsconfig.test.json`), not under `node --test`.
