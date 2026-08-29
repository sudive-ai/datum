/**
 * hello-agent — start a personal workbench in one file.
 *
 * Your workbench = a config (this file's `config` object) + your plugins
 * (see `hello-plugin.ts`). Run it with:
 *
 *   pnpm demo
 *
 * Then open the printed URL. Switch to a real model by filling the
 * `openai-compatible` branch and exporting the API key environment variable —
 * keys never live in config files or in the log.
 */
import { resolveWorkbenchConfig, startWorkbench } from '@sudive-ai/datum-workbench'

const config = resolveWorkbenchConfig({
  port: Number(process.env.PORT ?? 8642),
  agent: {
    name: 'hello-agent',
    systemPrompt: 'You are the user\'s personal agent. Introduce yourself briefly on the first turn.',
    model: process.env.LLM_MODEL ?? 'gpt-4o-mini',
    maxTokens: 2048,
  },
  llm: {
    // Default 'mock' runs keyless — perfect for a first look. For a real
    // model, either edit here or set environment variables:
    //   LLM_PROVIDER=openai-compatible LLM_BASE_URL=https://api.deepseek.com/v1 \
    //   LLM_MODEL=deepseek-v4-chat OPENAI_API_KEY=sk-... pnpm demo
    provider: process.env.LLM_PROVIDER === 'openai-compatible' ? 'openai-compatible' : 'mock',
    baseUrl: process.env.LLM_BASE_URL, // e.g. https://api.deepseek.com/v1
    apiKeyEnv: 'OPENAI_API_KEY', // export the key; it never lives in files or the log
  },
  plugins: [new URL('./hello-plugin.ts', import.meta.url).pathname],
})

const workbench = await startWorkbench(config)
console.log(`Datum workbench running:  http://127.0.0.1:${workbench.port}`)
console.log('Ctrl+C to stop; the session log lives in memory for this demo (JSONL persistence lands next).')
