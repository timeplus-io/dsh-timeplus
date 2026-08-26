/** Unit tests: row codec is lossless and rejects malformed rows loudly. No server needed. */

import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'
import { oneTurnLog } from '../../../../deepseek-harness/packages/session/session-persistence/tests/contract.ts'
import { EVENT_COLUMNS, decodeEventRow, decodeHeaderRow, encodeEventRow, encodeHeaderRow, rowValues } from '../src/codec.ts'
import { deriveRevision } from '../src/revision.ts'
import { quoteIdentifier } from '../src/schema.ts'

const id = SessionId('codec')

describe('event row codec', () => {
  it('round-trips every event of a well-formed log byte-identically', () => {
    for (const event of oneTurnLog()) {
      const row = encodeEventRow(id, event)
      expect(row.session_id).toBe('codec')
      expect(row.seq).toBe(event.seq)
      expect(row.kind).toBe('event')
      expect(row.type).toBe(event.type)
      expect(row.event_time).toBe(event.time)
      expect(JSON.stringify(decodeEventRow(row))).toBe(JSON.stringify(event))
      expect(decodeEventRow(row)).toEqual(event)
    }
  })

  it('extracts turn/step as query sugar and defaults them to -1', () => {
    const [start, user] = oneTurnLog()
    expect(encodeEventRow(id, start as SessionEvent)).toMatchObject({ turn: 1, step: -1 })
    expect(encodeEventRow(id, user as SessionEvent)).toMatchObject({ turn: -1, step: -1 })
    expect(encodeEventRow(id, oneTurnLog()[2] as SessionEvent)).toMatchObject({ turn: 1, step: 1 })
  })

  it('preserves surface metadata, ignorable flags, unicode, and extreme numbers verbatim', () => {
    const event = {
      type: 'assistant/chunk',
      seq: 7,
      time: Number.MIN_SAFE_INTEGER,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'a\nb\t\u0000 ünï 🎉 "q" \\ /' } },
      ignorable: true,
      sourceEventSeqs: [1, 2],
      surfaceOp: { op: 'replace', start: 5, end: 5 },
    } as unknown as SessionEvent
    const row = encodeEventRow(id, event, 'repair')
    expect(row.kind).toBe('repair')
    expect(decodeEventRow(row)).toEqual(event)
    expect(rowValues(row)).toHaveLength(EVENT_COLUMNS.length)
  })

  it('returns a fresh graph on every decode (never aliases)', () => {
    const row = encodeEventRow(id, oneTurnLog()[1] as SessionEvent)
    const a = decodeEventRow(row)
    const b = decodeEventRow(row)
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
    expect(a.data).not.toBe(b.data)
  })

  it('reports malformed rows as SessionPersistenceCorruptionError', () => {
    const base = encodeEventRow(id, oneTurnLog()[0] as SessionEvent)
    const cases: [string, string][] = [
      ['{not json', 'not valid JSON'],
      ['[]', 'not a JSON object'],
      ['{"seq":0,"time":1,"data":{}}', 'missing event type'],
      ['{"type":"turn/start","time":1,"data":{}}', 'missing event seq'],
      ['{"type":"turn/start","seq":5,"time":1,"data":{}}', 'envelope seq 5 disagrees with the row'],
      ['{"type":"turn/start","seq":0,"data":{}}', 'missing event time'],
      ['{"type":"turn/start","seq":0,"time":1}', 'missing event data'],
    ]
    for (const [data, message] of cases) {
      const attempt = (): SessionEvent => decodeEventRow({ ...base, data })
      expect(attempt).toThrow(SessionPersistenceCorruptionError)
      expect(attempt).toThrow(message)
    }
  })
})

describe('header row codec', () => {
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1234,
    cwd: '/work',
    parentSession: SessionId('parent'),
    seedLength: 3,
    origin: 'subagent',
    delegationDepth: 1,
    agentPreset: 'default',
  }

  it('round-trips the header with seq -1 and createdAt as event_time', () => {
    const row = encodeHeaderRow(header)
    expect(row).toMatchObject({ session_id: 'codec', seq: -1, kind: 'header', type: '', event_time: 1234 })
    expect(decodeHeaderRow(row, id)).toEqual(header)
  })

  it('rejects a header bound to a different session id', () => {
    const row = encodeHeaderRow(header)
    expect(() => decodeHeaderRow(row, SessionId('other'))).toThrow(SessionPersistenceCorruptionError)
    expect(() => decodeHeaderRow(row, SessionId('other'))).toThrow('identifies session "codec", expected "other"')
  })

  it('does not decode structure beyond identity and version, so refusal can happen first', () => {
    const future = { ...encodeHeaderRow(header), data: JSON.stringify({ id: 'codec', version: 99, shape: 'unknown' }) }
    expect(decodeHeaderRow(future, id)).toMatchObject({ version: 99 })
    const bad = { ...encodeHeaderRow(header), data: JSON.stringify({ id: 'codec', version: '1' }) }
    expect(() => decodeHeaderRow(bad, id)).toThrow('version is not an integer')
  })
})

describe('revision derivation', () => {
  it('is deterministic, source-qualified, and moves with the row count', () => {
    const a = deriveRevision('store-a:default.s', id, { rowCount: 3, maxIngestMs: 10 })
    expect(a).toBe(deriveRevision('store-a:default.s', id, { rowCount: 3, maxIngestMs: 10 }))
    expect(a).not.toBe(deriveRevision('store-a:default.s', id, { rowCount: 4, maxIngestMs: 10 }))
    expect(a).not.toBe(deriveRevision('store-b:default.s', id, { rowCount: 3, maxIngestMs: 10 }))
    expect(a).not.toBe(deriveRevision('store-a:default.s', SessionId('other'), { rowCount: 3, maxIngestMs: 10 }))
  })
})

describe('identifier quoting', () => {
  it('backtick-quotes plain identifiers and rejects anything else', () => {
    expect(quoteIdentifier('dsh_session_events')).toBe('`dsh_session_events`')
    expect(() => quoteIdentifier('bad name')).toThrow(TypeError)
    expect(() => quoteIdentifier('x`; DROP STREAM y')).toThrow(TypeError)
    expect(() => quoteIdentifier('1abc')).toThrow(TypeError)
  })
})
