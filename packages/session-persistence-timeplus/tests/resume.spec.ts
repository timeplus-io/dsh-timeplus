/**
 * Restart-and-resume through the public seams, the offline stand-in for the
 * CLI smoke test in CLAUDE.md: drive a live Session via `ctx.sessions`, tear
 * the provider down, mount a fresh one over the same stream, resume the
 * session with `prepare()`, continue it, and confirm the stream's row count
 * grew — i.e. the Timeplus stream is the source of truth across restarts.
 */

import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { appendLog, oneTurnLog } from '../../../../deepseek-harness/packages/session/session-persistence/tests/contract.ts'
import { DATABASE, TIMEPLUS_URL, mountShared, rawClient, useSharedStream } from './helpers.ts'

async function rowCount(stream: string): Promise<number> {
  const rows = await rawClient().query<{ n: number }>(`SELECT count() AS n FROM table(\`${DATABASE}\`.\`${stream}\`)`)
  return rows[0]?.n ?? 0
}

describe.skipIf(TIMEPLUS_URL === undefined)('restart and resume', () => {
  const shared = useSharedStream('dsh_resume')

  it('a live session survives a provider restart and continues from the stored log', async () => {
    await shared.reset()
    const id = SessionId('resume-me')

    // Process 1: a live session writes one turn through the write-behind path.
    const first = await mountShared(shared.stream)
    try {
      const session = first.ctx.sessions.create(id, { meta: { cwd: '/work' } })
      appendLog(session, oneTurnLog())
      await first.ctx.sessions.flush(session)
    } finally {
      await first.dispose()
    }
    const afterFirst = await rowCount(shared.stream)
    expect(afterFirst).toBe(oneTurnLog().length + 1) // header + 6 events

    // Process 2: a fresh provider over the same stream resumes it.
    const second = await mountShared(shared.stream)
    try {
      expect((await second.ctx.sessionPersistence.list()).map(h => h.id)).toEqual([id])
      // Publish the prepared Session the way the agent loop does.
      const preparation = await second.ctx.sessionPersistence.prepare(id)
      const resumed = preparation.session
      const detach = second.ctx.sessions.enter(resumed)
      second.ctx.sessions.announce(resumed)
      preparation[Symbol.dispose]()
      try {
        // A resumed Session closes its seed with a boundary marker (seq 6),
        // which persists like any other event.
        expect(resumed.events.map(e => e.type)).toEqual([...oneTurnLog().map(e => e.type), 'session/end-seed'])
        expect(resumed.header.cwd).toBe('/work')

        resumed.append('turn/start', { turn: 2 })
        resumed.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
        await second.ctx.sessions.flush(resumed)
      } finally {
        detach()
      }
    } finally {
      await second.dispose()
    }
    const afterSecond = await rowCount(shared.stream)
    expect(afterSecond).toBe(afterFirst + 3) // end-seed marker + turn 2

    // Process 3: the continued log is what a third reader sees.
    const third = await mountShared(shared.stream)
    try {
      const loaded = await third.ctx.sessionPersistence.load(id)
      expect(loaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
      expect(loaded.events[6]?.type).toBe('session/end-seed')
      expect(loaded.events.at(-1)).toMatchObject({ type: 'turn/end', data: { turn: 2 } })
    } finally {
      await third.dispose()
    }
  })
})
