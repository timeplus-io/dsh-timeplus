/**
 * Shared live-Timeplus test scaffolding. Suites are isolated by stream name
 * and re-runnable against one long-lived Proton container: primitive-level
 * tests take a fresh stream each (`freshStore`), while the long upstream
 * contract suites share one stream per file and TRUNCATE it between tests
 * (`useSharedStream`) — on a default-configured Proton every stream
 * preallocates a 2 GB NativeLog segment, so stream churn is the expensive
 * part (see docker/proton/config.d/dsh-dev.yaml).
 */

import { randomUUID } from 'node:crypto'
import { afterAll } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { HttpTimeplusClient } from '../src/client.ts'
import { TimeplusStore, type TimeplusStoreOptions } from '../src/store.ts'
import TimeplusSessionPersistence, { type Config } from '../src/index.ts'

export const TIMEPLUS_URL = process.env['TIMEPLUS_URL']
export const DATABASE = process.env['TIMEPLUS_DATABASE'] ?? 'default'

/** Fast flush for tests: keeps each append's read-your-writes wait short. */
export const TEST_FLUSH_THRESHOLD_MS = 50

export function freshStreamName(prefix = 'dsh_test'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`
}

export function requireUrl(): string {
  if (TIMEPLUS_URL === undefined) throw new Error('TIMEPLUS_URL is not set')
  return TIMEPLUS_URL
}

export function rawClient(): HttpTimeplusClient {
  return new HttpTimeplusClient({ url: requireUrl(), database: DATABASE })
}

export async function dropStream(stream: string): Promise<void> {
  await rawClient().execute(`DROP STREAM IF EXISTS \`${DATABASE}\`.\`${stream}\``)
}

/**
 * Empty a stream and wait until `table()` reflects it: like ingest,
 * truncation is acknowledged before the historical store catches up
 * (measured ~60 ms on Proton), so a reset must be read back before reuse.
 */
export async function truncateStream(stream: string): Promise<void> {
  const client = rawClient()
  const qualified = `\`${DATABASE}\`.\`${stream}\``
  const exists = await client.query<{ n: number }>(
    'SELECT count() AS n FROM system.tables WHERE database = {db:string} AND name = {name:string}',
    { db: DATABASE, name: stream },
  )
  if ((exists[0]?.n ?? 0) === 0) return // nothing mounted yet; bootstrap creates it
  await client.execute(`TRUNCATE STREAM ${qualified}`)
  const deadline = Date.now() + 10_000
  for (;;) {
    const rows = await client.query<{ n: number }>(`SELECT count() AS n FROM table(${qualified})`)
    if ((rows[0]?.n ?? 0) === 0) return
    if (Date.now() > deadline) throw new Error(`stream ${stream} did not empty after TRUNCATE`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/**
 * One stream for the calling test file, dropped after the file's tests.
 * `reset()` empties it so each test starts from an empty backend without
 * creating a new stream.
 */
export function useSharedStream(prefix = 'dsh_shared'): { stream: string; reset: () => Promise<void> } {
  const stream = freshStreamName(prefix)
  afterAll(async () => {
    if (TIMEPLUS_URL !== undefined) await dropStream(stream)
  })
  return { stream, reset: () => truncateStream(stream) }
}

/** A store over a fresh stream, bypassing the Service (unit-level primitives). */
export async function freshStore(overrides: Partial<TimeplusStoreOptions> = {}): Promise<{
  store: TimeplusStore
  stream: string
  cleanup: () => Promise<void>
}> {
  const stream = overrides.stream ?? freshStreamName()
  const store = new TimeplusStore({
    client: rawClient(),
    database: DATABASE,
    stream,
    bootstrapSchema: true,
    flushThresholdMs: TEST_FLUSH_THRESHOLD_MS,
    visibilityPollIntervalMs: 10,
    visibilityTimeoutMs: 10_000,
    ...overrides,
  })
  await store.init()
  return {
    store,
    stream,
    cleanup: async () => {
      await store.close()
      await dropStream(stream)
    },
  }
}

export function pluginConfig(stream: string, overrides: Partial<Config> = {}): Config {
  return {
    url: requireUrl(),
    database: DATABASE,
    stream,
    flushThresholdMs: TEST_FLUSH_THRESHOLD_MS,
    visibilityPollIntervalMs: 10,
    visibilityTimeoutMs: 10_000,
    ...overrides,
  }
}

/** Mount the real provider over a fresh stream through a Cordis root. */
export async function mountPersistence(stream = freshStreamName(), overrides: Partial<Config> = {}): Promise<{
  ctx: Context
  fiber: Fiber
  stream: string
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(TimeplusSessionPersistence, pluginConfig(stream, overrides))
  return {
    ctx,
    fiber,
    stream,
    dispose: async () => {
      await ctx.fiber.dispose()
      await dropStream(stream)
    },
  }
}

/** Mount over an existing (shared) stream; disposal only tears the root down. */
export async function mountShared(stream: string, overrides: Partial<Config> = {}): Promise<{
  ctx: Context
  fiber: Fiber
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(TimeplusSessionPersistence, pluginConfig(stream, overrides))
  return { ctx, fiber, dispose: () => ctx.fiber.dispose() }
}
