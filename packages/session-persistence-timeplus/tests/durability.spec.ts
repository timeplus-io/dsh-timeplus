/**
 * DESIGN.md §4.2 read-your-writes durability probe. Written first because it
 * settles OPEN QUESTION #1: on Proton, an ingest acknowledgement does NOT
 * imply immediate `table()` visibility — rows surface after the stream's
 * `flush_threshold_ms`. The store therefore polls its own watermark before
 * `appendBatch` resolves; this suite pins both the raw behavior and the
 * guarantee the store adds on top.
 */

import { describe, expect, it } from 'vitest'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { meta, oneTurnLog } from '../../../../deepseek-harness/packages/session/session-persistence/tests/contract.ts'
import { EVENT_COLUMNS, encodeEventRow, rowValues } from '../src/codec.ts'
import { DATABASE, TIMEPLUS_URL, dropStream, freshStore, freshStreamName, rawClient, TEST_FLUSH_THRESHOLD_MS } from './helpers.ts'

interface Count { n: number }

async function countRows(stream: string, sessionId: string): Promise<number> {
  const rows = await rawClient().query<Count>(
    `SELECT count() AS n FROM table(\`${DATABASE}\`.\`${stream}\`) WHERE session_id = {sid:string}`,
    { sid: sessionId },
  )
  return rows[0]?.n ?? 0
}

describe.skipIf(TIMEPLUS_URL === undefined)('read-your-writes durability (DESIGN.md §4.2)', () => {
  it('raw ingest ack precedes table() visibility, and one batch becomes visible atomically', async () => {
    const stream = freshStreamName('dsh_probe')
    const client = rawClient()
    await client.execute(`
      CREATE STREAM \`${DATABASE}\`.\`${stream}\` (
        session_id string, seq int64,
        kind enum8('header' = 0, 'event' = 1, 'repair' = 2),
        type string, turn int32 DEFAULT -1, step int32 DEFAULT -1, event_time int64, data string
      ) SETTINGS flush_threshold_ms = ${TEST_FLUSH_THRESHOLD_MS}`)
    try {
      const id = SessionId('probe')
      const events: SessionEvent[] = Array.from({ length: 200 }, (_, seq) => ({
        type: 'assistant/chunk',
        seq,
        time: seq,
        data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: `t${seq}` } },
      }))
      const rows = events.map(event => rowValues(encodeEventRow(id, event)))

      const started = performance.now()
      await client.ingest(`\`${DATABASE}\`.\`${stream}\``, EVENT_COLUMNS, rows)
      const acked = performance.now()

      // Poll until anything is visible; the first non-empty observation must
      // already hold the WHOLE batch (one insert block flushes as a unit).
      let observed = 0
      for (;;) {
        observed = await countRows(stream, id)
        if (observed > 0) break
        if (performance.now() - started > 10_000) throw new Error('batch never became visible')
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      const visible = performance.now()
      expect(observed).toBe(rows.length)
      // Documented, not asserted: the lag is what appendBatch has to absorb.
      // eslint-disable-next-line no-console
      console.info(`§4.2 probe: ack after ${(acked - started).toFixed(0)} ms, visible after ${(visible - started).toFixed(0)} ms (flush_threshold_ms=${TEST_FLUSH_THRESHOLD_MS})`)
    } finally {
      await dropStream(stream)
    }
  })

  it('appendBatch resolves only once loadStored/readStoredRevision observe the batch', async () => {
    const { store, cleanup } = await freshStore()
    try {
      const header = meta('rw', '/work')
      const log = oneTurnLog()
      // Many small appends: every one must be immediately readable, no flakes.
      for (const [index, event] of log.entries()) {
        await store.appendBatch(header, [event], index > 0)
        const stored = await store.loadStored(header.id)
        expect(stored?.events.map(e => e.seq)).toEqual(log.slice(0, index + 1).map(e => e.seq))
        expect(await store.readStoredRevision(header.id)).toBe(stored?.revision)
      }
      expect((await store.loadStored(header.id))?.events).toEqual(log)
    } finally {
      await cleanup()
    }
  })

  it('appendBatch is atomic with materialization: header and first events land together', async () => {
    const { store, stream, cleanup } = await freshStore()
    try {
      const header = meta('atomic')
      expect(await store.loadStored(header.id)).toBeUndefined()
      expect(await store.readStoredRevision(header.id)).toBeUndefined()
      await store.appendBatch(header, oneTurnLog(), false)
      expect(await countRows(stream, header.id)).toBe(oneTurnLog().length + 1)
      const stored = await store.loadStored(header.id)
      expect(stored?.meta).toEqual(header)
      expect(stored?.tornMarker).toBeUndefined()
    } finally {
      await cleanup()
    }
  })

  it('retrying a batch whose acknowledgement was lost does not duplicate rows', async () => {
    const { store, stream, cleanup } = await freshStore()
    try {
      const header = meta('retry')
      const log = oneTurnLog()
      await store.appendBatch(header, log.slice(0, 3), false)
      // Same batch again, as a write-behind retry would resend it.
      await store.appendBatch(header, log.slice(0, 3), true)
      expect(await countRows(stream, header.id)).toBe(4)
      // A genuinely non-contiguous batch is still rejected.
      await expect(store.appendBatch(header, log.slice(4), true))
        .rejects.toThrow('append starts at seq 4, stored next seq is 3')
      await store.appendBatch(header, log.slice(3), true)
      expect((await store.loadStored(header.id))?.events).toEqual(log)
    } finally {
      await cleanup()
    }
  })
})
