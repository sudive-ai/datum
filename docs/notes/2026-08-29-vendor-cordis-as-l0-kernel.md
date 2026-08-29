# 2026-08-29 — Vendor Cordis as the L0 kernel

## Problem

M1 originally planned a hand-written kernel (`@sudive-ai/kernel`): Scope effects, an emit/waterfall event bus, and a keyed service registry. Before any of it was implemented, the milestone was re-scoped: the kernel is load-bearing, protocol-grade machinery (fiber lifecycle, reentrant disposal, injection ordering), and writing our own means owning every lifecycle edge case forever — the exact class of bugs that silently leak plugins on teardown.

## Decision

Adopt the DSH (DeepSeek Harness) L0 architecture: **Cordis is the kernel, vendored and pinned**, not reimplemented.

- `vendor/cordis` ← upstream `cordiverse/cordis` `packages/core` @ `56b3d4f` (4.0.0-rc.7), including the lifecycle hardening (reentrant-disposal closure, `UNLOADING`-window effect rejection) proven in deepseek-harness.
- `vendor/cosmokit` ← foundation utilities @ `16f6fc0` (1.8.1), the only source-level dependency of the core.
- The full framework layer is vendored alongside: schemastery (forced transitive — `hmr` and `logger-console` depend on it) and the plugin set loader / include / group / timer / hmr / logger-console, each renamed `@sudive-ai/cordis-plugin-*` (schemastery → `@sudive-ai/schemastery`). A vendored `utils` package was evaluated and dropped: the bundler-resolution build never needs it.
- The nine vendored packages are renamed into the `@sudive-ai` scope; manifests/tsconfigs regenerated to the Datum house shape (plain `tsc -b`, ESM, bundler resolution). Everything is logged in `vendor/README.md` with a sync procedure.
- `packages/kernel` is deleted, and the pre-vendor stubs of `session`/`tools`/`loop` are cleared with it — `packages/` starts empty; those layers are rebuilt against `@sudive-ai/cordis` in ROADMAP order (M1 session first).

## Consequences

- The reversible-registration invariant and the emit/waterfall event language are enforced by the vendored kernel's effect/fiber discipline; the M1 "effect discipline" acceptance gate becomes a Datum-side pinning test against `@sudive-ai/cordis` instead of an implementation task.
- We own a diff surface, not a framework: future kernel upgrades are upstream syncs plus re-applying a short, logged modification list — not a rewrite.
- Vendored sources keep upstream dialect (relaxed strictness flags in `vendor/*/tsconfig.json` only); Datum's own packages stay on the strict house config.
- Deliberately not vendored (verified unused by this set): `@cordisjs/element`, the network/web layer (`plugin-http`/`plugin-server`/`plugin-proxy*`/`plugin-webui`), `@cordisjs/registry` (standalone legacy; core 4.x has RegistryService), `@cordisjs/plugin-logger` (superseded by logger-console), `reggol`, `@cordisjs/unyaml`, and `utils`; `@schemastery/web` joins when the M4 workbench needs rendered config forms.
