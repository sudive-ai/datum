# Vendored Packages

This directory contains source-vendored copies of the Cordis framework and its foundation libraries. They are copied into this monorepo instead of being depended on via npm, so that Datum fully owns its framework layer (auditable, patchable, pinned). Cordis **is** the Datum L0 kernel: `Context` (service repository), `Service` + injection, `Events` (emit/waterfall), `Effect` (reversible registration → reverse-order teardown), and the `Fiber` lifecycle are the fixed language every Datum package builds on. The vendored plugin set (loader / include / group / timer / hmr / logger-console) and schemastery complete the framework layer the same way.

All vendored packages are **renamed into the `@sudive-ai` scope** (`cordis` → `@sudive-ai/cordis`, `cosmokit` → `@sudive-ai/cosmokit`, `@cordisjs/plugin-<x>` → `@sudive-ai/cordis-plugin-<x>`, `schemastery` → `@sudive-ai/schemastery`). Directory names and upstream version numbers are deliberately unchanged, so the manifest below still reads as an upstream snapshot. `pnpm-workspace.yaml` includes `vendor/*` and sets `linkWorkspacePackages: true`, so the preserved upstream semver ranges resolve to these pinned workspaces. Upstream MIT `LICENSE` files are preserved in each package directory.

## Manifest

Provenance: sources were copied from the DeepSeek Harness (`deepseek-harness`) vendored copy, whose working forks carry the local modifications inherited by this copy (items 3–7). Items 8–11 are Datum-made. The **upstream** column is the true origin recorded in each package's npm metadata; the **vendored source** column is the actual snapshot we copied, which for several packages is the deepseek-harness fork rather than a bare upstream commit.

| Directory | npm name | Upstream | Version | Vendored source (commit) |
|---|---|---|---|---|
| `cosmokit/` | `@sudive-ai/cosmokit` | [`cosmokit`](https://github.com/shigma/cosmokit) | 1.8.1 | deepseek-harness/cosmokit @ `16f6fc0` |
| `schemastery/` | `@sudive-ai/schemastery` | [`schemastery`](https://github.com/shigma/schemastery) (`packages/core`) | 3.18.0 | deepseek-harness/schemastery @ `e67cee0` |
| `cordis/` | `@sudive-ai/cordis` | [`cordis`](https://github.com/cordiverse/cordis) (`packages/core`) | 4.0.0-rc.7 | cordiverse/cordis @ `56b3d4f` |
| `loader/` | `@sudive-ai/cordis-plugin-loader` | [`@cordisjs/plugin-loader`](https://github.com/cordiverse/cordis) (`packages/loader`) | 1.0.0-rc.5 | cordiverse/cordis @ `56b3d4f` |
| `include/` | `@sudive-ai/cordis-plugin-include` | [`@cordisjs/plugin-include`](https://github.com/cordiverse/cordis) (`packages/include`) | 1.0.4 | deepseek-harness/cordis @ `abb0a30` |
| `group/` | `@sudive-ai/cordis-plugin-group` | [`@cordisjs/plugin-group`](https://github.com/cordiverse/cordis) (`packages/group`) | 1.0.0 | deepseek-harness/cordis @ `abb0a30` |
| `timer/` | `@sudive-ai/cordis-plugin-timer` | [`@cordisjs/plugin-timer`](https://github.com/cordiverse/cordis) (`packages/timer`) | 1.1.2 | deepseek-harness/cordis @ `abb0a30` |
| `hmr/` | `@sudive-ai/cordis-plugin-hmr` | [`@cordisjs/plugin-hmr`](https://github.com/cordiverse/cordis) (`packages/hmr`) | 1.0.15 | deepseek-harness/cordis @ `abb0a30` |
| `logger-console/` | `@sudive-ai/cordis-plugin-logger-console` | [`@cordisjs/plugin-logger-console`](https://github.com/cordiverse/cordis) (`packages/logger-console`) | 1.0.0 | deepseek-harness/cordis @ `abb0a30` |

All six `@cordisjs/plugin-*` packages live in the single `cordiverse/cordis` monorepo; `include`/`group`/`timer`/`hmr`/`logger-console` were carried through the deepseek-harness fork (`abb0a30`), so their fork-base commit in `cordiverse/cordis` is not recorded here — re-deriving it is part of any future sync. Versions are the upstream versions recorded at the time of vendoring.

Third-party dependencies of the vendored packages stay on npm: `@standard-schema/spec`, `js-yaml`, `chokidar`, `picomatch`, `@babel/code-frame`, `supports-color` (plus `@types/babel__code-frame`, `@types/picomatch` as `hmr` devDependencies).

Intentionally **not** vendored: `reggol`, `@cordisjs/element`, `@cordisjs/unyaml`, and a `utils` package (a bundled-resolution + `.ts`-specifier build needs none of them; `node-addon-require-builtin` stays an *optional* peer of `loader` — its single guarded `require()` degrades gracefully when absent).

## Local modifications

Keep this log exhaustive — every divergence from upstream must be listed.

1. **All `package.json` files**: regenerated into the Datum house shape — renamed to `@sudive-ai/*`, `private: true`, plain `tsc` build emitting to `lib/` (no bundler stage), `exports` pointing at `lib/index.js` + `lib/index.d.ts`, `repository` pointing at this monorepo with the package's `vendor/<dir>` directory, removed upstream `devDependencies`/`scripts`/`publishConfig`. Dependency and peer-dependency ranges preserved except that internal names use the `@sudive-ai` scope, `hmr` declares peers for `loader`/`include` that its source imports (DSH under-declared them), and `loader` declares `node-addon-require-builtin` as an *optional* peer.
2. **All `tsconfig.json` files**: regenerated to extend the repo-root `tsconfig.base.json` with `composite`/`outDir: lib`, and to relax strictness flags for vendored sources (`noImplicitAny: false`, `noImplicitThis: false`, `strictFunctionTypes: false`, `noUncheckedIndexedAccess: false`, `exactOptionalPropertyTypes: false`, `noImplicitOverride: false`), matching the vendored source's upstream dialect. The base provides bundler resolution with `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` for the `.ts` internal specifiers. Source-side (inherited): type-only imports are marked explicitly across `cordis`, `loader`, `include`, `hmr`, and `schemastery`, so no erased import is requested as a runtime export.
3. **`cordis/src/fiber.ts` lifecycle hardening** (inherited via deepseek-harness): locally closes reentrant disposal gaps — an effect's owner-list wrapper is registered before its setup body runs; synchronous setup failure rolls back collected cleanup; effect creation is rejected while the owner is `UNLOADING`; child fibers register and receive their parent-owned disposer before `internal/plugin` publication; teardown-notification failures are contained per observer; `Fiber.update()` returns its `internal/update` waterfall result. This is the enforcement behind the M1 "effect discipline" acceptance gate.
4. **`cordis/src/*.ts` JSDoc enrichment** (inherited via deepseek-harness): contract documentation across the public plugin-author surface (`Context`, `EventsService`, `Fiber`, `RegistryService`, `ReflectService`, `Service`, `LoggerService`). Comment-only.
5. **`hmr/src/index.ts`** (inherited via deepseek-harness): removed the `./locales/*.yml` imports, the `.i18n({...})` call, and `src/locales/` — they require a runtime YAML loader hook (`@cordisjs/unyaml`) we do not vendor; exact-config watching with serialized refreshes and `ignoreInitial` main-watcher scan, per the upstream log in deepseek-harness.
6. **`include/src/index.ts`** (inherited via deepseek-harness): exported pure `applyEntryPatches` + `entryListSchema`; per-Include serialized child-tree mutation; durable debounced writes with transient-rename retry; lazy `!!js` config interpolation; `writeTask` type widened for `exactOptionalPropertyTypes` — per the upstream log in deepseek-harness.
7. **Transactional Loader/Include/Group config reconciliation** (inherited via deepseek-harness): loader imports a changed entry before disposal and restores the previous plugin on failure; group starts candidates concurrently and undoes on live-update failure; include validates detached candidate content and commits only after the tree reconciles; entry `disabled: !!js` interpolation. Lazy `!!js` config resolution is also ported across `cordis/src/{events,fiber}.ts`, `loader/src/{index,config/entry}.ts`, `include/src/index.ts`, and `hmr/src/index.ts`: raw fiber config is retained and resolved through `internal/config` only after declared injections are active, with resolution applying only to the entry root.
8. **`hmr/src/error.ts` esbuild type stand-in**: the type-only `import type { BuildFailure } from 'esbuild'` is replaced by a local structural interface with the same shape, so the vendored set does not pull the native `esbuild` binary for a type. Behavior-identical at runtime (`isBuildFailure` duck-checks unchanged); retire when hmr first meets a real esbuild `BuildFailure` and prefer adding `esbuild` as a devDependency then.
9. **ESM-only manifest simplifications**: `schemastery` publishes a single ESM entry (`lib/index.js`) instead of the upstream conditional `.mjs`/`.cjs` pair — Datum is ESM-only, so the CJS-lazy-`require` race the dual build solved does not exist here. `logger-console` keeps node/browser conditional entries (`lib/index.js` / `lib/browser.js`, both tsc-emitted from `src/`) but points `types` at `lib/index.d.ts`.
10. **`@sudive-ai` rescope**: every internal import specifier that reaches a vendored name uses the scoped name (mapping = the manifest table's two name columns). No upstream runtime identifier is renamed — `Symbol.for('schemastery')` and Schemastery's `vendor:` metadata field keep their upstream values. Re-apply with `sed 's/@deepseek-ai\//@sudive-ai\//g'` over `vendor/*/src` after a sync.
11. **Dropped upstream build files**: `cordis/bin.js` (the CLI mounts `loader`/`include`; the `bin` field is removed with the file) and `schemastery`/`logger-console` `tsdown.config.ts` (replaced by the plain `tsc` build).

## Sync procedure

To update a vendored package from upstream:

1. In the upstream workspace, note `git rev-parse HEAD` of the relevant package.
2. Copy the package's `src/` (and `README.md`, `LICENSE` if changed) over the vendored directory.
3. Re-apply the local modifications listed above (or drop them if upstream made them unnecessary — update the log either way). The `@sudive-ai` rescope sweep is item 10.
4. Update the version and commit hash in the manifest table.
5. Run `pnpm install && pnpm build` at the repo root, plus the M1 kernel discipline tests.
