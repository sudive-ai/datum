# hello-agent — your first Datum workbench

One config + one plugin = a workbench for your own domain.

```sh
cp .env.example .env   # fill in LLM_* and OPENAI_API_KEY for a real model
pnpm demo              # starts this example on http://127.0.0.1:8642
```

Without a `.env` the demo runs keyless on the mock adapter; with one, the
environment is loaded automatically.

## The two files that are *yours*

- **`start.ts`** — the config: agent name, system prompt, model, LLM provider.
  Defaults run keyless on the mock adapter; switch `llm.provider` to
  `'openai-compatible'`, set `baseUrl`, and export the API key environment
  variable to talk to a real model.
- **`hello-plugin.ts`** — the plugin: a plain cordis plugin composing your
  domain onto the fixed language. Register tools, listen on the
  `agent/pre-step` / `agent/request` waterfalls, observe `agent/*` events.
  Everything is a reversible registration; nothing here patches the runtime.

## Self-modification & hot-plug (默认能力)

The workbench mounts a self-modification toolset over the workspace:
`read_file` / `list_files` / `write_file` (write is approval-gated — the UI
asks you first), `load_plugin` / `unload_plugin` (hot-plug any module the
agent authors), and `reload_plugins` (refresh everything from disk). A
`workbench.page.html` in the workspace overrides the chat UI itself. Try:
"开发一个新插件 xx-plugin.ts 提供 XX 工具，加载后用起来" — the plugin API
skeleton is documented in the `load_plugin` tool description.

## The rules you can rely on

- Everything the model saw is in the log (`request/context`); nothing can
  reach a request without being logged.
- A tool flagged `requiresApproval: true` refuses to run until an approver is
  mounted — default deny, never degrade into allow.
- Tools must be registered to be callable; unknown tools fail loudly.

Copy this folder, rename the agent, write your own tools — that is the whole
authoring model.
