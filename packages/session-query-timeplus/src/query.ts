/**
 * Request normalization, validation, filter→SQL compilation, and the
 * fingerprint that binds a cursor to a normalized request. Error codes and
 * validation rules mirror `@deepseek-ai/dsh-session-query-sqlite/src/query.ts`.
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  SessionQueryError,
  type SessionEventMetadataFilter,
  type SessionEventSearchRequest,
  type SessionEventSurface,
  type SessionResultFilter,
  type SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import type { QueryParams } from './client.ts'
import { normalizeQuery } from './text.ts'

/** Default result page size. */
export const DEFAULT_LIMIT = 20
/** Maximum accepted result page size. */
export const MAX_LIMIT = 100
/** Default snippet length in Unicode code points. */
export const SNIPPET_CHARS = 240
/** Largest accepted page-size configuration. */
export const MAX_PAGE_LIMIT = Number.MAX_SAFE_INTEGER - 1

export interface QueryLimits {
  readonly defaultLimit: number
  readonly maxLimit: number
}

const SURFACES: readonly SessionEventSurface[] = ['current', 'shadowed', 'log-only']
const AVAILABILITY: readonly string[] = ['live', 'persisted']

export interface NormalizedSessionRequest {
  scope: 'sessions'
  query: string
  sessionFilters: SessionResultFilter[]
  eventFilters: SessionEventMetadataFilter[]
  limit: number
  cursor?: string
}

export interface NormalizedEventRequest {
  scope: 'events'
  sessionId: SessionId
  query: string
  filters: SessionEventMetadataFilter[]
  limit: number
  cursor?: string
}

export function normalizeSessionRequest(request: SessionSearchRequest, limits: QueryLimits): NormalizedSessionRequest {
  return {
    scope: 'sessions',
    query: normalizeQuery(request.query),
    sessionFilters: materializeSessionFilters(request.sessionFilters ?? []),
    eventFilters: materializeEventMetadataFilters(request.eventFilters ?? []),
    limit: normalizeLimit(request.limit, limits),
    ...materializeCursor(request.cursor),
  }
}

export function normalizeEventRequest(request: SessionEventSearchRequest, limits: QueryLimits): NormalizedEventRequest {
  if (typeof request.sessionId !== 'string') {
    throw new SessionQueryError('session-search session id must be text', 'SESSION_QUERY_INVALID_FILTER')
  }
  return {
    scope: 'events',
    sessionId: request.sessionId,
    query: normalizeQuery(request.query),
    filters: materializeEventMetadataFilters(request.filters ?? []),
    limit: normalizeLimit(request.limit, limits),
    ...materializeCursor(request.cursor),
  }
}

function normalizeLimit(value: number | undefined, limits: QueryLimits): number {
  const ceiling = Math.min(limits.maxLimit, MAX_PAGE_LIMIT)
  const resolved = value ?? limits.defaultLimit
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > ceiling) {
    throw new SessionQueryError(`session-search limit must be an integer between 1 and ${ceiling}`, 'SESSION_QUERY_INVALID_LIMIT')
  }
  return resolved
}

function materializeCursor(cursor: unknown): { cursor?: string } {
  if (cursor === undefined) return {}
  if (typeof cursor !== 'string') {
    throw new SessionQueryError('session-search cursor must be text', 'SESSION_QUERY_INVALID_CURSOR')
  }
  return { cursor }
}

function invalidFilter(detail: string): SessionQueryError {
  return new SessionQueryError(`session-search filter is invalid: ${detail}`, 'SESSION_QUERY_INVALID_FILTER')
}

function assertRange(clause: { from?: unknown; to?: unknown }, kind: string): void {
  for (const [name, value] of [['from', clause.from], ['to', clause.to]] as const) {
    if (value !== undefined && !Number.isFinite(value as number)) throw invalidFilter(`${kind} ${name} must be a number`)
  }
  if (typeof clause.from === 'number' && typeof clause.to === 'number' && clause.from > clause.to) {
    throw invalidFilter(`${kind} range is empty (from > to)`)
  }
}

export function materializeSessionFilters(filters: readonly SessionResultFilter[]): SessionResultFilter[] {
  if (!Array.isArray(filters)) throw invalidFilter('session filters must be an array')
  return filters.map((filter): SessionResultFilter => {
    switch (filter.kind) {
      case 'id': return { kind: 'id', values: assertStringList(filter.values, 'id') as SessionId[] }
      case 'cwd': return { kind: 'cwd', values: assertNullableStringList(filter.values, 'cwd') }
      case 'parent': return { kind: 'parent', values: assertNullableStringList(filter.values, 'parent') as (SessionId | null)[] }
      case 'created-at': assertRange(filter, 'created-at'); return { kind: 'created-at', ...pickRange(filter) }
      case 'availability': {
        const values = assertStringList(filter.values, 'availability')
        for (const value of values) if (!AVAILABILITY.includes(value)) throw invalidFilter(`availability "${value}" is not supported`)
        return { kind: 'availability', values: values as ('live' | 'persisted')[] }
      }
      default: throw invalidFilter(`unknown session filter kind "${(filter as { kind: string }).kind}"`)
    }
  })
}

export function materializeEventMetadataFilters(filters: readonly SessionEventMetadataFilter[]): SessionEventMetadataFilter[] {
  if (!Array.isArray(filters)) throw invalidFilter('event filters must be an array')
  return filters.map((filter): SessionEventMetadataFilter => {
    switch (filter.kind) {
      case 'seq': assertRange(filter, 'seq'); return { kind: 'seq', ...pickRange(filter) }
      case 'time': assertRange(filter, 'time'); return { kind: 'time', ...pickRange(filter) }
      case 'type': return { kind: 'type', values: assertStringList(filter.values, 'type') as SessionEventMetadataFilter extends { kind: 'type'; values: infer V } ? V : never }
      case 'surface': {
        const values = assertStringList(filter.values, 'surface')
        for (const value of values) if (!SURFACES.includes(value as SessionEventSurface)) throw invalidFilter(`surface "${value}" is not supported`)
        return { kind: 'surface', values: values as SessionEventSurface[] }
      }
      default: throw invalidFilter(`event filter kind "${(filter as { kind: string }).kind}" is not allowed here`)
    }
  })
}

function pickRange(clause: { from?: number; to?: number }): { from?: number; to?: number } {
  return {
    ...clause.from === undefined ? {} : { from: clause.from },
    ...clause.to === undefined ? {} : { to: clause.to },
  }
}

function assertStringList(values: unknown, kind: string): string[] {
  if (!Array.isArray(values)) throw invalidFilter(`${kind} values must be an array`)
  return values.map((value) => {
    if (typeof value !== 'string') throw invalidFilter(`${kind} values must be strings`)
    return value
  })
}

function assertNullableStringList(values: unknown, kind: string): (string | null)[] {
  if (!Array.isArray(values)) throw invalidFilter(`${kind} values must be an array`)
  return values.map((value) => {
    if (value !== null && typeof value !== 'string') throw invalidFilter(`${kind} values must be strings or null`)
    return value
  })
}

/** Deterministic identity of a normalized request, stored inside the cursor. */
export function requestFingerprint(request: NormalizedSessionRequest | NormalizedEventRequest): string {
  const canonical = request.scope === 'events'
    ? { scope: 'events', sessionId: request.sessionId, query: request.query, filters: canonicalFilters(request.filters), limit: request.limit }
    : { scope: 'sessions', query: request.query, sessionFilters: canonicalFilters(request.sessionFilters), eventFilters: canonicalFilters(request.eventFilters), limit: request.limit }
  return JSON.stringify(canonical)
}

function canonicalFilters(filters: readonly (SessionResultFilter | SessionEventMetadataFilter)[]): unknown[] {
  return filters
    .map((filter) => {
      if ('values' in filter) {
        const sorted = [...filter.values].sort(compareNullable)
        return { kind: filter.kind, values: sorted }
      }
      return { kind: filter.kind, ...pickRange(filter) }
    })
    .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1))
}

function compareNullable(a: string | number | null, b: string | number | null): number {
  if (a === null) return b === null ? 0 : -1
  if (b === null) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** Accumulates unique named Timeplus query parameters (`{name:type}`). */
export class Binder {
  private index = 0
  readonly params: Record<string, string | number> = {}
  bind(value: string | number): string {
    const name = `p${this.index++}`
    this.params[name] = value
    return name
  }
  get typed(): QueryParams {
    return this.params
  }
}

/** Compile session-scope metadata filters into a WHERE fragment over the state row `s`. */
export function buildSessionWhere(filters: readonly SessionResultFilter[], binder: Binder): string[] {
  const clauses: string[] = []
  for (const filter of filters) {
    switch (filter.kind) {
      case 'id':
        clauses.push(inClause('s.session_id', filter.values, binder, 'string'))
        break
      case 'cwd':
        clauses.push(nullableInClause('s.cwd', filter.values, binder))
        break
      case 'parent':
        clauses.push(nullableInClause('s.parent_session', filter.values, binder))
        break
      case 'created-at':
        clauses.push(...rangeClauses('s.created_at', filter, binder))
        break
      case 'availability':
        if (filter.values.length === 1) clauses.push(`s.source = '${filter.values[0] === 'live' ? 'live' : 'persisted'}'`)
        break
    }
  }
  return clauses
}

/** Compile event-scope metadata filters into a WHERE fragment over the doc row `d`. */
export function buildEventWhere(filters: readonly SessionEventMetadataFilter[], binder: Binder): string[] {
  const clauses: string[] = []
  for (const filter of filters) {
    switch (filter.kind) {
      case 'seq':
        clauses.push(...rangeClauses('d.seq', filter, binder))
        break
      case 'time':
        clauses.push(...rangeClauses('d.event_time', filter, binder))
        break
      case 'type':
        clauses.push(inClause('d.type', filter.values, binder, 'string'))
        break
      case 'surface':
        clauses.push(inClause("to_string(d.surface)", filter.values, binder, 'string'))
        break
    }
  }
  return clauses
}

function inClause(column: string, values: readonly string[], binder: Binder, type: 'string'): string {
  if (values.length === 0) return '1 = 0'
  const placeholders = values.map(value => `{${binder.bind(value)}:${type}}`)
  return `${column} IN (${placeholders.join(', ')})`
}

function nullableInClause(column: string, values: readonly (string | null)[], binder: Binder): string {
  const nonNull = values.filter((value): value is string => value !== null)
  const hasNull = values.length !== nonNull.length
  const parts: string[] = []
  if (nonNull.length > 0) parts.push(`${column} IN (${nonNull.map(value => `{${binder.bind(value)}:string}`).join(', ')})`)
  if (hasNull) parts.push(`${column} IS NULL`)
  if (parts.length === 0) return '1 = 0'
  return `(${parts.join(' OR ')})`
}

function rangeClauses(column: string, range: { from?: number; to?: number }, binder: Binder): string[] {
  const clauses: string[] = []
  if (range.from !== undefined) clauses.push(`${column} >= {${binder.bind(range.from)}:int64}`)
  if (range.to !== undefined) clauses.push(`${column} <= {${binder.bind(range.to)}:int64}`)
  return clauses
}
