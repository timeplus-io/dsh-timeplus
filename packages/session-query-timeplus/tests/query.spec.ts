/**
 * Behavioral conformance for the two search methods against live Proton,
 * adapted from the SQLite engine's scenarios (no reusable upstream harness
 * exists). Covers ranking order, paging/cursors, filters, and error codes.
 */

import { describe, expect, it } from 'vitest'
import { MessageId, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { SessionQueryError, type SessionSearchCursor } from '@deepseek-ai/dsh-session-query'
import { TIMEPLUS_URL, mount, persistOnly, userTurn } from './helpers.ts'

/** A closed one-turn log whose user messages (seqs 2..) carry each text. */
function multiUserLog(texts: readonly string[]): SessionEvent[] {
  const messages = texts.map((text, index): SessionEvent => ({
    type: 'user/message', seq: index + 2, time: 3 + index, surfaceOp: 'append',
    data: freezeMessage({ id: MessageId(`mm-${text}-${index}`), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }),
  }) as SessionEvent)
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    ...messages,
    { type: 'step/end', seq: texts.length + 2, time: 100, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: texts.length + 3, time: 101, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as SessionEvent[]
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'NO_ERROR'
  } catch (error: unknown) {
    return error instanceof SessionQueryError ? error.code : `OTHER:${String(error)}`
  }
}

describe.skipIf(TIMEPLUS_URL === undefined)('timeplus session-query behavior', () => {
  it('ranks the strongest phrase match per session, breaking ties by length then id', async () => {
    const { ctx, dispose } = await mount()
    try {
      await persistOnly(ctx, 'b', userTurn('alpha beta'))
      await persistOnly(ctx, 'd', userTurn('alpha beta'))
      await persistOnly(ctx, 'a', userTurn('xx alpha beta yy'))
      await persistOnly(ctx, 'c', userTurn('alpha middle beta')) // no adjacency → no match
      const page = await ctx.sessionQuery.searchSessions({ query: 'alpha beta' })
      expect(page.items.map(hit => hit.header.id)).toEqual(['b', 'd', 'a'])
      for (const hit of page.items) expect(Array.from(hit.bestMatch.snippet).length).toBeLessThanOrEqual(240)
    } finally {
      await dispose()
    }
  }, 30_000)

  it('ranks by match count first, then shorter document (deterministic)', async () => {
    const { ctx, dispose } = await mount()
    try {
      await persistOnly(ctx, 'once-short', userTurn('alpha beta'))            // mc 1, len 10
      await persistOnly(ctx, 'once-long', userTurn('alpha beta gamma delta')) // mc 1, len 22
      await persistOnly(ctx, 'twice', userTurn('alpha beta then alpha beta')) // mc 2, len 26
      const page = await ctx.sessionQuery.searchSessions({ query: 'alpha beta' })
      // Higher match count wins outright; among equal counts the shorter doc wins.
      expect(page.items.map(hit => hit.header.id)).toEqual(['twice', 'once-short', 'once-long'])
      expect(page.items.map(hit => hit.bestMatch.seq)).toEqual([2, 2, 2])
    } finally {
      await dispose()
    }
  }, 30_000)

  it('orders within-session event hits by match count then shorter document', async () => {
    const { ctx, dispose } = await mount()
    try {
      // seq 2: 'alpha' once (len 5); seq 3: 'alpha alpha' twice (len 11); seq 4: 'alpha beta gamma' once (len 16)
      const id = await persistOnly(ctx, 'events-rank', multiUserLog(['alpha', 'alpha alpha', 'alpha beta gamma']))
      const page = await ctx.sessionQuery.searchEvents({ sessionId: id, query: 'alpha' })
      expect(page.items.map(item => item.seq)).toEqual([3, 2, 4])
    } finally {
      await dispose()
    }
  }, 30_000)

  it('pages within-session event hits with a terminating, non-repeating cursor', async () => {
    const { ctx, dispose } = await mount()
    try {
      const id = await persistOnly(ctx, 'evented', multiUserLog(['needle one', 'needle two', 'needle three']))
      const seen: number[] = []
      const cursors = new Set<string>()
      let cursor: SessionSearchCursor | undefined
      for (let guard = 0; guard < 10; guard += 1) {
        const page = await ctx.sessionQuery.searchEvents({
          sessionId: id, query: 'needle', limit: 1, ...cursor === undefined ? {} : { cursor },
        })
        expect(page.items).toHaveLength(1)
        seen.push(page.items[0]!.seq)
        if (page.nextCursor === undefined) break
        expect(cursors.has(page.nextCursor)).toBe(false)
        cursors.add(page.nextCursor)
        cursor = page.nextCursor
      }
      expect(seen.sort()).toEqual([2, 3, 4])
    } finally {
      await dispose()
    }
  }, 30_000)

  it('rejects tampered, non-JSON, and cross-request cursors; goes stale when the session changes', async () => {
    const { ctx, dispose } = await mount()
    try {
      const id = await persistOnly(ctx, 'cursors', multiUserLog(['needle a', 'needle b']))
      const first = await ctx.sessionQuery.searchEvents({ sessionId: id, query: 'needle', limit: 1 })
      const cursor = first.nextCursor!
      expect(await code(ctx.sessionQuery.searchEvents({ sessionId: id, query: 'needle', limit: 1, cursor: 'not-json' as never }))).toBe('SESSION_QUERY_INVALID_CURSOR')
      // A cursor from a different query does not belong to this request.
      expect(await code(ctx.sessionQuery.searchEvents({ sessionId: id, query: 'other', limit: 1, cursor }))).toBe('SESSION_QUERY_INVALID_CURSOR')
      // Changing the target session invalidates the generation → stale.
      await ctx.sessionPersistence.append(id, [
        { type: 'turn/start', seq: 6, time: 200, data: { turn: 2 } },
        { type: 'turn/end', seq: 7, time: 201, data: { turn: 2, reason: { kind: 'completed' } } },
      ] as SessionEvent[])
      expect(await code(ctx.sessionQuery.searchEvents({ sessionId: id, query: 'needle', limit: 1, cursor }))).toBe('SESSION_QUERY_STALE_CURSOR')
    } finally {
      await dispose()
    }
  }, 30_000)

  it('applies event and session metadata filters before ranking', async () => {
    const { ctx, dispose } = await mount()
    try {
      await persistOnly(ctx, 'here', userTurn('shared term'), '/here')
      await persistOnly(ctx, 'there', userTurn('shared term'), '/there')
      // cwd session filter narrows to one session.
      const scoped = await ctx.sessionQuery.searchSessions({ query: 'shared term', sessionFilters: [{ kind: 'cwd', values: ['/here'] }] })
      expect(scoped.items.map(hit => hit.header.id)).toEqual(['here'])
      // type filter that excludes user/message yields nothing.
      const wrongType = await ctx.sessionQuery.searchSessions({ query: 'shared', eventFilters: [{ kind: 'type', values: ['tool/call'] }] })
      expect(wrongType.items).toEqual([])
      // seq range excludes the matching event (it is at seq 2).
      const events = await ctx.sessionQuery.searchEvents({ sessionId: 'here' as SessionId, query: 'shared', filters: [{ kind: 'seq', from: 3 }] })
      expect(events.items).toEqual([])
    } finally {
      await dispose()
    }
  }, 30_000)

  it('validates requests with the contract error codes', async () => {
    const { ctx, dispose } = await mount()
    try {
      await persistOnly(ctx, 'valid', userTurn('hello world'))
      expect(await code(ctx.sessionQuery.searchSessions({ query: '' }))).toBe('SESSION_QUERY_INVALID_QUERY')
      expect(await code(ctx.sessionQuery.searchSessions({ query: 'x', limit: 0 }))).toBe('SESSION_QUERY_INVALID_LIMIT')
      expect(await code(ctx.sessionQuery.searchSessions({ query: 'x', sessionFilters: [{ kind: 'availability', values: ['remote' as never] }] }))).toBe('SESSION_QUERY_INVALID_FILTER')
      expect(await code(ctx.sessionQuery.searchEvents({ sessionId: 'ghost' as SessionId, query: 'x' }))).toBe('SESSION_QUERY_SESSION_NOT_FOUND')
      // A punctuation-only query is valid but matches nothing.
      expect((await ctx.sessionQuery.searchSessions({ query: '***' })).items).toEqual([])
    } finally {
      await dispose()
    }
  }, 30_000)
})
