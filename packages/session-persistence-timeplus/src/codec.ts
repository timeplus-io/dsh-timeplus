/**
 * Row <-> value codec. `data` carries verbatim lossless JSON so the durable
 * log reproduces events byte-faithfully; extracted columns are query sugar.
 */

import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'

export type RowKind = 'header' | 'event' | 'repair'

/** One physical row of dsh_session_events. */
export interface EventRow {
  session_id: string
  seq: number          // -1 for header rows
  kind: RowKind
  type: string         // '' for header rows
  turn: number         // -1 when absent
  step: number         // -1 when absent
  event_time: number   // ms
  data: string         // JSON: SessionEvent (whole envelope) or SessionHeader
}

export const EVENT_COLUMNS = [
  'session_id', 'seq', 'kind', 'type', 'turn', 'step', 'event_time', 'data',
] as const

/** Column order used by {@link rowValues}; matches {@link EVENT_COLUMNS}. */
export function rowValues(row: EventRow): unknown[] {
  return [row.session_id, row.seq, row.kind, row.type, row.turn, row.step, row.event_time, row.data]
}

export function encodeEventRow(sessionId: SessionId, event: SessionEvent, kind: Exclude<RowKind, 'header'> = 'event'): EventRow {
  const payload = event.data as { turn?: unknown; step?: unknown } | undefined
  return {
    session_id: sessionId as string,
    seq: event.seq,
    kind,
    type: event.type,
    turn: typeof payload?.turn === 'number' ? payload.turn : -1,
    step: typeof payload?.step === 'number' ? payload.step : -1,
    event_time: event.time,
    // Whole envelope, verbatim: replay must be lossless (chunk packing, key
    // order concerns live entirely inside this string).
    data: JSON.stringify(event),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function corrupt(row: EventRow, reason: string, cause?: unknown): SessionPersistenceCorruptionError {
  return new SessionPersistenceCorruptionError(
    `session "${row.session_id}" row seq ${row.seq} (${row.kind}) is corrupt: ${reason}`,
    { cause },
  )
}

/**
 * Decode one event row into a fresh event graph. Only the envelope fields the
 * coordinator relies on are validated here (`type`, `seq`, `time`, `data`);
 * event-type-specific validation belongs to the session layer.
 */
export function decodeEventRow(row: EventRow): SessionEvent {
  let parsed: unknown
  try {
    parsed = JSON.parse(row.data)
  } catch (error: unknown) {
    throw corrupt(row, 'data is not valid JSON', error)
  }
  if (!isRecord(parsed)) throw corrupt(row, 'data is not a JSON object')
  if (typeof parsed['type'] !== 'string' || parsed['type'].length === 0) throw corrupt(row, 'missing event type')
  if (!Number.isSafeInteger(parsed['seq'])) throw corrupt(row, 'missing event seq')
  if (parsed['seq'] !== row.seq) throw corrupt(row, `envelope seq ${String(parsed['seq'])} disagrees with the row`)
  if (typeof parsed['time'] !== 'number') throw corrupt(row, 'missing event time')
  if (!Object.hasOwn(parsed, 'data')) throw corrupt(row, 'missing event data')
  return parsed as unknown as SessionEvent
}

export function encodeHeaderRow(meta: SessionHeader): EventRow {
  return {
    session_id: meta.id as string,
    seq: -1,
    kind: 'header',
    type: '',
    turn: -1,
    step: -1,
    event_time: meta.createdAt,
    data: JSON.stringify(meta),
  }
}

/**
 * Decode a header row. Validation stops at identity and version so a future
 * format can still be REFUSED by version (DESIGN.md §4.6) rather than
 * reported as corruption; the coordinator validates the rest.
 */
export function decodeHeaderRow(row: EventRow, expected: SessionId): SessionHeader {
  let parsed: unknown
  try {
    parsed = JSON.parse(row.data)
  } catch (error: unknown) {
    throw corrupt(row, 'header is not valid JSON', error)
  }
  if (!isRecord(parsed)) throw corrupt(row, 'header is not a JSON object')
  if (parsed['id'] !== expected) {
    throw corrupt(row, `stored header identifies session "${String(parsed['id'])}", expected "${expected}"`)
  }
  if (!Number.isSafeInteger(parsed['version'])) throw corrupt(row, 'header version is not an integer')
  return parsed as unknown as SessionHeader
}
