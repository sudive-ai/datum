# 2026-08-29 — M4 Web 工作台（`@sudive-ai/datum-workbench`）

## Problem

The vertical needs its user-facing form: a minimal runnable workbench where an
ordinary author combines **one config + plain plugins** into a domain
workbench, over a real LLM seam — while the governance red lines (approval
fail-closed, live = replay) hold mechanically.

## Decision

- **Config** (`config.ts`) — a schemastery schema validates everything
  deployment-varying (port, agent preset, LLM binding, plugin paths);
  `resolveWorkbenchConfig` is the single explicit resolution step.
  Misconfiguration fails at startup, before anything runs. API keys are
  referenced by *environment variable name* — never stored in config, never
  in the log.
- **Server** (`server.ts`) — `node:http` only. Mounts the LLM seam (mock for
  keyless demo / OpenAI-compatible for real models), the tool registry, one
  `SessionLog`, and the default harness; applies user plugins (plain cordis
  plugins, dynamic-imported and run via `ctx.plugin`); serves:
  `GET /` (the page), `GET /api/history` (replay projection),
  `GET /events` (SSE broadcast of `session/event`), `POST /api/messages`,
  `POST /api/cancel`, `GET /api/health`.
- **Presenter** (`presenter.ts`) — one pure fold from session events to the
  chat view, used by both live rendering and historical replay. The M4 gate
  test proves incremental folding over 400 fuzzed events equals full replay
  folding of the reloaded log — the UI has exactly one rendering path and
  cannot diverge from the log.
- **Approval chokepoint** — `ToolDefinition.requiresApproval` +
  `ToolService.execute` (the only sanctioned execution path; the loop goes
  through it). With no approver mounted, guarded tools refuse with
  `approval unavailable` — default deny, nothing degrades into allow; the
  workbench mounts an approver only as an explicit act.
- **Authoring surface** — `examples/hello-agent/`: `start.ts` (config) +
  `hello-plugin.ts` (a cordis plugin registering a tool, a pre-step persona,
  and an observer). `pnpm demo` runs it; the README states the whole
  authoring model: copy the folder, rename the agent, write your own tools.

## Consequences

- Every milestone gate now passes mechanically: L1 vocabulary
  (fail-closed + nominality + kernel pin), M1 session (replay fuzz,
  fail-closed load, effect discipline), M3 seams (provider swap, snapshot
  replay), M2 loop (cancel-leak, rejection trace, vocabulary gate), M4
  workbench (live = replay, approval fail-closed).
- The demo runs keyless on the mock provider; pointing it at a real
  OpenAI-compatible endpoint is a config change plus one exported
  environment variable.
- Deliberately deferred: JSONL file persistence of the demo session (the
  SessionLog already serializes; the workbench just doesn't mount a file
  writer yet), an approval UI surface (the chokepoint and its gate tests are
  in), and governance decisions as durable session events (needs an owner-side
  L1 vocabulary extension — the path is designed in the L1 note).
