/** Minimal end-to-end shakeout of the push-down search SQL against live Proton. */

import { describe, expect, it } from 'vitest'
import { DATABASE, TIMEPLUS_URL, liveSession, mount, persistOnly, userTurn } from './helpers.ts'

describe.skipIf(TIMEPLUS_URL === undefined)('timeplus session-query smoke', () => {
  it('indexes a persisted session and finds a matching event', async () => {
    const { ctx, dispose } = await mount()
    try {
      const id = await persistOnly(ctx, 'persisted-1', userTurn('the quick brown fox'))
      const page = await ctx.sessionQuery.searchSessions({ query: 'brown fox' })
      expect(page.items.map(hit => hit.header.id)).toEqual([id])
      const hit = page.items[0]!
      expect(hit.persisted).toBe(true)
      expect(hit.live).toBe(false)
      expect(hit.bestMatch.snippet).toContain('brown fox')
      expect(hit.bestMatch.seq).toBe(2)

      const events = await ctx.sessionQuery.searchEvents({ sessionId: id, query: 'quick' })
      expect(events.session.id).toBe(id)
      expect(events.items.map(item => item.seq)).toEqual([2])
    } finally {
      await dispose()
    }
  }, 30_000)

  it('prefers a live session over its persisted copy and reflects both flags', async () => {
    const { ctx, dispose } = await mount()
    try {
      const live = liveSession(ctx, 'live-1', userTurn('needle in a haystack'))
      await ctx.sessions.flush(ctx.sessions.get(live)!)
      const page = await ctx.sessionQuery.searchSessions({ query: 'needle' })
      expect(page.items.map(hit => hit.header.id)).toEqual([live])
      expect(page.items[0]!.live).toBe(true)
      // No match returns an empty page, and DATABASE is a valid identifier.
      expect((await ctx.sessionQuery.searchSessions({ query: 'absent-term' })).items).toEqual([])
      expect(DATABASE.length).toBeGreaterThan(0)
    } finally {
      await dispose()
    }
  }, 30_000)
})
