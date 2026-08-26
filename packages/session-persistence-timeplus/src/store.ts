/**
 * Timeplus implementation of the dsh `PersistenceBackend` storage contract.
 * The `PersistenceCoordinator` supplies orchestration (batching, cursors,
 * crash-repair sequencing, dispose quiescence); this class supplies durable
 * primitives over one append stream. See DESIGN.md §2–§5.
 */

import { randomUUID } from 'node:crypto'
import { SESSION_FORMAT_VERSION, type SessionEvent, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import {
  SessionFormatUnsupportedError,
  sessionFormatVersionRefusal,
  type PersistenceBackend,
  type SessionLocation,
  type SessionPersistenceRevision,
  type SessionPersistenceSnapshot,
  type StoredPrefix,
  type StoredSuffix,
} from '@deepseek-ai/dsh-session-persistence'
import type { TimeplusClient } from './client.ts'
import {
  EVENT_COLUMNS,
  decodeEventRow,
  decodeHeaderRow,
  encodeEventRow,
  encodeHeaderRow,
  rowValues,
  type EventRow,
  type RowKind,
} from './codec.ts'
import { deriveRevision, type RevisionWitness } from './revision.ts'
import { bootstrapSchema, qualifiedIdentityStream, qualifiedStream, type SchemaConfig } from './schema.ts'

export interface TimeplusStoreOptions extends SchemaConfig {
  readonly client: TimeplusClient
  /** CREATE STREAM IF NOT EXISTS at init. */
  readonly bootstrapSchema: boolean
  /** Interval between read-your-writes watermark polls (DESIGN.md §4.2). */
  readonly visibilityPollIntervalMs: number
  /** Give up waiting for an acknowledged batch to become queryable after this long. */
  readonly visibilityTimeoutMs: number
}

/** One stored row plus its server-side ingest timestamp. */
interface StoredRow extends EventRow {
  ingest_ms: number
}

/** One aggregate observation of a session's stored rows. */
interface Watermark {
  headers: number
  events: number
  max_seq: number
  in_range: number
  n: number
  t: number
}

/**
 * Torn tails cannot occur: a Timeplus ingest batch commits atomically or not
 * at all (DESIGN.md §4.3), so the torn-marker type parameter is `undefined`
 * and {@link commitRepair} only appends synthetic closers.
 */
export class TimeplusStore implements PersistenceBackend<undefined> {
  readonly name = 'session-persistence-timeplus'

  /** Random UUID namespacing revisions to this store (DESIGN.md §4.4). */
  private storeIdentity: string | undefined
  private ready: Promise<void> | undefined
  private readonly stream: string
  private readonly identityStream: string

  constructor(private readonly options: TimeplusStoreOptions) {
    this.stream = qualifiedStream(options)
    this.identityStream = qualifiedIdentityStream(options)
  }

  /** Bootstrap schema + resolve the store identity. Called from Service.init. */
  init(): Promise<void> {
    this.ready ??= this.initCore()
    return this.ready
  }

  private async initCore(): Promise<void> {
    if (this.options.bootstrapSchema) await bootstrapSchema(this.options.client, this.options)
    const storeId = await this.resolveStoreIdentity()
    this.storeIdentity = `${storeId}:${this.options.database}.${this.options.stream}`
  }

  async loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<undefined> | undefined> {
    const rows = await this.queryRows(id, 0, signal)
    if (rows.header === undefined) return undefined
    const meta = decodeHeaderRow(rows.header, id)
    assertSupportedVersion(meta)
    const events = decodeContiguous(rows.events, id, 0)
    return {
      meta,
      events,
      revision: this.revisionFor(id, rows.witness),
      // never a tornMarker: single-batch ingest cannot half-commit (§4.3)
    }
  }

  async loadStoredFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<StoredSuffix | undefined> {
    const rows = await this.queryRows(id, fromSeq, signal)
    if (rows.header === undefined) return undefined
    const meta = decodeHeaderRow(rows.header, id)
    assertSupportedVersion(meta)
    return { meta, events: decodeContiguous(rows.events, id, fromSeq) }
  }

  async readStoredRevision(id: SessionId, signal?: AbortSignal): Promise<SessionPersistenceRevision | undefined> {
    const watermark = await this.watermark(id, 0, -1, signal)
    if (watermark.headers === 0) return undefined
    return this.revisionFor(id, { rowCount: watermark.n, maxIngestMs: watermark.t })
  }

  async appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void> {
    await this.appendRows(meta, events, 'event', !isMaterialized)
  }

  async commitRepair(meta: SessionHeader, tornMarker: undefined, closers: readonly SessionEvent[]): Promise<void> {
    void tornMarker // always undefined for this backend (§4.3)
    await this.appendRows(meta, closers, 'repair', false)
  }

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted()
    await this.init()
    const rows = await this.options.client.query<StoredRow>(
      `SELECT session_id, seq, kind, type, turn, step, event_time, data,
              to_unix_timestamp64_milli(_tp_time) AS ingest_ms
       FROM table(${this.stream})
       WHERE kind = 'header'
       ORDER BY ingest_ms, session_id`,
      {},
      signal,
    )
    signal?.throwIfAborted()
    const seen = new Set<string>()
    const headers: SessionHeader[] = []
    for (const row of rows) {
      if (seen.has(row.session_id)) continue // first header wins
      seen.add(row.session_id)
      headers.push(decodeHeaderRow(row, row.session_id as SessionId))
    }
    return sortHeaders(headers)
  }

  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted()
    await this.init()
    interface SnapshotRow { session_id: string; n: number; t: number; header: string }
    const rows = await this.options.client.query<SnapshotRow>(
      `SELECT session_id, count() AS n, max(to_unix_timestamp64_milli(_tp_time)) AS t,
              any_if(data, kind = 'header') AS header
       FROM table(${this.stream})
       GROUP BY session_id
       HAVING count_if(kind = 'header') > 0
       ORDER BY session_id`,
      {},
      signal,
    )
    signal?.throwIfAborted()
    const snapshots = rows.map((row) => {
      const id = row.session_id as SessionId
      const headerRow: EventRow = {
        session_id: row.session_id, seq: -1, kind: 'header', type: '', turn: -1, step: -1, event_time: 0, data: row.header,
      }
      return {
        header: decodeHeaderRow(headerRow, id),
        revision: this.revisionFor(id, { rowCount: row.n, maxIngestMs: row.t }),
      }
    })
    const order = new Map(sortHeaders(snapshots.map(s => s.header)).map((header, index) => [header.id, index]))
    return snapshots.sort((a, b) => (order.get(a.header.id) ?? 0) - (order.get(b.header.id) ?? 0))
  }

  locate(_meta: SessionHeader): SessionLocation | undefined {
    return undefined // shared stream, no per-session local artifact
  }

  async close(): Promise<void> {
    if (this.ready !== undefined) await Promise.allSettled([this.ready])
    await this.options.client.close()
  }

  // ---------------------------------------------------------------- helpers

  /**
   * Durably append one contiguous batch as ONE ingest request (§4.1), then
   * wait until the historical store reflects it (§4.2). The pre-check against
   * the stored watermark rejects a non-contiguous batch and makes a retry
   * after a lost acknowledgement idempotent instead of duplicating rows.
   */
  private async appendRows(
    meta: SessionHeader,
    events: readonly SessionEvent[],
    kind: Exclude<RowKind, 'header'>,
    withHeader: boolean,
  ): Promise<void> {
    await this.init()
    if (events.length === 0) return
    const first = events[0] as SessionEvent
    const last = events[events.length - 1] as SessionEvent
    const before = await this.watermark(meta.id, first.seq, last.seq)
    const expected = before.events === 0 ? 0 : before.max_seq + 1
    if (first.seq !== expected) {
      if (before.headers > 0 && last.seq < expected && before.in_range === events.length) {
        return // already stored by an earlier attempt whose acknowledgement was lost
      }
      throw new Error(`session ${meta.id} append starts at seq ${first.seq}, stored next seq is ${expected}`)
    }
    if (withHeader && before.headers > 0) {
      throw new Error(`session ${meta.id} is already materialized in this store (id collision)`)
    }
    if (!withHeader && before.headers === 0) {
      throw new Error(`session ${meta.id} header row is missing`)
    }

    const rows: EventRow[] = events.map(event => encodeEventRow(meta.id, event, kind))
    if (withHeader) rows.unshift(encodeHeaderRow(meta))
    await this.options.client.ingest(this.stream, EVENT_COLUMNS, rows.map(rowValues))
    await this.awaitVisible(meta.id, first.seq, last.seq, events.length)
  }

  /** Poll the session's watermark until the acknowledged batch is queryable. */
  private async awaitVisible(id: SessionId, firstSeq: number, lastSeq: number, count: number): Promise<void> {
    const deadline = Date.now() + this.options.visibilityTimeoutMs
    for (;;) {
      const watermark = await this.watermark(id, firstSeq, lastSeq)
      if (watermark.headers > 0 && watermark.in_range >= count) return
      if (Date.now() >= deadline) {
        throw new Error(`session ${id} batch (seq ${firstSeq}..${lastSeq}) was acknowledged by Timeplus but did not become queryable within ${this.options.visibilityTimeoutMs} ms`)
      }
      await sleep(this.options.visibilityPollIntervalMs)
    }
  }

  private async watermark(id: SessionId, lo: number, hi: number, signal?: AbortSignal): Promise<Watermark> {
    signal?.throwIfAborted()
    const rows = await this.options.client.query<Watermark>(
      `SELECT count_if(kind = 'header') AS headers,
              count_if(kind <> 'header') AS events,
              max_if(seq, kind <> 'header') AS max_seq,
              count_if(kind <> 'header' AND seq >= {lo:int64} AND seq <= {hi:int64}) AS in_range,
              count() AS n,
              max(to_unix_timestamp64_milli(_tp_time)) AS t
       FROM table(${this.stream})
       WHERE session_id = {sid:string}`,
      { sid: id as string, lo, hi },
      signal,
    )
    signal?.throwIfAborted()
    return rows[0] ?? { headers: 0, events: 0, max_seq: -1, in_range: 0, n: 0, t: 0 }
  }

  private revisionFor(id: SessionId, witness: RevisionWitness): SessionPersistenceRevision {
    return deriveRevision(this.identity(), id, witness)
  }

  private identity(): string {
    if (this.storeIdentity === undefined) throw new Error('TimeplusStore used before init()')
    return this.storeIdentity
  }

  /** Read the store's UUID; mint one when absent (earliest row wins on a race). */
  private async resolveStoreIdentity(): Promise<string> {
    const read = (): Promise<{ store_id: string }[]> => this.options.client.query<{ store_id: string }>(
      `SELECT store_id FROM table(${this.identityStream}) ORDER BY _tp_time, store_id LIMIT 1`,
    )
    let rows = await read()
    if (rows.length === 0) {
      await this.options.client.ingest(this.identityStream, ['store_id'], [[randomUUID()]])
      const deadline = Date.now() + this.options.visibilityTimeoutMs
      for (;;) {
        rows = await read()
        if (rows.length > 0) break
        if (Date.now() >= deadline) {
          throw new Error(`store identity row did not become queryable within ${this.options.visibilityTimeoutMs} ms`)
        }
        await sleep(this.options.visibilityPollIntervalMs)
      }
    }
    const storeId = rows[0]?.store_id
    if (typeof storeId !== 'string' || storeId.length === 0) {
      throw new Error(`Timeplus store at ${this.identityStream} has no valid store identity`)
    }
    return storeId
  }

  /**
   * Fetch the header row plus the event rows with `seq >= fromSeq`, ordered
   * by seq. Returns FRESH object graphs: the coordinator freezes and
   * publishes them in place; nothing is retained here.
   */
  private async queryRows(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{
    header: EventRow | undefined
    events: EventRow[]
    witness: RevisionWitness
  }> {
    signal?.throwIfAborted()
    await this.init()
    signal?.throwIfAborted()
    const rows = await this.options.client.query<StoredRow>(
      `SELECT session_id, seq, kind, type, turn, step, event_time, data,
              to_unix_timestamp64_milli(_tp_time) AS ingest_ms
       FROM table(${this.stream})
       WHERE session_id = {sid:string} AND (kind = 'header' OR seq >= {from:int64})
       ORDER BY seq, ingest_ms`,
      { sid: id as string, from: fromSeq },
      signal,
    )
    signal?.throwIfAborted()
    let header: EventRow | undefined
    const events: EventRow[] = []
    let maxIngestMs = 0
    for (const row of rows) {
      if (row.ingest_ms > maxIngestMs) maxIngestMs = row.ingest_ms
      if (row.kind === 'header') {
        header ??= row // earliest header wins
      } else {
        events.push(row)
      }
    }
    return { header, events, witness: { rowCount: rows.length, maxIngestMs } }
  }
}

/** Refuse logs this build cannot faithfully read (DESIGN.md §4.6). */
function assertSupportedVersion(meta: SessionHeader): void {
  if (meta.version === SESSION_FORMAT_VERSION) return
  throw new SessionFormatUnsupportedError(sessionFormatVersionRefusal(meta.id, meta.version))
}

/** Validate seq contiguity from `firstSeq` and decode rows to events. */
function decodeContiguous(rows: EventRow[], id: SessionId, firstSeq: number): SessionEvent[] {
  let expected = firstSeq
  return rows.map((row) => {
    if (row.seq !== expected) {
      throw new Error(`session "${id}" stored log is not contiguous: expected seq ${expected}, found ${row.seq}`)
    }
    expected += 1
    return decodeEventRow(row)
  })
}

function sortHeaders(headers: SessionHeader[]): SessionHeader[] {
  return headers.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
