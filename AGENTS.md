# AGENTS.md

Datum — an event-sourced agent runtime and workbench core. Read `README.md` for the design pillars; read `docs/ROADMAP.md` before adding packages or changing build order.

## Layout

```
packages/        @datum-fw/* workspaces, one package per directory
  kernel/        reversible effects, scopes, typed events, service registry
  session/       append-only event log, derived projections, fail-closed load
  tools/         tool registry and guarded execution pipeline
  loop/          agent contract + default turn/step driver (factory seam)
docs/            roadmap and design notes
```

## Commands

```sh
pnpm install     # pnpm workspaces, node >= 22
pnpm build       # tsc -b across all packages
pnpm clean       # remove build outputs
```

## Non-negotiable invariants

- **ESM everywhere** (`"type": "module"`), TypeScript `strict`, NodeNext resolution, `.ts` specifiers in local relative imports.
- **Registrations are reversible**: every registration API returns a disposer; there is no irreversible registration API. Teardown is reverse-order and exactly-once.
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
