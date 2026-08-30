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

## Addendum — hot-plug (same day)

`load_plugin` / `unload_plugin` extend the workspace toolset to arbitrary
conversation-authored plugins: scopes are keyed by absolute path (same-path
load retires the old scope first, so hot updates never double-register),
`reload_plugins` refreshes conversation-loaded plugins exactly like
configured ones, and `GET /api/plugins` lists what is live. `load_plugin` is
approval-gated — arbitrary code enters the runtime only through an approved
door. Two lessons from the first real-model run: the ESM cache strikes again
(hot-updating an already-loaded path must cache-bust its import, or the old
module silently re-registers), and the model **invents plugin APIs**
(`ctx.registerTool`/`run`) unless the exact interface — with a skeleton —
lives in the tool description. After teaching the API in the description,
the full loop succeeded against DeepSeek: author → approve → load → call the
brand-new tool (25°C → 77°F).


## Addendum 2 — interactive asking (same day)

`ask_user` joins the workbench toolset (`ask.enabled`, default on): the model
phrases a question with optional `choices`, the turn *blocks* on the user's
answer, and the UI pops a card (choice buttons + free text) via an `ask` SSE
frame. Semantics are vocabulary-native: the question is a persistent
`ask/requested` fact the moment it is asked; the answer lands as a
`user/message` with surface `ask`, so the derived history carries it verbatim
and the model-visible equality invariant holds without a second channel. The
tool result also returns the answer for the current step. Aborting the turn
cancels the pending ask (the abort signal rejects it — the cancel-leak
contract covers human waits too). Verified against DeepSeek: the model asked
with choices, the answer arrived as a user bubble, and the model followed up
with a second confirmation ask — multi-round negotiation works.
