# 2026-08-29 — M2 默认 harness（`@sudive-ai/datum-loop`）

## Problem

The runtime needs one reliable execution core: drive a user intent (turn) to a
terminal *logged* fact through repeated model calls and tool rounds (steps),
under cancellation, refusal, and failure — without ever storing state outside
the log, and without letting any listener write the terminal fact.

## Decision

- **`AgentSpec`** — an agent is a composition (name, system prompt, model,
  limits, options, surface), never runtime code. Domain behavior enters as
  plugins on the waterfalls and as registered tools.
- **`AgentLoop`** — turn/step state machine. One turn = `turn/start` …
  `turn/end` (written exactly once, by the loop only). One step = `step/start`
  → `request/header` + `request/context` → `assistant/chunk` +
  `assistant/message` → (`tool/call` + `tool/result` + feedback
  `user/message`)* → `step/end`.
- **Waterfalls**: `agent/pre-step` (rewrite the draft or veto → turn ends
  `blocked`, nothing requested) and `agent/request` (call configuration only —
  `RequestSpec` has no message-content field by construction). Kernel
  contract honored: `next()` takes no arguments; drafts mutate.
- **Model-visible ⟺ logged**: `request/context` persists `requestSurface()`
  — the exact request minus the AbortSignal. The gate test proves log and
  provider view are identical at request time.
- **Cancellation**: `cancel()` aborts the loop-owned `AbortController`; an
  aborted provider call classifies as `aborted` (the step logs
  `finishReason: cancelled`), never as a generic error.
- **Terminal authority**: `agent/turn-stopping` runs through the kernel's
  `serial` dispatch and carries no write duty; `turn/end` stays the loop's
  exclusive write, with a once-guard so a throwing stopping listener cannot
  duplicate the terminal fact.
- **Factory seam**: `setLoopFactory` swaps the entire harness (reversibly);
  the default harness is itself not privileged.
- **Tool feedback as model-visible input**: a tool result lands as a
  `user/message` with a `tool` source word, so `deriveMessages` carries it to
  the next request with zero extra machinery (a structured tool-result fold
  can replace the JSON text later without format change).

## Consequences

- All three M2 gates pass: cancel-leak (signal reaches the hanging await; the
  turn still ends `aborted`), rejection-trace (vetoed pre-step ⇒ `blocked`,
  no request facts), vocabulary gate (`request/context` == provider view).
- The M3 gates were re-run unchanged against the loop (mock adapter, tool
  round trip) — the layers compose without edits.
- Assistant messages now persist `ContentBlock`s (model output includes tool
  calls), so `ChatMessage.content` is `(Content | ContentBlock)[]`; the
  OpenAI adapter renders blocks it cannot map natively as bracketed text
  parts (provider-specific encoding is adapter detail; the logged surface
  stays the normalized language).
