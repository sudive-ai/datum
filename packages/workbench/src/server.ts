import { readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@sudive-ai/cordis'
import type { JsonRecord, SessionEvent, SessionId } from '@sudive-ai/datum-vocabulary'
import { brand } from '@sudive-ai/datum-vocabulary'
import { newMessageId, SessionLog } from '@sudive-ai/datum-session'
import { ApprovalDeniedError, LlmService, MockAdapter, ToolService, createOpenAICompatibleAdapter } from '@sudive-ai/datum-tools'
import type { LlmAdapter } from '@sudive-ai/datum-tools'
import { AgentLoop, createAgentLoop } from '@sudive-ai/datum-loop'
import {
  createEphemeralMemoryStore,
  createPostgresStorage,
  createSqliteStorage,
  mountSessionPersistence,
  openPersistentSessionLog,
  type MemoryStore,
  type StorageAdapter,
} from '@sudive-ai/datum-storage'
import type { WorkbenchConfig } from './config.ts'
import { createChatPresenter, type ChatViewState } from './presenter.ts'
import { workbenchPage } from './page.ts'

/** A user-authored plugin: a cordis plugin that composes domain behavior. */
export type DatumPlugin = (pluginContext: Context) => void

/** A running workbench instance. */
export interface WorkbenchHandle {
  /** The actually-bound port (use `0` to let the OS choose). */
  readonly port: number
  /** The kernel context hosting every mounted service and plugin. */
  readonly ctx: Context
  /** The storage engine behind this workbench, when persistence is on. */
  readonly storage: StorageAdapter | undefined
  /** The active session (switching replaces it — read afresh). */
  readonly session: SessionLog
  /** The loop driving the active agent. */
  readonly loop: AgentLoop
  /** Activate a stored session (or brand a fresh one when omitted). */
  activateSession(sessionId?: SessionId): Promise<SessionId>
  /** Stop the server, close SSE streams, drain persistence, close storage. */
  close(): Promise<void>
}

/**
 * Start a local web workbench.
 *
 * Mounts the LLM seam, the tool registry, and the default harness on a fresh
 * kernel context; sessions persist through the configured storage engine and
 * can be listed, created, switched, and deleted over the API; the memory
 * composition gives the agent long-term recall via `remember`/`recall` tools
 * plus a memory digest injected at the pre-step waterfall; interactive
 * approval is opt-in (default closed). Misconfiguration fails here, loudly.
 *
 * @param config — a resolved {@link WorkbenchConfig}.
 * @returns the running handle.
 */
export async function startWorkbench(config: WorkbenchConfig): Promise<WorkbenchHandle> {
  const ctx = new Context()
  const llm = new LlmService(ctx, 'llm')
  llm.use(createAdapter(config))
  const tools = new ToolService(ctx, 'tools')
  const storage = createStorage(config)

  // --- mutable active session (multi-session) -------------------------------
  let persistenceDisposer: (() => Promise<void>) | undefined
  // Definite assignment: listeners registered below fire only after
  // activate() binds the first session — but the crash-repair append inside
  // activate() broadcasts BEFORE binding, so every listener must tolerate
  // `active` being undefined (no active session yet → nothing to project).
  let active: { session: SessionLog; loop: AgentLoop; presenter: ReturnType<typeof createChatPresenter> } | undefined

  const clients = new Set<ServerResponse>()
  const writeFrame = (event: string, data: unknown): void => {
    for (const client of clients) client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  // --- memory composition: tools + pre-step injection -----------------------
  const memoryStore: MemoryStore = storage ? storage.memories : createEphemeralMemoryStore()
  let memoryDigest = ''
  const refreshMemoryDigest = async (): Promise<void> => {
    if (!config.memory.enabled) return
    const entries = await memoryStore.list()
    memoryDigest = entries.length === 0
      ? ''
      : entries.map(entry => `- ${entry.key}: ${entry.content}`).join('\n')
  }
  if (config.memory.enabled) {
    tools.register({
      name: 'remember',
      description: 'Save a long-term memory under a stable short key. Overwrites the previous content of that key.',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string', description: 'short stable slug, e.g. user-language' }, content: { type: 'string' } },
        required: ['key', 'content'],
      },
      execute: async input => {
        const entry = await memoryStore.put(String(input['key'] ?? ''), String(input['content'] ?? ''))
        await refreshMemoryDigest()
        return { saved: entry.key, updatedAt: entry.updatedAt }
      },
    })
    tools.register({
      name: 'recall',
      description: 'List long-term memories; an optional query filters by substring in key or content.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'optional filter text' } },
      },
      execute: async input => {
        const query = input['query'] === undefined ? undefined : String(input['query']).toLowerCase()
        const all = await memoryStore.list()
        return {
          memories: all
            .filter(entry => query === undefined || entry.key.toLowerCase().includes(query) || entry.content.toLowerCase().includes(query))
            .map(entry => ({ key: entry.key, content: entry.content })),
        }
      },
    })
    ctx.on('agent/pre-step', (spec, next) => {
      if (memoryDigest.length > 0) {
        spec.systemPrompt += `\n\n## Long-term memory\n${memoryDigest}`
      }
      return next()
    })
    await refreshMemoryDigest()
  }

  // --- SSE broadcast: only the active session reaches the live stream -------
  const disposers: Array<() => unknown> = []
  disposers.push(
    ctx.on('session/event', (event: SessionEvent) => {
      if (active === undefined || event.payload.sessionId !== active!.session.sessionId) return
      active.presenter.apply(event)
      // Broadcast frames stay UNNAMED: the page's onmessage is the one live
      // refetch driver; named frames are reserved for control events (asks,
      // approvals, session-switched).
      clients.forEach(client => client.write(`data: ${JSON.stringify(event)}\n\n`))
    }),
  )

  // --- interactive asking: the agent pauses for a user answer ---------------
  const pendingAsks = new Map<string, { id: string; question: string; choices: readonly string[]; resolve: (answer: string) => void; reject: (error: Error) => void }>()
  let askCounter = 0
  if (config.ask.enabled) {
    tools.register({
      name: 'ask_user',
      description: 'Ask the user a question and wait for their answer — use it whenever you need a decision, a choice, or a '
        + 'confirmation you cannot make yourself. Offer short `choices` for easy selection; leave them empty for free text. '
        + 'The answer arrives as the tool result (and lands in the conversation history).',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'what you need from the user, phrased as a question' },
          choices: { type: 'array', items: { type: 'string' }, description: 'short options to pick from; omit for free text' },
        },
        required: ['question'],
      },
      execute: async (input, context) => {
        const id = `ask-${++askCounter}`
        const question = String(input['question'] ?? '')
        const choices = Array.isArray(input['choices']) ? (input['choices'] as unknown[]).map(choice => String(choice)) : []
        writeFrame('ask', { id, question, choices })
        // The question is a durable fact the moment it is asked.
        active!.session.append('ask/requested', {
          sessionId: active!.session.sessionId,
          askId: brand<'AskId'>(id),
          question,
          choices,
        })
        return new Promise<JsonRecord>((resolveAsk, rejectAsk) => {
          pendingAsks.set(id, {
            id, question, choices,
            resolve: answer => {
              pendingAsks.delete(id)
              writeFrame('ask-answered', { id })
              // The answer is user input: it lands in the log as a
              // user/message so the derived history carries it verbatim.
              active!.session.append('user/message', {
                sessionId: active!.session.sessionId,
                messageId: newMessageId(),
                content: [{ kind: 'text', text: answer }],
                source: { kind: 'human', surface: 'ask' },
              })
              resolveAsk({ answer })
            },
            reject: rejectAsk,
          })
          context.signal?.addEventListener('abort', () => {
            if (pendingAsks.delete(id)) {
              writeFrame('ask-answered', { id })
              rejectAsk(new Error('ask cancelled: the turn was aborted'))
            }
          }, { once: true })
        })
      },
    })
  }

  // --- interactive approval (opt-in) ----------------------------------------
  const pendingApprovals = new Map<string, { id: string; tool: string; input: unknown; resolve: () => void; reject: (error: ApprovalDeniedError) => void }>()
  let approvalCounter = 0
  if (config.approval.mode === 'interactive') {
    tools.setGuard((tool, input) => {
      const id = `appr-${++approvalCounter}`
      return new Promise<void>((resolveGuard, rejectGuard) => {
        pendingApprovals.set(id, {
          id, tool: tool.name, input,
          resolve: () => {
            pendingApprovals.delete(id)
            writeFrame('approval-decided', { id, decision: 'granted' })
            resolveGuard()
          },
          reject: (error: ApprovalDeniedError) => {
            pendingApprovals.delete(id)
            writeFrame('approval-decided', { id, decision: 'denied' })
            rejectGuard(error)
          },
        })
        writeFrame('approval', { id, tool: tool.name, input })
      })
    }, 'ui')
  }

  // --- self-modification workspace: file tools + reload ----------------------
  const workspaceRoot = resolve(process.cwd(), config.workspace.root)
  const inWorkspace = (path: string): string => {
    const target = resolve(workspaceRoot, path)
    if (target !== workspaceRoot && !target.startsWith(workspaceRoot + '/')) {
      throw new Error(`refusing: ${JSON.stringify(path)} escapes the workspace root`)
    }
    return target
  }
  if (config.workspace.fileTools) {
    tools.register({
      name: 'read_file',
      description: 'Read a text file inside your workspace. Paths are relative to the workspace root.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      execute: async input => ({ content: await readFile(inWorkspace(String(input['path'] ?? '')), 'utf8') }),
    })
    tools.register({
      name: 'list_files',
      description: 'List the entries of a directory inside your workspace.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'defaults to the workspace root' } } },
      execute: async input => ({ entries: await readdir(inWorkspace(String(input['path'] ?? '.'))) }),
    })
    tools.register({
      name: 'write_file',
      description: 'Create or overwrite a text file inside your workspace. Requires approval. '
        + 'Special file: workbench.page.html — the UI page reloads from it, so editing it changes your own chat interface.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      requiresApproval: true,
      execute: async input => {
        await writeFile(inWorkspace(String(input['path'] ?? '')), String(input['content'] ?? ''), 'utf8')
        return { written: String(input['path'] ?? '') }
      },
    })
    tools.register({
      name: 'reload_plugins',
      description: 'Re-read every loaded plugin file from disk and replace your own registrations with what the files now say. '
        + 'Call it after editing a plugin file (including this tool set itself) to make changes live.',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        await reloadPlugins()
        return { reloaded: [...pluginScopes.values()].map(scope => scope.path), tools: tools.list().map(tool => tool.name) }
      },
    })
    tools.register({
      name: 'load_plugin',
      description: 'Load (or hot-update) a plugin module from the workspace. Requires approval. The module default-exports a function '
        + 'receiving the context `ctx`. EXACT API — register tools with `ctx.tools.register({ name, description, parameters, execute })` '
        + '(execute receives `(input, context)` and returns a JSON object); listen with `ctx.on(name, listener)` (e.g. agent/pre-step). '
        + 'Example:\n'
        + 'export default (ctx) => {\n'
        + '  ctx.tools.register({\n'
        + '    name: "my_tool", description: "what it does",\n'
        + '    parameters: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },\n'
        + '    execute: (input) => ({ result: String(input.x).toUpperCase() }),\n'
        + '  })\n'
        + '}\n'
        + 'Do NOT invent other methods — there is no ctx.registerTool and no run field. New tools are usable in the very next step.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'workspace-relative .ts/.js path' } }, required: ['path'] },
      requiresApproval: true,
      execute: async input => {
        const path = inWorkspace(String(input['path'] ?? ''))
        if (!/\.(ts|js|mjs)$/.test(path)) throw new Error('load_plugin: only .ts/.js/.mjs modules can be loaded')
        // Always cache-bust: a hot update must read the file as it is now,
        // never the ESM cache's copy of what it used to be.
        const mod = (await import(`${pathToFileURL(path).href}?t=${Date.now()}`)) as { default?: DatumPlugin } & DatumPlugin
        await applyPlugin(path, mod)
        return { loaded: path, tools: tools.list().map(tool => tool.name) }
      },
    })
    tools.register({
      name: 'unload_plugin',
      description: 'Unload a loaded plugin — its registrations are removed (reversible teardown).',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      execute: async input => {
        const absolute = inWorkspace(String(input['path'] ?? ''))
        const scope = pluginScopes.get(absolute)
        if (!scope) throw new Error(`unload_plugin: no loaded plugin at ${JSON.stringify(String(input['path'] ?? ''))}`)
        disposeScope(scope)
        pluginScopes.delete(absolute)
        return { unloaded: absolute, tools: tools.list().map(tool => tool.name) }
      },
    })
  }

  // --- user plugins (reversible: hot-pluggable, reload replaces wholesale) ---
  //
  // Each plugin runs against a *scoped* context that records every
  // registration it makes (tools, listeners); unloading replays those
  // disposers in reverse before the replacement applies. Ownership lives
  // here, at the workbench, not in kernel fiber bookkeeping. Scopes are
  // keyed by absolute path, so conversation-loaded plugins refresh on
  // reload exactly like configured ones.
  interface PluginScope {
    path: string
    disposers: Array<() => unknown>
    /** The loaded module — re-applied when a later reload of this path fails. */
    scopePlugin: DatumPlugin
  }
  const pluginScopes = new Map<string, PluginScope>()
  const disposeScope = (scope: PluginScope): void => {
    for (const dispose of [...scope.disposers].reverse()) dispose()
  }
  const applyPlugin = async (pluginPath: string, preloaded?: { default?: DatumPlugin } & DatumPlugin): Promise<void> => {
    const absolute = resolve(process.cwd(), pluginPath)
    const previous = pluginScopes.get(absolute)
    const mod = preloaded ?? ((await import(pathToFileURL(absolute).href)) as { default?: DatumPlugin } & DatumPlugin)
    const plugin = (mod.default ?? mod) as DatumPlugin
    const scope: PluginScope = { path: absolute, disposers: [], scopePlugin: plugin }
    const scopedCtx = new Proxy(ctx, {
      get(target, prop) {
        if (prop === 'tools') {
          return new Proxy(Reflect.get(target, prop), {
            get(toolTarget, toolProp) {
              if (toolProp === 'register') {
                return (definition: Parameters<ToolService['register']>[0]) => {
                  const disposer = target.tools.register(definition)
                  scope.disposers.push(() => { disposer() })
                  return disposer
                }
              }
              return Reflect.get(toolTarget, toolProp)
            },
          })
        }
        if (prop === 'on' || prop === 'once') {
          return (name: string, listener: (...args: never[]) => unknown, options?: boolean | { prepend?: boolean; global?: boolean }) => {
            const disposer = (target as unknown as { on: (n: string, l: (...args: never[]) => unknown, o?: unknown) => () => boolean })[prop === 'once' ? 'on' : prop](name, listener, options)
            scope.disposers.push(disposer)
            return disposer
          }
        }
        return Reflect.get(target, prop)
      },
    })
    // Hot update semantics: retire the previous scope FIRST (same-path
    // reload replaces the same registrations — registering before retiring
    // would collide with the old names), then apply the new code. If the
    // new code fails, roll it back and re-apply the previous module so the
    // workspace never ends up worse than before the reload.
    if (previous) disposeScope(previous)
    try {
      plugin(scopedCtx)
    } catch (error) {
      if (previous) {
        try {
          previous.scopePlugin(scopedCtx)
          pluginScopes.set(absolute, previous)
          ctx.logger.error(`plugin reload failed; previous version restored: ${String(error).slice(0, 200)}`)
          return
        } catch (restoreError) {
          ctx.logger.error(`plugin reload failed AND previous restore failed: ${String(restoreError).slice(0, 200)}`)
        }
      } else {
        disposeScope(scope)
      }
      throw error
    }
    pluginScopes.set(absolute, scope)
  }
  for (const pluginPath of config.plugins) await applyPlugin(pluginPath)

  /**
   * Reload every user plugin from disk: new code imports first (fail loud
   * before anything tears down), then each old scope's disposers replay in
   * reverse — unregistering exactly what that plugin registered — and the
   * new code applies.
   */
  const reloadPlugins = async (): Promise<void> => {
    const fresh: Array<{ path: string; mod: { default?: DatumPlugin } & DatumPlugin }> = []
    for (const scope of pluginScopes.values()) {
      const mod = (await import(`${pathToFileURL(scope.path).href}?t=${Date.now()}`)) as { default?: DatumPlugin } & DatumPlugin
      fresh.push({ path: scope.path, mod })
    }
    for (const { path, mod } of fresh) await applyPlugin(path, mod)
  }

  // --- activation: restore-or-create one session and bind its loop ------------
  const spec = {
    name: config.agent.name,
    systemPrompt: config.agent.systemPrompt,
    model: config.llm.model ?? config.agent.model,
    maxTokens: config.agent.maxTokens,
    options: {},
    surface: 'web',
    compaction: config.compaction.enabled
      ? { maxEntries: config.compaction.maxEntries, keepRecent: config.compaction.keepRecent }
      : undefined,
  }

  function bindSession(session: SessionLog): SessionId {
    const presenter = createChatPresenter()
    // Historical replay: the view starts from the stored facts.
    for (const entry of session.entries) presenter.apply(entry)
    const loop = createAgentLoop({ context: ctx, session, llm, tools, spec })
    active = { session, loop, presenter }
    writeFrame('session-switched', { sessionId: session.sessionId })
    return session.sessionId
  }

  /** Restore a stored session (latest when omitted) and bind it. */
  async function activate(sessionId: SessionId | undefined): Promise<SessionId> {
    await persistenceDisposer?.()
    persistenceDisposer = undefined
    if (storage) {
      const restored = await openPersistentSessionLog({ context: ctx, storage, sessionId })
      persistenceDisposer = restored.disposePersistence
      return bindSession(restored.session)
    }
    return bindSession(sessionId ? new SessionLog({ context: ctx, sessionId }) : new SessionLog({ context: ctx }))
  }

  /**
   * Brand a genuinely new session — never a restore. With storage attached
   * it persists from its first fact on.
   */
  async function createSession(): Promise<SessionId> {
    await persistenceDisposer?.()
    persistenceDisposer = undefined
    const session = new SessionLog({ context: ctx })
    if (storage) {
      await storage.registerSession(session.sessionId, config.agent.name)
      persistenceDisposer = mountSessionPersistence({ context: ctx, session, storage })
    }
    return bindSession(session)
  }
  await activate(undefined)

  // --- HTTP ---------------------------------------------------------------------
  const server = createServer((request, response) => {
    void route(request, response).catch(error => {
      // A malformed request body is the caller's mistake (400); anything
      // else is ours (500). Both answer loudly, neither kills the server.
      const badRequest = error instanceof SyntaxError
      response.writeHead(badRequest ? 400 : 500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: String(error) }))
    })
  })

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (request.method === 'GET' && url.pathname === '/') {
      // A workbench.page.html in the workspace overrides the built-in page —
      // the agent can redesign its own interface with write_file.
      let page: string
      try {
        page = await readFile(inWorkspace('workbench.page.html'), 'utf8')
      } catch {
        page = workbenchPage
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(page)
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, agent: active!.loop.name }))
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/history') {
      const snapshot: ChatViewState = active!.presenter.snapshot()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(snapshot))
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/sessions') {
      const stored = storage ? await storage.listSessions() : []
      const listed = stored.map(item => ({ sessionId: item.sessionId, lastTime: item.lastTime, entries: item.entries }))
      if (!listed.some(item => item.sessionId === active!.session.sessionId)) {
        listed.unshift({ sessionId: active!.session.sessionId, lastTime: Date.now(), entries: active!.session.entries.length })
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ active: active!.session.sessionId, sessions: listed }))
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/sessions') {
      if (active!.loop.running) {
        response.writeHead(409, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'a turn is already running' }))
        return
      }
      const sessionId = await createSession()
      response.writeHead(201, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ sessionId }))
      return
    }
    const switchMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/activate$/)
    if (request.method === 'POST' && switchMatch) {
      if (active!.loop.running) {
        response.writeHead(409, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'a turn is already running' }))
        return
      }
      const sessionId = decodeURIComponent(switchMatch[1]!) as SessionId
      if (storage) {
        const known = (await storage.listSessions()).some(item => item.sessionId === sessionId)
        if (!known && sessionId !== active!.session.sessionId) {
          response.writeHead(404, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'no such session' }))
          return
        }
      }
      await activate(sessionId)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ sessionId }))
      return
    }
    const deleteMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (request.method === 'DELETE' && deleteMatch) {
      const sessionId = decodeURIComponent(deleteMatch[1]!) as SessionId
      if (!storage) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'memory-mode sessions cannot be deleted' }))
        return
      }
      if (active!.loop.running) {
        response.writeHead(409, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'a turn is already running' }))
        return
      }
      await storage.deleteSession(sessionId)
      if (sessionId === active!.session.sessionId) await activate(undefined)
      response.writeHead(204)
      response.end()
      return
    }
    if (request.method === 'GET' && url.pathname === '/events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      response.write(':connected\n\n')
      clients.add(response)
      const drop = (): void => { clients.delete(response) }
      request.on('close', drop)
      request.on('error', drop)
      response.on('error', drop) // a dead socket must not accumulate in the set
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/messages') {
      const body = (await readBody(request)) as { text?: unknown }
      if (typeof body.text !== 'string' || body.text.length === 0) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'text is required' }))
        return
      }
      if (active!.loop.running) {
        response.writeHead(409, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'a turn is already running' }))
        return
      }
      await refreshMemoryDigest() // the pre-step waterfall injects the fresh digest
      const messageId = active!.loop.submit(body.text)
      void active!.loop.runTurn(messageId).catch(() => undefined) // terminal facts land in the log regardless
      response.writeHead(202, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ messageId }))
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/plugins') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify([...pluginScopes.values()].map(scope => scope.path)))
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/reload-plugins') {
      await reloadPlugins()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ tools: tools.list().map(tool => tool.name) }))
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/cancel') {
      active!.loop.cancel()
      response.writeHead(204)
      response.end()
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/asks') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify([...pendingAsks.values()].map(({ id, question, choices }) => ({ id, question, choices }))))
      return
    }
    const askMatch = url.pathname.match(/^\/api\/asks\/([^/]+)$/)
    if (request.method === 'POST' && askMatch) {
      const askCase = pendingAsks.get(decodeURIComponent(askMatch[1]!))
      if (!askCase) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'no such pending ask' }))
        return
      }
      const body = (await readBody(request)) as { answer?: unknown }
      if (typeof body.answer !== 'string' || body.answer.length === 0) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'answer is required' }))
        return
      }
      askCase.resolve(body.answer)
      response.writeHead(204)
      response.end()
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/approvals') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify([...pendingApprovals.values()].map(({ id, tool, input }) => ({ id, tool, input }))))
      return
    }
    const approvalMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)$/)
    if (request.method === 'POST' && approvalMatch) {
      const approvalCase = pendingApprovals.get(decodeURIComponent(approvalMatch[1]!))
      if (!approvalCase) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'no such pending approval' }))
        return
      }
      const body = (await readBody(request)) as { decision?: unknown }
      if (body.decision === 'granted') {
        approvalCase.resolve()
        response.writeHead(204)
        response.end()
        return
      }
      if (body.decision === 'denied') {
        approvalCase.reject(new ApprovalDeniedError(approvalCase.tool, 'ui', 'denied in the workbench UI'))
        response.writeHead(204)
        response.end()
        return
      }
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: "decision must be 'granted' or 'denied'" }))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'not found' }))
  }

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(config.port, () => resolveListen())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : config.port

  return {
    port,
    ctx,
    storage,
    get session(): SessionLog {
      return active!.session
    },
    get loop(): AgentLoop {
      return active!.loop
    },
    activateSession: (sessionId?: SessionId) => activate(sessionId),
    close: () =>
      (async () => {
        for (const client of clients) client.end()
        clients.clear()
        // Drain first: persistence awaits in-flight writes, so closing
        // cannot lose the tail of the log.
        for (const dispose of disposers) await dispose()
        await persistenceDisposer?.()
        if (storage) await storage.close()
        await new Promise<void>((resolveClose, rejectClose) => {
          server.close(error => (error ? rejectClose(error) : resolveClose()))
        })
      })(),
  }
}

/** Build the configured LLM adapter; misconfiguration fails here, loudly. */
function createAdapter(config: WorkbenchConfig): LlmAdapter {
  if (config.llm.provider === 'mock') {
    return new MockAdapter({
      handler: async request => {
        const last = request.messages.at(-1)
        const text = last?.content.map(word => (word.kind === 'text' ? word.text : '')).join('') ?? ''
        return {
          finishReason: { kind: 'stop' },
          content: [{ kind: 'text', text: `[mock] You said: ${text}` }],
          usage: null,
        }
      },
    })
  }
  if (!config.llm.baseUrl) {
    throw new Error('workbench config: llm.baseUrl is required for the openai-compatible provider')
  }
  const apiKey = process.env[config.llm.apiKeyEnv]
  if (!apiKey) {
    throw new Error(`workbench config: environment variable ${config.llm.apiKeyEnv} is not set (API keys come from the environment, never from config files or the log)`)
  }
  return createOpenAICompatibleAdapter({
    baseUrl: config.llm.baseUrl,
    apiKey,
    model: config.llm.model ?? config.agent.model,
  })
}

/** Build the configured storage engine; misconfiguration fails here, loudly. */
function createStorage(config: WorkbenchConfig): StorageAdapter | undefined {
  switch (config.storage.engine) {
    case 'memory':
      return undefined
    case 'sqlite':
      return createSqliteStorage({ path: config.storage.path })
    case 'postgres': {
      const connectionString = process.env[config.storage.connectionStringEnv]
      if (!connectionString) {
        throw new Error(`workbench config: environment variable ${config.storage.connectionStringEnv} is not set (the PostgreSQL connection string comes from the environment, never from config files)`)
      }
      return createPostgresStorage({ connectionString })
    }
  }
}

/** Read and parse a JSON request body. Malformed bodies reject with SyntaxError (mapped to 400). */
function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    let data = ''
    request.on('data', chunk => {
      data += chunk
    })
    request.on('end', () => {
      try {
        resolveBody(data.length > 0 ? JSON.parse(data) : {})
      } catch (error) {
        rejectBody(error instanceof SyntaxError ? error : new SyntaxError(String(error)))
      }
    })
    request.on('error', rejectBody)
  })
}
