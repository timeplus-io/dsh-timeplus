/**
 * Timeplus durable session-persistence provider for DeepSeek Harness.
 * Wiring intentionally mirrors `@deepseek-ai/dsh-session-persistence-sqlite`:
 * the Service delegates orchestration to `PersistenceCoordinator` and the
 * `TimeplusStore` backend supplies durable primitives. See DESIGN.md.
 * @module @timeplus/dsh-session-persistence
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SessionEvent, SessionHeader, SessionId, SessionPreparation } from '@deepseek-ai/dsh-session'
import {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
  MAX_WRITE_BATCH_DELAY_MS,
  PersistenceCoordinator,
  SessionPersistence,
  type SessionInspection,
  type SessionLocation,
  type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import { HttpTimeplusClient } from './client.ts'
import { TimeplusStore } from './store.ts'

export { HttpTimeplusClient, TimeplusHttpError, type TimeplusClient } from './client.ts'
export { TimeplusStore, type TimeplusStoreOptions } from './store.ts'

/** Default stream `flush_threshold_ms`; bounds ingest-to-queryable lag (DESIGN.md §4.2). */
export const DEFAULT_FLUSH_THRESHOLD_MS = 200
/** Default interval between read-your-writes watermark polls. */
export const DEFAULT_VISIBILITY_POLL_INTERVAL_MS = 20
/** Default bound on waiting for an acknowledged batch to become queryable. */
export const DEFAULT_VISIBILITY_TIMEOUT_MS = 30_000

export interface Config {
  /** Timeplus query/ingest base URL, e.g. http://localhost:8123. */
  url: string
  database?: string
  /** Canonical event stream name. */
  stream?: string
  username?: string
  password?: string
  /** Timeplus Enterprise/Cloud API key (sent as `X-Api-Key`). */
  apiKey?: string
  /** CREATE STREAM IF NOT EXISTS at init. */
  bootstrapSchema?: boolean
  /**
   * Stream `flush_threshold_ms` applied when this provider creates the
   * stream. Lower values shorten every append's read-your-writes wait but
   * produce more (small) historical parts. Ignored for pre-existing streams.
   */
  flushThresholdMs?: number
  /** Interval between watermark polls while waiting for a batch to become queryable. */
  visibilityPollIntervalMs?: number
  /** Maximum wait for an acknowledged batch to become queryable before failing the append. */
  visibilityTimeoutMs?: number
  preparedSessionCacheSize?: number
  writeBatchMaxDelayMs?: number
}

export class TimeplusSessionPersistence extends SessionPersistence {
  override readonly supportsRawArtifacts = false
  override readonly name = 'session-persistence-timeplus'

  static inject = ['sessions']

  static Config: z<Config> = z.object({
    url: z.string().required(),
    database: z.string().default('default'),
    stream: z.string().default('dsh_session_events'),
    username: z.string(),
    password: z.string().role('secret'),
    apiKey: z.string().role('secret'),
    bootstrapSchema: z.boolean().default(true),
    flushThresholdMs: z.number().step(1).min(1).default(DEFAULT_FLUSH_THRESHOLD_MS),
    visibilityPollIntervalMs: z.number().step(1).min(1).default(DEFAULT_VISIBILITY_POLL_INTERVAL_MS),
    visibilityTimeoutMs: z.number().step(1).min(1).default(DEFAULT_VISIBILITY_TIMEOUT_MS),
    preparedSessionCacheSize: z.number().step(1).min(1).default(DEFAULT_PREPARED_SESSION_CACHE_SIZE),
    writeBatchMaxDelayMs: z.number().step(1).min(1).max(MAX_WRITE_BATCH_DELAY_MS)
      .default(DEFAULT_WRITE_BATCH_MAX_DELAY_MS),
  })

  private readonly store: TimeplusStore
  private readonly coordinator: PersistenceCoordinator<undefined>

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    const database = config.database ?? 'default'
    this.store = new TimeplusStore({
      client: new HttpTimeplusClient({
        url: config.url,
        database,
        username: config.username,
        password: config.password,
        apiKey: config.apiKey,
      }),
      database,
      stream: config.stream ?? 'dsh_session_events',
      bootstrapSchema: config.bootstrapSchema ?? true,
      flushThresholdMs: config.flushThresholdMs ?? DEFAULT_FLUSH_THRESHOLD_MS,
      visibilityPollIntervalMs: config.visibilityPollIntervalMs ?? DEFAULT_VISIBILITY_POLL_INTERVAL_MS,
      visibilityTimeoutMs: config.visibilityTimeoutMs ?? DEFAULT_VISIBILITY_TIMEOUT_MS,
    })
    this.coordinator = new PersistenceCoordinator(this.ctx, this.store, {
      preparedSessionCacheSize: config.preparedSessionCacheSize ?? DEFAULT_PREPARED_SESSION_CACHE_SIZE,
      writeBatchMaxDelayMs: config.writeBatchMaxDelayMs ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
    })
  }

  /** Connectivity + schema bootstrap; fail fast on an unreachable store. */
  protected async [Service.init](): Promise<void> {
    await this.store.init()
  }

  locate(_meta: SessionHeader): SessionLocation | undefined {
    return undefined
  }

  create(meta: SessionHeader): Promise<void> {
    return this.coordinator.create(meta)
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events)
  }

  override prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    return this.coordinator.prepare(id, signal)
  }

  load(id: SessionId): Promise<SessionInspection> {
    return this.coordinator.load(id)
  }

  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    return this.coordinator.inspect(id, signal)
  }

  readFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.readFrom(id, fromSeq, signal)
  }

  list(signal?: AbortSignal): Promise<SessionHeader[]> {
    return this.store.list(signal)
  }

  listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    return this.store.listSnapshots(signal)
  }
}

export default TimeplusSessionPersistence
