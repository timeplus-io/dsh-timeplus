/**
 * Timeplus session-query engine: fleet-scale full-text search over the
 * session-event corpus, backed by a derived changelog index in Timeplus and
 * push-down matching/ranking in streaming SQL. Implements the two abstract
 * methods of `SessionQueryEngine`; all exact reads, filters, and traces are
 * inherited from the base class.
 * @module @timeplus/dsh-session-query
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import SessionQueryEngine, {
  SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY,
  SESSION_QUERY_READ_WINDOW_MAX,
  SessionQueryError,
} from '@deepseek-ai/dsh-session-query'
import type {
  SessionEventSearchHit,
  SessionEventSearchPage,
  SessionEventSurface,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
  SessionEventSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import { HttpTimeplusClient } from './client.ts'
import { TimeplusSearchStore, type SearchRow } from './store.ts'
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_PAGE_LIMIT,
  SNIPPET_CHARS,
  normalizeEventRequest,
  normalizeSessionRequest,
  requestFingerprint,
  type NormalizedEventRequest,
  type NormalizedSessionRequest,
} from './query.ts'
import { decodeCursor, encodeCursor } from './cursor.ts'
import { makeSnippet, phrasePattern, phraseRegex } from './text.ts'

export { HttpTimeplusClient, TimeplusHttpError, type TimeplusClient } from './client.ts'
export { TimeplusSearchStore } from './store.ts'

/** Default stream flush_threshold_ms for the derived index (visibility lag bound). */
export const DEFAULT_FLUSH_THRESHOLD_MS = 200
export const DEFAULT_VISIBILITY_POLL_INTERVAL_MS = 20
export const DEFAULT_VISIBILITY_TIMEOUT_MS = 30_000

export interface Config {
  /** Timeplus query/ingest base URL, e.g. http://localhost:8123. */
  url: string
  database?: string
  /** Base name for the derived index streams (`_state` / `_docs` appended). */
  indexStream?: string
  username?: string
  password?: string
  apiKey?: string
  bootstrapSchema?: boolean
  flushThresholdMs?: number
  visibilityPollIntervalMs?: number
  visibilityTimeoutMs?: number
  /** Default page size when a request omits `limit`. */
  defaultLimit?: number
  /** Largest accepted page size. */
  maxLimit?: number
  /** Snippet length in Unicode code points. */
  snippetChars?: number
  /** Inherited: max before/after raw-event window. */
  readWindowMax?: number
  /** Inherited: max concurrent persisted-log inspections per batch read. */
  persistedInspectConcurrency?: number
}

interface ResolvedConfig {
  defaultLimit: number
  maxLimit: number
  snippetChars: number
}

export class TimeplusSessionQueryEngine extends SessionQueryEngine {
  static override inject = ['sessions']

  static Config: z<Config> = z.object({
    url: z.string().required(),
    database: z.string().default('default'),
    indexStream: z.string().default('dsh_session_search'),
    username: z.string(),
    password: z.string().role('secret'),
    apiKey: z.string().role('secret'),
    bootstrapSchema: z.boolean().default(true),
    flushThresholdMs: z.number().step(1).min(1).default(DEFAULT_FLUSH_THRESHOLD_MS),
    visibilityPollIntervalMs: z.number().step(1).min(1).default(DEFAULT_VISIBILITY_POLL_INTERVAL_MS),
    visibilityTimeoutMs: z.number().step(1).min(1).default(DEFAULT_VISIBILITY_TIMEOUT_MS),
    defaultLimit: z.number().step(1).min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_LIMIT),
    maxLimit: z.number().step(1).min(1).max(MAX_PAGE_LIMIT).default(MAX_LIMIT),
    snippetChars: z.number().step(1).min(1).default(SNIPPET_CHARS),
    readWindowMax: z.number().step(1).min(0).default(SESSION_QUERY_READ_WINDOW_MAX),
    persistedInspectConcurrency: z.number().step(1).min(1).default(SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY),
  })

  private readonly store: TimeplusSearchStore
  private readonly resolved: ResolvedConfig
  private readonly instance = randomUUID()
  private tail: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    const defaultLimit = config.defaultLimit ?? DEFAULT_LIMIT
    const maxLimit = config.maxLimit ?? MAX_LIMIT
    if (defaultLimit > maxLimit) {
      throw new SessionQueryError('session-search defaultLimit must be <= maxLimit', 'SESSION_QUERY_INVALID_CONFIG')
    }
    this.resolved = { defaultLimit, maxLimit, snippetChars: config.snippetChars ?? SNIPPET_CHARS }
    const database = config.database ?? 'default'
    this.store = new TimeplusSearchStore({
      client: new HttpTimeplusClient({ url: config.url, database, username: config.username, password: config.password, apiKey: config.apiKey }),
      database,
      indexStream: config.indexStream ?? 'dsh_session_search',
      bootstrapSchema: config.bootstrapSchema ?? true,
      flushThresholdMs: config.flushThresholdMs ?? DEFAULT_FLUSH_THRESHOLD_MS,
      visibilityPollIntervalMs: config.visibilityPollIntervalMs ?? DEFAULT_VISIBILITY_POLL_INTERVAL_MS,
      visibilityTimeoutMs: config.visibilityTimeoutMs ?? DEFAULT_VISIBILITY_TIMEOUT_MS,
    }, ctx)
  }

  protected async [Service.init](): Promise<void> {
    await this.store.init()
  }

  override async searchSessions(request: SessionSearchRequest, exec?: SessionSearchExecContext): Promise<SessionSearchPage<SessionSearchHit>> {
    const normalized = normalizeSessionRequest(request, this.resolved)
    return this.serialize(exec?.signal, () => this.runSearchSessions(normalized, exec?.signal))
  }

  override async searchEvents(request: SessionEventSearchRequest, exec?: SessionSearchExecContext): Promise<SessionEventSearchPage> {
    const normalized = normalizeEventRequest(request, this.resolved)
    return this.serialize(exec?.signal, () => this.runSearchEvents(normalized, exec?.signal))
  }

  private async runSearchSessions(normalized: NormalizedSessionRequest, signal?: AbortSignal): Promise<SessionSearchPage<SessionSearchHit>> {
    await this.store.reconcile(signal)
    signal?.throwIfAborted()
    const generation = this.store.generation()
    const fingerprint = requestFingerprint(normalized)
    const pattern = phrasePattern(normalized.query)
    const offset = normalized.cursor === undefined ? 0 : decodeCursor(normalized.cursor, this.instance, 'sessions', fingerprint, generation)
    if (pattern === undefined) return { items: [] }
    const rows = await this.store.querySessions(normalized, pattern, offset, signal)
    signal?.throwIfAborted()
    const regex = phraseRegex(normalized.query)
    return this.page(rows, normalized.limit, offset, row => this.sessionHit(row, regex), cursorOffset => encodeCursor({
      version: 1, instance: this.instance, scope: 'sessions', fingerprint, generation, offset: cursorOffset,
    }))
  }

  private async runSearchEvents(normalized: NormalizedEventRequest, signal?: AbortSignal): Promise<SessionEventSearchPage> {
    await this.store.reconcile(signal)
    signal?.throwIfAborted()
    const target = await this.store.targetSession(normalized.sessionId, signal)
    if (target === undefined) {
      throw new SessionQueryError(`session "${normalized.sessionId}" not found`, 'SESSION_QUERY_SESSION_NOT_FOUND')
    }
    const generation = target.rev
    const fingerprint = requestFingerprint(normalized)
    const pattern = phrasePattern(normalized.query)
    const offset = normalized.cursor === undefined ? 0 : decodeCursor(normalized.cursor, this.instance, 'events', fingerprint, generation)
    if (pattern === undefined) return { session: target.header, items: [] }
    const rows = await this.store.queryEvents(normalized, pattern, target.source, target.rev, offset, signal)
    signal?.throwIfAborted()
    const regex = phraseRegex(normalized.query)
    const page = this.page(rows, normalized.limit, offset, row => this.eventHit(row, regex), cursorOffset => encodeCursor({
      version: 1, instance: this.instance, scope: 'events', fingerprint, generation, offset: cursorOffset,
    }))
    return { session: target.header, ...page }
  }

  private sessionHit(row: SearchRow, regex: RegExp | undefined): SessionSearchHit {
    return {
      header: searchRowHeader(row),
      live: row.source === 'live',
      persisted: row.source === 'persisted',
      bestMatch: this.eventHit(row, regex),
    }
  }

  private eventHit(row: SearchRow, regex: RegExp | undefined): SessionEventSearchHit {
    return {
      sessionId: row.session_id as SessionId,
      seq: row.seq,
      type: row.type as SessionEventSearchHit['type'],
      time: row.event_time,
      surface: row.surface as SessionEventSurface,
      snippet: makeSnippet(row.text, regex, this.resolved.snippetChars),
    }
  }

  private page<T>(rows: readonly SearchRow[], limit: number, offset: number, convert: (row: SearchRow) => T, nextCursor: (offset: number) => ReturnType<typeof encodeCursor>): SessionSearchPage<T> {
    const hasMore = rows.length > limit
    return {
      items: rows.slice(0, limit).map(convert),
      ...hasMore ? { nextCursor: nextCursor(offset + limit) } : {},
    }
  }

  private serialize<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted()
    const run = this.tail.then(operation, operation)
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }
}

function searchRowHeader(row: SearchRow): SessionHeader {
  return {
    version: row.version,
    id: row.session_id as SessionId,
    createdAt: row.created_at,
    ...row.cwd === null ? {} : { cwd: row.cwd },
    ...row.parent_session === null ? {} : { parentSession: row.parent_session as SessionId },
    ...row.seed_length === null ? {} : { seedLength: row.seed_length },
    ...row.delegation_depth === null ? {} : { delegationDepth: row.delegation_depth },
    ...row.agent_preset === null ? {} : { agentPreset: row.agent_preset },
  }
}

export default TimeplusSessionQueryEngine
