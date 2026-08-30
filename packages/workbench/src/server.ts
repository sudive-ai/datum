import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@sudive-ai/cordis'
import type { SessionEvent } from '@sudive-ai/datum-vocabulary'
import { SessionLog } from '@sudive-ai/datum-session'
import { LlmService, MockAdapter, ToolService, createOpenAICompatibleAdapter } from '@sudive-ai/datum-tools'
import type { LlmAdapter } from '@sudive-ai/datum-tools'
import { AgentLoop, createAgentLoop } from '@sudive-ai/datum-loop'
import {
  createPostgresStorage,
  createSqliteStorage,
  openPersistentSessionLog,
  type StorageAdapter,
} from '@sudive-ai/datum-storage'
import { ApprovalDeniedError } from '@sudive-ai/datum-tools'
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
  /** The session log — the single source of truth of this workbench. */
  readonly session: SessionLog
  /** The loop driving the agent. */
  readonly loop: AgentLoop
  /** The storage engine behind this workbench, when persistence is on. */
  readonly storage: StorageAdapter | undefined
  /** Stop the server, close SSE streams, dispose registrations, close storage. */
  close(): Promise<void>
}

/**
 * Start a local web workbench.
 *
 * Mounts the LLM seam, the tool registry, one session log, and the default
 * harness on a fresh kernel context, applies user plugins (plain cordis
 * plugins, resolved against the process cwd), then serves the chat UI over
 * HTTP with an SSE event stream. With no approver mounted, approval-flagged
 * tools refuse (fail closed) — mounting one is always an explicit act.
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
  // Restore-or-create: a stored session rehydrates through the engine's
  // fail-closed read; a fresh one persists from its first fact on. 'memory'
  // keeps the old ephemeral behavior (tests, throwaway demos).
  const session = storage
    ? await openPersistentSessionLog({ context: ctx, storage })
    : new SessionLog({ context: ctx })

  const presenter = createChatPresenter()
  const clients = new Set<ServerResponse>()
  // Interactive approvals: pending cases wait on a promise the UI resolves.
  interface ApprovalCase {
    readonly id: string
    readonly tool: string
    readonly input: unknown
    resolve: () => void
    reject: (error: ApprovalDeniedError) => void
  }
  const pendingApprovals = new Map<string, ApprovalCase>()
  let approvalCounter = 0
  const disposers: Array<() => unknown> = []
  disposers.push(
    ctx.on('session/event', (event: SessionEvent) => {
      presenter.apply(event)
      const frame = `data: ${JSON.stringify(event)}\n\n`
      for (const client of clients) client.write(frame)
    }),
  )
  // Historical replay: a restored session starts the view from its stored
  // facts, so live rendering and replay share one path from the first frame.
  for (const entry of session.entries) presenter.apply(entry)

  // The approval surface: 'interactive' mounts the UI as the approver —
  // guarded tools open a case, the browser decides, the loop logs the fact.
  // 'closed' (the default) mounts nothing: guarded tools refuse outright.
  if (config.approval.mode === 'interactive') {
    tools.setGuard((tool, input) => {
      const id = `appr-${++approvalCounter}`
      const frame = (event: string, data: unknown): void => {
        for (const client of clients) client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }
      return new Promise<void>((resolveGuard, rejectGuard) => {
        pendingApprovals.set(id, {
          id, tool: tool.name, input,
          resolve: () => {
            pendingApprovals.delete(id)
            frame('approval-decided', { id, decision: 'granted' })
            resolveGuard()
          },
          reject: (error: ApprovalDeniedError) => {
            pendingApprovals.delete(id)
            frame('approval-decided', { id, decision: 'denied' })
            rejectGuard(error)
          },
        })
        frame('approval', { id, tool: tool.name, input })
      })
    }, 'ui')
  }

  for (const pluginPath of config.plugins) {
    const absolute = resolve(process.cwd(), pluginPath)
    const mod = (await import(pathToFileURL(absolute).href)) as { default?: DatumPlugin } & DatumPlugin
    const plugin = (mod.default ?? mod) as DatumPlugin
    ctx.plugin(plugin)
  }

  const loop = createAgentLoop({
    context: ctx,
    session,
    llm,
    tools,
    spec: {
      name: config.agent.name,
      systemPrompt: config.agent.systemPrompt,
      model: config.llm.model ?? config.agent.model,
      maxTokens: config.agent.maxTokens,
      options: {},
      surface: 'web',
    },
  })

  const server = createServer((request, response) => {
    void route(request, response).catch(error => {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: String(error) }))
    })
  })

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://localhost`)
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(workbenchPage)
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, agent: loop.name }))
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/history') {
      const snapshot: ChatViewState = presenter.snapshot()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(snapshot))
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
      request.on('close', () => clients.delete(response))
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/messages') {
      const body = (await readBody(request)) as { text?: unknown }
      if (typeof body.text !== 'string' || body.text.length === 0) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'text is required' }))
        return
      }
      if (loop.running) {
        response.writeHead(409, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'a turn is already running' }))
        return
      }
      const messageId = loop.submit(body.text)
      void loop.runTurn(messageId).catch(() => undefined) // terminal facts land in the log regardless
      response.writeHead(202, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ messageId }))
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/cancel') {
      loop.cancel()
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
    session,
    loop,
    storage,
    close: () =>
      (async () => {
        for (const client of clients) client.end()
        clients.clear()
        // Drain first: the persistence disposer awaits in-flight writes, so
        // closing cannot lose the tail of the log.
        for (const dispose of disposers) await dispose()
        if (storage) await storage.close()
        await new Promise<void>((resolveClose, rejectClose) => {
          server.close(error => (error ? rejectClose(error) : resolveClose()))
        })
      })(),
  }
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

/** Read and parse a JSON request body. */
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
        rejectBody(error)
      }
    })
    request.on('error', rejectBody)
  })
}

export type { Server }
