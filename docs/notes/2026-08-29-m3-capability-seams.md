# 2026-08-29 — M3 能力接缝（`@sudive-ai/datum-tools`）

## Problem

Capabilities (model calls, tools, machine access) must enter the runtime as
replaceable seams, not as baked-in features. The Definition/Provider/Consumer
discipline says a seam is complete only after one end-to-end provider swap
passes with zero consumer edits — so the LLM seam needs two providers from
day one: a real one and a mock that is the primary test infrastructure.

## Decision

- **LLM seam** — Definition: `LlmAdapter.chat(ChatRequest): Promise<ChatResponse>`
  with normalized types (`ChatRequest` carries exactly the model-visible
  surface; `ChatResponse` decodes into `ContentBlock`/`FinishReason` words).
  Consumer: `ctx.llm` (`LlmService`) with reversible `use(adapter)` mounting
  and a fail-loud "no adapter mounted". Providers:
  - `createOpenAICompatibleAdapter` — plain `fetch` against
    `{baseUrl}/chat/completions`, bearer from config (mounted from the
    environment by the workbench, never logged); injectable `fetch` for
    tests; unmapped finish reasons decode to an `error` word, never a silent
    fallback.
  - `MockAdapter` — scripted handler/ordered script plus **snapshot replay**:
    `record(request, response)` then keyless `chat(request)` returns the
    recorded response; an unseen request refuses loudly (model-visible changes
    must update the snapshot).
- **Tool registry** — `ctx.tools` (`ToolService`): reversible `register`
  returning a disposer, duplicate names refuse loudly, unknown lookups refuse
  loudly (the model is never shown an unexecutable tool), `view()` produces
  exactly the provider-facing `ToolView`.
- **Execution seam** — Definition only for now: `ExecutionAdapter.run` over
  *exact argv*; policy wrapping happens outside the seam, so what ran is
  always reconstructable. Providers (fs/shell) land with the workbench.

## Consequences

- The M3 swap gate passes: a consumer written against `ctx.llm.chat` follows
  any mounted adapter with zero edits.
- Snapshot replay needs no provider, no key, and no network — this becomes
  the backbone of keyless CI (the M2 loop gates run entirely on the mock).
- `ChatMessage` moved into the vocabulary (`messages.ts`): the seam, the
  session projection, and the loop all speak the same model-visible shape;
  `datum-session` re-exports it for convenience.
- The OpenAI adapter maps content words to provider *content parts*
  (`[{type:'text',text}]`), which keeps the door open for image blocks
  without a wire-shape change later.
