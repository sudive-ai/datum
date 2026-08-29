import Schema from '@sudive-ai/schemastery'

/**
 * The workbench configuration, as the user authors it.
 *
 * Every deployment-varying choice is a validated config field here — no
 * hidden `?? default` inside operations. `resolveWorkbenchConfig` is the one
 * explicit resolution step.
 */
export interface WorkbenchConfig {
  /** HTTP port for the local workbench. */
  readonly port: number
  /** The agent composition this workbench drives. */
  readonly agent: {
    readonly name: string
    readonly systemPrompt: string
    readonly model: string
    readonly maxTokens: number
  }
  /** The LLM provider binding. */
  readonly llm: {
    /** `'mock'` runs keyless (demo/test); `'openai-compatible'` is the real seam. */
    readonly provider: 'openai-compatible' | 'mock'
    /** Required for the openai-compatible provider. */
    readonly baseUrl: string | undefined
    /** Environment variable carrying the API key; never the key itself. */
    readonly apiKeyEnv: string
    /** Model override; defaults to `agent.model`. */
    readonly model: string | undefined
  }
  /** User plugin module paths, resolved against the process cwd. */
  readonly plugins: readonly string[]
  /** The storage engine binding (session facts survive restarts). */
  readonly storage: {
    /** `'sqlite'` is the default local engine; `'postgres'` is opt-in; `'memory'` is ephemeral. */
    readonly engine: 'memory' | 'sqlite' | 'postgres'
    /** SQLite database file path (created if missing). */
    readonly path: string
    /** Environment variable carrying the PostgreSQL connection string. */
    readonly connectionStringEnv: string
  }
}

/** The schema validating user-authored workbench config. */
export const workbenchConfigSchema = Schema.intersect([
  Schema.object({
    port: Schema.natural().default(8642).description('HTTP port for the local workbench'),
    plugins: Schema.array(Schema.string()).default([]).description('user plugin module paths'),
  }),
  Schema.object({
    storage: Schema.object({
      engine: Schema.union(['memory', 'sqlite', 'postgres']).default('sqlite'),
      path: Schema.string().default('datum.db'),
      connectionStringEnv: Schema.string().default('DATUM_PG_URL'),
    }).default({
      engine: 'sqlite',
      path: 'datum.db',
      connectionStringEnv: 'DATUM_PG_URL',
    } as never),
  }),
  Schema.object({
    agent: Schema.object({
      name: Schema.string().default('datum-agent'),
      systemPrompt: Schema.string().default('You are a Datum agent. Be concise and honest.'),
      model: Schema.string().default('gpt-4o-mini'),
      maxTokens: Schema.natural().default(2048),
    }).default({
      name: 'datum-agent',
      systemPrompt: 'You are a Datum agent. Be concise and honest.',
      model: 'gpt-4o-mini',
      maxTokens: 2048,
    }),
  }),
  Schema.object({
    llm: Schema.object({
      provider: Schema.union(['openai-compatible', 'mock']).default('mock'),
      baseUrl: Schema.string(),
      apiKeyEnv: Schema.string().default('OPENAI_API_KEY'),
      model: Schema.string(),
    }).default({
      provider: 'mock',
      apiKeyEnv: 'OPENAI_API_KEY',
      // baseUrl/model are provider-conditional; schemastery's default typing
      // demands the full shape, so the partial default is supplied loosely.
    } as never),
  }),
])

/**
 * Resolve and validate user config into the workbench spec — the explicit
 * resolution step; misconfiguration fails here, at the earliest resolvable
 * point, before anything starts.
 *
 * @param input — raw config (e.g. parsed from `datum.config` or test code).
 * @returns the resolved config with every default applied.
 * @throws when the config does not satisfy the schema (fail loud).
 */
export function resolveWorkbenchConfig(input: unknown): WorkbenchConfig {
  const validate = workbenchConfigSchema as (value: unknown) => unknown
  return validate(input) as WorkbenchConfig
}
