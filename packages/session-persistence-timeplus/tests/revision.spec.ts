/**
 * Live tests for DESIGN.md §4.4 (revisions), §4.3 (repair), §4.6 (format
 * refusal), and the store-level listing primitives.
 */

import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionFormatUnsupportedError } from '@deepseek-ai/dsh-session-persistence'
import { meta, oneTurnLog } from '../../../../deepseek-harness/packages/session/session-persistence/tests/contract.ts'
import { EVENT_COLUMNS, encodeHeaderRow, rowValues } from '../src/codec.ts'
import { DATABASE, TIMEPLUS_URL, freshStore, rawClient } from './helpers.ts'

describe.skipIf(TIMEPLUS_URL === undefined)('store primitives against live Timeplus', () => {
  it('revision: stable while unchanged, identical across loadStored/readStoredRevision/listSnapshots, moves on every change', async () => {
    const { store, cleanup } = await freshStore()
    try {
      const header = meta('rev', '/work')
      await store.appendBatch(header, oneTurnLog(), false)
      const first = await store.readStoredRevision(header.id)
      expect(first).toMatch(/^timeplus:/)
      expect(await store.readStoredRevision(header.id)).toBe(first)
      expect((await store.loadStored(header.id))?.revision).toBe(first)
      expect((await store.listSnapshots()).find(s => s.header.id === header.id)?.revision).toBe(first)

      await store.appendBatch(header, [{ type: 'turn/start', seq: 6, time: 7, data: { turn: 2 } }], true)
      const second = await store.readStoredRevision(header.id)
      expect(second).not.toBe(first)
      expect((await store.loadStored(header.id))?.revision).toBe(second)

      const closers: SessionEvent[] = [
        { type: 'turn/end', seq: 7, time: 8, data: { turn: 2, reason: { kind: 'interrupted' } } },
      ]
      await store.commitRepair(header, undefined, closers)
      const third = await store.readStoredRevision(header.id)
      expect(third).not.toBe(second)
      const stored = await store.loadStored(header.id)
      expect(stored?.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
      expect(stored?.events.at(-1)).toEqual(closers[0])
      expect(stored?.revision).toBe(third)
    } finally {
      await cleanup()
    }
  })

  it('revision: two stores never produce equal tokens for the same session and length', async () => {
    const a = await freshStore()
    const b = await freshStore()
    try {
      const header = meta('shared-id')
      await a.store.appendBatch(header, oneTurnLog(), false)
      await b.store.appendBatch(header, oneTurnLog(), false)
      expect(await a.store.readStoredRevision(header.id)).not.toBe(await b.store.readStoredRevision(header.id))
    } finally {
      await a.cleanup()
      await b.cleanup()
    }
  })

  it('commitRepair with no closers is a no-op; stale closers are rejected', async () => {
    const { store, cleanup } = await freshStore()
    try {
      const header = meta('repair')
      await store.appendBatch(header, oneTurnLog(), false)
      const before = await store.readStoredRevision(header.id)
      await store.commitRepair(header, undefined, [])
      expect(await store.readStoredRevision(header.id)).toBe(before)
      await expect(store.commitRepair(header, undefined, [
        { type: 'turn/end', seq: 9, time: 8, data: { turn: 2, reason: { kind: 'interrupted' } } },
      ])).rejects.toThrow('append starts at seq 9, stored next seq is 6')
    } finally {
      await cleanup()
    }
  })

  it('loadStoredFrom returns the header plus the contiguous suffix without mutating anything', async () => {
    const { store, cleanup } = await freshStore()
    try {
      const header = meta('suffix', '/work')
      const log = oneTurnLog()
      await store.appendBatch(header, log, false)
      const before = await store.readStoredRevision(header.id)
      expect(await store.loadStoredFrom(header.id, 3)).toEqual({ meta: header, events: log.slice(3) })
      expect(await store.loadStoredFrom(header.id, 0)).toEqual({ meta: header, events: log })
      expect(await store.loadStoredFrom(header.id, 99)).toEqual({ meta: header, events: [] })
      expect(await store.loadStoredFrom(SessionId('absent'), 0)).toBeUndefined()
      expect(await store.readStoredRevision(header.id)).toBe(before)
    } finally {
      await cleanup()
    }
  })

  it('list and listSnapshots agree, exclude sessions without a header, and order by createdAt', async () => {
    const { store, cleanup } = await freshStore()
    try {
      const older = { ...meta('older'), createdAt: 500 }
      const newer = { ...meta('newer', '/n'), createdAt: 900 }
      await store.appendBatch(newer, oneTurnLog(), false)
      await store.appendBatch(older, oneTurnLog().slice(0, 2), false)
      expect(await store.list()).toEqual([older, newer])
      const snapshots = await store.listSnapshots()
      expect(snapshots.map(s => s.header)).toEqual([older, newer])
      expect(snapshots[0]?.revision).toBe(await store.readStoredRevision(older.id))
      expect(snapshots[1]?.revision).toBe(await store.readStoredRevision(newer.id))
    } finally {
      await cleanup()
    }
  })

  it('honors a pre-aborted signal with the exact reason on every read', async () => {
    const { store, cleanup } = await freshStore()
    try {
      const reason = new Error('cancelled')
      const controller = new AbortController()
      controller.abort(reason)
      await expect(store.list(controller.signal)).rejects.toBe(reason)
      await expect(store.listSnapshots(controller.signal)).rejects.toBe(reason)
      await expect(store.loadStored(SessionId('x'), controller.signal)).rejects.toBe(reason)
      await expect(store.loadStoredFrom(SessionId('x'), 0, controller.signal)).rejects.toBe(reason)
      await expect(store.readStoredRevision(SessionId('x'), controller.signal)).rejects.toBe(reason)
    } finally {
      await cleanup()
    }
  })

  it('format refusal (§4.6): a newer or older header version throws SessionFormatUnsupportedError', async () => {
    const { store, stream, cleanup } = await freshStore()
    try {
      const client = rawClient()
      const qualified = `\`${DATABASE}\`.\`${stream}\``
      const newer = { ...meta('newer-format'), version: SESSION_FORMAT_VERSION + 1 }
      const older = { ...meta('older-format'), version: SESSION_FORMAT_VERSION - 1 }
      await client.ingest(qualified, EVENT_COLUMNS, [rowValues(encodeHeaderRow(newer)), rowValues(encodeHeaderRow(older))])
      await new Promise(resolve => setTimeout(resolve, 300))

      await expect(store.loadStored(newer.id)).rejects.toThrow(SessionFormatUnsupportedError)
      await expect(store.loadStored(newer.id)).rejects.toThrow('upgrade the harness to open it')
      await expect(store.loadStoredFrom(newer.id, 0)).rejects.toThrow('written by a newer harness')
      await expect(store.loadStored(older.id)).rejects.toThrow(SessionFormatUnsupportedError)
      await expect(store.loadStored(older.id)).rejects.toThrow('ships no upgrade path')
      // Listing is metadata-only and does not refuse.
      expect((await store.list()).map(h => h.id).sort()).toEqual([newer.id, older.id].sort())
    } finally {
      await cleanup()
    }
  })

  it('reports a non-contiguous stored log as corruption rather than silently skipping', async () => {
    const { store, stream, cleanup } = await freshStore()
    try {
      const header = meta('gap')
      await store.appendBatch(header, oneTurnLog().slice(0, 2), false)
      const client = rawClient()
      const row = rowValues({ session_id: header.id, seq: 5, kind: 'event', type: 'turn/end', turn: -1, step: -1, event_time: 9, data: JSON.stringify({ type: 'turn/end', seq: 5, time: 9, data: { turn: 1, reason: { kind: 'completed' } } }) })
      await client.ingest(`\`${DATABASE}\`.\`${stream}\``, EVENT_COLUMNS, [row])
      await new Promise(resolve => setTimeout(resolve, 300))
      await expect(store.loadStored(header.id)).rejects.toThrow('not contiguous: expected seq 2, found 5')
    } finally {
      await cleanup()
    }
  })
})
