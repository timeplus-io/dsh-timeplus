/**
 * The derived Timeplus search index: reconcile the changelog projection from
 * `sessionPersistence` + live `ctx.sessions`, then answer searches as push-down
 * SQL over it. Text extraction uses the shared `buildSessionEventSearchDocuments`
 * (semantic, surface-aware); ranking and matching run in Proton via
 * `match()` / `count_matches()`; snippets are built in-process by the engine.
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import { SessionQueryError, buildSessionEventSearchDocuments } from '@deepseek-ai/dsh-session-query'
import type { SessionEventSearchDocument } from '@deepseek-ai/dsh-session-query'
import type { TimeplusClient } from './client.ts'
import { DOC_COLUMNS, STATE_COLUMNS, bootstrapSchema, docsStream, stateStream, type SchemaConfig } from './schema.ts'
import { Binder, buildEventWhere, buildSessionWhere, type NormalizedEventRequest, type NormalizedSessionRequest } from './query.ts'
import { codePointLength, sanitizeText } from './text.ts'

type Source = 'persisted' | 'live'

/** A candidate row returned by the push-down search SQL. */
export interface SearchRow {
  session_id: string
  source: Source
  seq: number
  type: string
  event_time: number
  surface: string
  text: string
  text_len: number
  mc: number
  version: number
  created_at: number
  cwd: string | null
  parent_session: string | null
  seed_length: number | null
  delegation_depth: number | null
  agent_preset: string | null
}

interface StateRow {
  source: Source
  session_id: string
  rev: string
  version: number
  created_at: number
  cwd: string | null
  parent_session: string | null
  seed_length: number | null
  delegation_depth: number | null
  agent_preset: string | null
}

interface ObservedSession {
  header: SessionHeader
  rev: string
  documents: SessionEventSearchDocument[]
  /** A persisted entry whose live owner shadows it: refresh state, keep docs. */
  unchangedShadowed?: boolean
}

export interface TimeplusSearchStoreOptions extends SchemaConfig {
  readonly client: TimeplusClient
  readonly bootstrapSchema: boolean
  readonly visibilityPollIntervalMs: number
  readonly visibilityTimeoutMs: number
}

export class TimeplusSearchStore {
  private ready: Promise<void> | undefined
  private readonly state: string
  private readonly docs: string
  /** Bumped whenever a reconcile writes a change; feeds the sessions-scope cursor generation. */
  private globalGeneration = 0

  constructor(private readonly options: TimeplusSearchStoreOptions, private readonly ctx: Context) {
    this.state = stateStream(options)
    this.docs = docsStream(options)
  }

  init(): Promise<void> {
    this.ready ??= this.options.bootstrapSchema
      ? bootstrapSchema(this.options.client, this.options)
      : Promise.resolve()
    return this.ready
  }

  /** Current sessions-scope cursor generation token. */
  generation(): string {
    return String(this.globalGeneration)
  }

  private persistence(): SessionPersistence | undefined {
    return this.ctx.get('sessionPersistence')
  }

  /**
   * Bring the index up to date with the current corpus. Single observation
   * (no stability retry — a limitation vs. the SQLite engine, acceptable for
   * v1). Returns after the writes are visible to `table()`.
   */
  async reconcile(signal?: AbortSignal): Promise<void> {
    await this.init()
    signal?.throwIfAborted()
    const persistence = this.persistence()
    const indexed = await this.readState(signal)

    const observed = new Map<string, ObservedSession>() // key: `${source}\0${id}`
    const liveIds = new Set<SessionId>()

    for (const session of this.ctx.sessions.list()) {
      liveIds.add(session.id)
      observed.set(key('live', session.id), observeLive(session))
    }
    if (persistence !== undefined) {
      let snapshots
      try {
        snapshots = await persistence.listSnapshots(signal)
      } catch (error: unknown) {
        if (signal?.aborted) throw aborted(error)
        throw new SessionQueryError(`session-search persistence observation failed: ${message(error)}`, 'SESSION_QUERY_PERSISTENCE_FAILED', { cause: error })
      }
      signal?.throwIfAborted()
      for (const snapshot of snapshots) {
        const id = snapshot.header.id
        const existing = indexed.get(key('persisted', id))
        if (existing?.rev === snapshot.revision) {
          observed.set(key('persisted', id), { header: structuredClone(snapshot.header), rev: snapshot.revision, documents: [] })
          continue // unchanged; keep as-is (documents untouched)
        }
        // Skip loading when a live owner shadows it: the live copy is authoritative.
        if (this.ctx.sessions.get(id) !== undefined) {
          observed.set(key('persisted', id), { header: structuredClone(snapshot.header), rev: snapshot.revision, documents: [], unchangedShadowed: true })
          continue
        }
        let loaded
        try {
          loaded = await persistence.inspect(id, signal)
        } catch (error: unknown) {
          if (signal?.aborted) throw aborted(error)
          throw new SessionQueryError(`session-search persistence observation failed: ${message(error)}`, 'SESSION_QUERY_PERSISTENCE_FAILED', { cause: error })
        }
        signal?.throwIfAborted()
        observed.set(key('persisted', id), {
          header: structuredClone(loaded.meta),
          rev: snapshot.revision,
          documents: buildSessionEventSearchDocuments(loaded.meta.id, loaded.events),
        })
      }
    }

    // Diff against the index and stage writes.
    const stateWrites: unknown[][] = []
    const docWrites: unknown[][] = []
    // For each changed non-shadowed session: how many non-deleted docs should
    // carry its new rev once writes are visible (feeds the doc-visibility wait).
    const expectedDocs = new Map<string, { rev: string; count: number }>()
    let changed = false

    for (const [k, entry] of observed) {
      const prior = indexed.get(k)
      const [source] = splitKey(k)
      const rev = entry.rev
      if (prior?.rev === rev) continue // already current
      // A shadowed-persisted entry we chose not to reload: only refresh its header/rev, keep docs.
      const shadowed = entry.unchangedShadowed === true
      changed = true
      stateWrites.push(stateRowValues(source, entry.header, rev, 0))
      if (!shadowed) {
        const priorSeqs = prior === undefined ? [] : await this.readDocSeqs(source, entry.header.id, signal)
        const nextSeqs = new Set(entry.documents.map(document => document.seq))
        for (const seq of priorSeqs) if (!nextSeqs.has(seq)) docWrites.push(tombstoneDocValues(source, entry.header.id, seq))
        for (const document of entry.documents) docWrites.push(docRowValues(source, entry.header.id, rev, document))
        expectedDocs.set(k, { rev, count: entry.documents.length })
      }
    }

    // Tombstone index rows whose session is no longer observed.
    for (const [k, prior] of indexed) {
      if (observed.has(k)) continue
      const [source, id] = splitKey(k)
      // A live row disappears when the session ends; a persisted row only when
      // persistence drops it (or is unmounted). Either way, remove it.
      changed = true
      stateWrites.push(stateTombstoneValues(source, prior))
      for (const seq of await this.readDocSeqs(source, id, signal)) docWrites.push(tombstoneDocValues(source, id, seq))
    }

    if (!changed) return
    if (stateWrites.length > 0) await this.options.client.ingest(this.state, STATE_COLUMNS, stateWrites, signal)
    if (docWrites.length > 0) await this.options.client.ingest(this.docs, DOC_COLUMNS, docWrites, signal)
    await this.awaitVisible(observed, indexed, expectedDocs, signal)
    this.globalGeneration += 1
    void liveIds
  }

  async querySessions(request: NormalizedSessionRequest, pattern: string, offset: number, signal?: AbortSignal): Promise<SearchRow[]> {
    const binder = new Binder()
    const pat = binder.bind(pattern)
    const eventWhere = buildEventWhere(request.eventFilters, binder)
    const sessionWhere = buildSessionWhere(request.sessionFilters, binder)
    const where = [`match(d.text, {${pat}:string})`, ...eventWhere, ...sessionWhere].join(' AND ')
    const lim = binder.bind(request.limit + 1)
    const off = binder.bind(offset)
    const sql = `
      WITH live_ids AS (SELECT session_id FROM table(${this.state}) WHERE source = 'live' AND deleted = 0),
      s AS (
        SELECT * FROM table(${this.state}) AS st
        WHERE st.deleted = 0 AND (st.source = 'live' OR st.session_id NOT IN (SELECT session_id FROM live_ids))
      ),
      cand AS (
        SELECT d.session_id AS session_id, s.source AS source, d.seq AS seq, d.type AS type,
               d.event_time AS event_time, to_string(d.surface) AS surface, d.text AS text, d.text_len AS text_len,
               s.version AS version, s.created_at AS created_at, s.cwd AS cwd, s.parent_session AS parent_session,
               s.seed_length AS seed_length, s.delegation_depth AS delegation_depth, s.agent_preset AS agent_preset,
               count_matches(d.text, {${pat}:string}) AS mc
        FROM table(${this.docs}) AS d
        JOIN s ON s.source = d.source AND s.session_id = d.session_id AND d.rev = s.rev
        WHERE d.deleted = 0 AND ${where}
      ),
      ranked AS (
        SELECT *, row_number() OVER (
          PARTITION BY session_id ORDER BY mc DESC, text_len ASC, event_time DESC, seq DESC
        ) AS rk FROM cand
      )
      SELECT * FROM ranked WHERE rk = 1
      ORDER BY mc DESC, text_len ASC, event_time DESC, session_id ASC, seq DESC
      LIMIT {${lim}:int64} OFFSET {${off}:int64}`
    return this.options.client.query<SearchRow>(sql, binder.typed, signal)
  }

  async queryEvents(request: NormalizedEventRequest, pattern: string, source: Source, rev: string, offset: number, signal?: AbortSignal): Promise<SearchRow[]> {
    const binder = new Binder()
    const pat = binder.bind(pattern)
    const sid = binder.bind(request.sessionId as string)
    const src = binder.bind(source)
    const rv = binder.bind(rev)
    const eventWhere = buildEventWhere(request.filters, binder)
    const where = [`d.deleted = 0`, `d.source = {${src}:string}`, `d.session_id = {${sid}:string}`, `d.rev = {${rv}:string}`, `match(d.text, {${pat}:string})`, ...eventWhere].join(' AND ')
    const lim = binder.bind(request.limit + 1)
    const off = binder.bind(offset)
    // Only the event-hit columns; the page header comes from targetSession().
    const sql = `
      SELECT d.session_id AS session_id, d.seq AS seq, d.type AS type,
             d.event_time AS event_time, to_string(d.surface) AS surface, d.text AS text, d.text_len AS text_len,
             count_matches(d.text, {${pat}:string}) AS mc
      FROM table(${this.docs}) AS d
      WHERE ${where}
      ORDER BY mc DESC, text_len ASC, event_time DESC, seq DESC
      LIMIT {${lim}:int64} OFFSET {${off}:int64}`
    return this.options.client.query<SearchRow>(sql, binder.typed, signal)
  }

  /** The live-preferred target header + its rev (cursor generation), or undefined if absent. */
  async targetSession(sessionId: SessionId, signal?: AbortSignal): Promise<{ header: SessionHeader; source: Source; rev: string } | undefined> {
    const binder = new Binder()
    const sid = binder.bind(sessionId as string)
    const rows = await this.options.client.query<StateRow>(
      `SELECT source, session_id, rev, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset
       FROM table(${this.state}) WHERE session_id = {${sid}:string} AND deleted = 0 ORDER BY source DESC LIMIT 1`,
      binder.typed,
      signal,
    )
    const row = rows[0]
    if (row === undefined) return undefined
    return { header: rowHeader(row), source: row.source, rev: row.rev }
  }

  private async readState(signal?: AbortSignal): Promise<Map<string, StateRow>> {
    const rows = await this.options.client.query<StateRow>(
      `SELECT source, session_id, rev, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset FROM table(${this.state}) WHERE deleted = 0`,
      {},
      signal,
    )
    const map = new Map<string, StateRow>()
    for (const row of rows) map.set(key(row.source, row.session_id as SessionId), row)
    return map
  }

  private async readDocSeqs(source: Source, id: SessionId, signal?: AbortSignal): Promise<number[]> {
    const binder = new Binder()
    const src = binder.bind(source)
    const sid = binder.bind(id as string)
    const rows = await this.options.client.query<{ seq: number }>(
      `SELECT seq FROM table(${this.docs}) WHERE source = {${src}:string} AND session_id = {${sid}:string} AND deleted = 0`,
      binder.typed,
      signal,
    )
    return rows.map(row => row.seq)
  }

  /** Poll until both index streams reflect the reconcile: state revisions,
   * removed sessions gone, and each changed session's new-rev docs present. */
  private async awaitVisible(
    observed: Map<string, ObservedSession>,
    indexed: Map<string, StateRow>,
    expectedDocs: Map<string, { rev: string; count: number }>,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + this.options.visibilityTimeoutMs
    for (;;) {
      const current = await this.readState(signal)
      let ok = true
      for (const [k, entry] of observed) if (current.get(k)?.rev !== entry.rev) { ok = false; break }
      if (ok) for (const k of indexed.keys()) if (!observed.has(k) && current.has(k)) { ok = false; break }
      if (ok && expectedDocs.size > 0) {
        const counts = await this.readDocCounts(signal)
        for (const [k, expected] of expectedDocs) {
          if ((counts.get(`${k}\0${expected.rev}`) ?? 0) !== expected.count) { ok = false; break }
        }
      }
      if (ok) return
      if (Date.now() >= deadline) throw new SessionQueryError('session-search index writes did not become visible', 'SESSION_QUERY_INDEX_FAILED')
      await sleep(this.options.visibilityPollIntervalMs)
    }
  }

  /** Non-deleted doc counts keyed by `${source}\0${session_id}\0${rev}`. */
  private async readDocCounts(signal?: AbortSignal): Promise<Map<string, number>> {
    const rows = await this.options.client.query<{ source: Source; session_id: string; rev: string; n: number }>(
      `SELECT to_string(source) AS source, session_id, rev, count() AS n FROM table(${this.docs}) WHERE deleted = 0 GROUP BY source, session_id, rev`,
      {},
      signal,
    )
    const map = new Map<string, number>()
    for (const row of rows) map.set(`${row.source}\0${row.session_id}\0${row.rev}`, row.n)
    return map
  }
}

function key(source: Source, id: SessionId): string {
  return `${source}\0${id as string}`
}
function splitKey(k: string): [Source, SessionId] {
  const [source, id] = k.split('\0') as [Source, string]
  return [source, id as SessionId]
}

function observeLive(session: Session): ObservedSession {
  const header = structuredClone(session.header)
  const events = session.events.map(event => structuredClone(event))
  return {
    header,
    rev: createHash('sha256').update(JSON.stringify({ header, events })).digest('base64url'),
    documents: buildSessionEventSearchDocuments(header.id, events),
  }
}

function stateRowValues(source: Source, header: SessionHeader, rev: string, deleted: number): unknown[] {
  return [
    source, header.id, rev,
    header.version, header.createdAt, header.cwd ?? null, header.parentSession ?? null,
    header.seedLength ?? null, header.delegationDepth ?? null, header.agentPreset ?? null,
    deleted,
  ]
}
function stateTombstoneValues(source: Source, prior: StateRow): unknown[] {
  return [source, prior.session_id, prior.rev, prior.version, prior.created_at, prior.cwd, prior.parent_session, prior.seed_length, prior.delegation_depth, prior.agent_preset, 1]
}
function docRowValues(source: Source, id: SessionId, rev: string, document: SessionEventSearchDocument): unknown[] {
  const text = sanitizeText(document.text)
  return [source, id, document.seq, rev, document.type, document.time, document.surface, text, codePointLength(text), 0]
}
function tombstoneDocValues(source: Source, id: SessionId, seq: number): unknown[] {
  return [source, id, seq, '', '', 0, 'log-only', '', 0, 1]
}

function rowHeader(row: StateRow): SessionHeader {
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}
function aborted(cause: unknown): SessionQueryError {
  return new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED', { cause })
}
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
