# 2026-08-30 — 审批闭环、执行 provider、思维链与流式输出

## Problem

Four gaps between the runtime and a real agent platform: governance had a
chokepoint but no visible surface and no durable decisions; the execution seam
had a definition but no providers; DeepSeek's reasoning stream was discarded;
and model output arrived only as one post-hoc chunk, so replay fidelity and
live UX both suffered.

## Decision

- **审批闭环（governance you can see）**
  - L1 vocabulary owner-side extension: `approval/requested` +
    `approval/decided` join the persistent set (12 core + 2 governance = 14;
    the compile-time known-set ⇔ map-keys assertion forced the KNOWN list to
    move with it — the discipline working as designed).
  - The loop logs both facts around the chokepoint: `requested` before
    `tools.execute`, `decided` after — granted / denied / unavailable, with
    the approver's identity. Typed errors
    (`ApprovalUnavailableError` / `ApprovalDeniedError`) carry the semantics;
    the mounted approver names itself (`setGuard(guard, approver)`).
  - The workbench's `approval.mode = 'interactive'` mounts the UI as the
    approver: guarded tools open a case, SSE pushes an `approval` frame, the
    page renders a card with 批准/拒绝, `POST /api/approvals/:id` resolves it,
    and an `approval-decided` frame retires the card. Default stays `'closed'`
    (no approver → refuse).
- **执行接缝双 provider**
  - `createFsLocalAdapter({ root, readonly? })`: filesystem ops as exact argv
    (`read/list/stat/write/mkdir/rm`); the policy root confines every path,
    readonly refuses write-like ops — the sandbox wraps *outside* the seam.
  - `createShellLocalAdapter({ allow? })`: `spawn(argv[0], argv.slice(1))`
    with **no shell in between** — exact argv is the injection surface
    contract; optional binary allowlist; abort kills the child.
  - The M3 swap gate now passes on this seam too: one consumer, two
    providers, zero edits.
- **思维链入词表**: `thinking` joins `ContentBlockMap`, and the OpenAI adapter
  maps DeepSeek's `reasoning_content` (and `reasoning`) onto it, ahead of the
  text block — the model's whole visible output is logged, not just the answer.
- **真实流式输出**
  - Seam: optional `LlmAdapter.stream(request, onDelta)` with normalized
    `ChatDelta {kind: 'text'|'thinking'}`; `LlmService.stream` falls back to
    `chat` (no deltas) when the adapter cannot stream.
  - OpenAI adapter parses the SSE wire (`data:` lines, `[DONE]`, index-keyed
    tool-call fragment concatenation); the assembled response remains the
    single fact — deltas are the live view.
  - The loop logs every delta as its own `assistant/chunk` (monotonic
    chunkSeq) and the message references all of them; a non-streaming
    fallback still lands one chunk, so the chunk protocol is universal.
  - The presenter folds chunks into a growing partial bubble (…suffix) that
    the assembled message replaces.

## Consequences

- All four M4 governance behaviors are mechanical: interactive grant runs the
  tool, denial refuses it, closed mode logs `unavailable`, and every decision
  is a durable event.
- Streaming verified against the real DeepSeek endpoint: one turn produced
  103 individually logged deltas (32 thinking + 71 text), and the assembled
  message referenced all 103 chunkSeqs.
- Storage note: the engines' `payload` column stores the full envelope JSON
  (round-trip validated on load); the name is historical — treat it as the
  entry column.
- Known limitation carried forward: streamed tool-call fragments only
  concatenate string arguments; providers that stream structured tool deltas
  would need an adapter extension.
