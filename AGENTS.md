# AGENTS.md

Datum — an event-sourced agent runtime and workbench core. Read `README.md` for the design pillars; read `docs/ROADMAP.md` before adding packages or changing build order.

## Layout

```
vendor/          L0 framework layer, source-vendored and pinned (see vendor/README.md)
  cordis/        @sudive-ai/cordis — Context / Service+Inject / Events / Effect / Fiber
  cosmokit/      @sudive-ai/cosmokit — foundation utilities
  schemastery/   @sudive-ai/schemastery — config schema
  loader,hmr,include,group,timer,logger-console/   @sudive-ai/cordis-plugin-*
packages/        @sudive-ai/datum-* packages land here in ROADMAP order
  vocabulary/    L1 type vocabulary — the fixed language (session events, word maps,
                 agent events, branded IDs, dispatch modes); extend by declaration merging
  session/       M1 append-only session facts; fail-closed JSONL reader
  tools/         M3 capability seams: LLM adapter seam, tool registry, execution seam
  loop/          M2 default harness: turn/step machine, waterfalls, cancellation
  workbench/     M4 local web workbench: HTTP+SSE, config resolution, user plugins
  storage/       storage seam: SQLite (default local, node:sqlite) + PostgreSQL (postgres.js);
                 sessions, session events, and long-term memory; reads go through
                 the session package's fail-closed envelope validation
examples/        authoring examples (hello-agent) — the model for domain workbenches
docs/            roadmap and design notes
```

Package naming: everything under `packages/` is `@sudive-ai/datum-<layer>` (e.g. `@sudive-ai/datum-session`, `@sudive-ai/datum-core`); the `@sudive-ai/*` names without the `datum-` prefix are reserved for the vendored framework layer in `vendor/`, so a package name tells you at a glance whether it is owned code or pinned upstream source.

The L0 kernel is **vendored Cordis, not hand-written**: `vendor/*/src` is upstream source and must not be edited casually — every divergence is logged in `vendor/README.md`. Higher layers extend the kernel by declaration merging and composition, never by patching it.

## Commands

```sh
pnpm install     # pnpm workspaces, node >= 22
pnpm build       # tsc -b across all packages
pnpm clean       # remove build outputs
```

## Non-negotiable invariants

- **ESM everywhere** (`"type": "module"`), TypeScript `strict`, bundler resolution, `.ts` specifiers in local relative imports (rewritten to `.js` at emit).
- **Registrations are reversible**: every registration API returns a disposer; there is no irreversible registration API. Teardown is reverse-order and exactly-once. Enforced by the vendored kernel's effect/fiber discipline (`vendor/cordis`), not reimplemented per package.
- **The log is the single source of truth**: never store a second copy of derived state next to the log; projections fold from events.
- **Model-visible ⟺ logged**: anything that reaches a model request must be reconstructable from the log; a new model-visible input requires a new event type in `SessionEventMap`.
- **Fail closed on read**: a reader that meets an event type absent from the vocabulary refuses the log (`SessionFormatUnsupportedError`); never skip unknown events.
- **Fail loud**: misconfiguration fails at the earliest resolvable point; no silent fallbacks, no swallowing without naming what was swallowed and why.
- **Explicit > implicit**: defaults are an explicit `resolve(request): Spec` step owned by the implementation, never a hidden `?? default` inside `run()`.
- **Branded IDs** (`Branded<B>`) for every identifier crossing a package boundary.
- **Seams are three roles**: Definition / Provider / Consumer. An abstraction is complete only after one end-to-end provider swap passes with zero consumer edits.
- **Governance sits at chokepoints**: default deny; a guarded action has exactly one mandatory path; governance decisions are logged facts.
- **No hardcoded tunables**: deployment-varying choices are validated config fields; protocol and safety invariants stay fixed.
- **No hardcoding domain logic in the runtime**: domain capability enters only as compositions (presets/bundles) on top of the seams.

## Working conventions

- Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:` …); one logical change per commit.
- Non-trivial changes carry a short design note under `docs/notes/` (problem → decision → consequences), named `YYYY-MM-DD-<slug>.md`.
- Comments state contracts and constraints, never narrate control flow. Every export has concise JSDoc; function-like exports document `@param`/`@returns`.
- Tests describe behavior; every milestone's acceptance gate in `docs/ROADMAP.md` is a test that must exist and pass.
- Files end with exactly one trailing newline.
