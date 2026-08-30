# 2026-08-30 — 默认交互插件的自我修改（自己改自己 / 自己替换自己）

## Problem

The demo agent could not act on "帮我美化一下你的界面/改一下你自己的插件" —
it had no file access, no way to apply its own edits, and no reload story.
Self-modification is the sharpest test of the seams: edit a file, replace
live registrations, and governance still has to hold.

## Decision

- **workspace toolset** (`workspace.fileTools`, default on): `read_file` /
  `list_files` / `write_file` / `reload_plugins`, all sandboxed to
  `workspace.root`. `write_file` carries `requiresApproval: true` — the
  fail-closed chokepoint means an agent cannot modify files until a human (or
  a mounted policy approver) grants it. Verified: with no approver mounted
  the write refuses with `ApprovalUnavailableError`.
- **reload_plugins**: re-reads every plugin file with a cache-busting URL
  (new code imports FIRST — a broken file fails loudly before any teardown),
  then replays each old scope's registrations in reverse and applies the new
  module. Two kernel findings shaped it:
  1. plain-function plugin bodies run against contexts whose service
     registrations land on the root fiber (the vendored mixin binding), so
     `fiber.dispose()` does **not** unregister what a plugin registered —
     ownership must live at the workbench. Each plugin therefore runs against
     a *scoped context* proxy that records every `tools.register` / `on` /
     `once` disposer; reload replays them.
  2. the reapply path must reuse the cache-busted module import — importing
     the plain path again hits the ESM cache and silently re-registers the
     OLD code (found by the live smoke).
- **page override**: `GET /` serves `workbench.page.html` from the workspace
  when present, falling back to the built-in page — the agent can redesign
  its own chat interface with `write_file` + a browser refresh.

## Consequences

- The self-modification loop is verified against the real DeepSeek endpoint:
  the agent read its plugin, rewrote the greeting, the approval card was
  granted, `reload_plugins` ran, and the reloaded tool answered with the new
  value (programmatically probed: `{"greeting":"你好，世界"}`).
- Model discipline caveat observed live: the model sometimes *claims* success
  without calling the verification tool — the framework cannot force tool
  use; prompts should ask it to verify by calling.
- Scoped-context ownership covers `tools.register` / `on` / `once`; a plugin
  using other registration surfaces (nested `ctx.plugin`, logger config)
  would need the same wrapper treatment — extend the proxy as those needs
  appear.
