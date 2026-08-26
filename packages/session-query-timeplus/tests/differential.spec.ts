/**
 * Differential suite (issue #1): the Timeplus query engine must be
 * observationally identical to the first-party SQLite engine
 * (`@deepseek-ai/dsh-session-query-sqlite`) for the same live-session corpus.
 * Both engines apply the same ranking ORDER BY; this pins that the Timeplus
 * push-down SQL computes the same matches, counts, lengths, and tie-breaks.
 *
 * Corpora use ASCII word text so the FTS5 unicode tokenizer and this engine's
 * `[\p{L}\p{N}]+` tokenizer agree; snippets (highlight vs. in-process) are not
 * compared, only session/event identity, order, surface, and source flags.
 */

import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionQueryEngine, SessionSearchHit } from '@deepseek-ai/dsh-session-query'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import TimeplusSessionQueryEngine from '../src/index.ts'
import { DATABASE, TIMEPLUS_URL, freshName } from './helpers.ts'
import { HttpTimeplusClient } from '../src/client.ts'

/** The SQLite query engine needs FTS5; some node:sqlite builds omit it. */
function hasFts5(): boolean {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE VIRTUAL TABLE t USING fts5(x)')
    return true
  } catch {
    return false
  } finally {
    db.close()
  }
}

type Backend = 'sqlite' | 'timeplus'
interface Corpus { readonly id: string; readonly messages: readonly string[] }
interface Probe { readonly query: string; readonly sessionFilters?: unknown; readonly eventFilters?: unknown }

interface NormalizedResult {
  sessions: { id: string; live: boolean; persisted: boolean; bestSeq: number; bestSurface: string }[]
  events: { seq: number; surface: string }[]
}

const droppers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const drop of droppers.splice(0)) await drop()
})

/** One user/message per text, at ascending seqs/times (the minimal searchable seed). */
function messageEvents(messages: readonly string[]): SessionEvent[] {
  return messages.map((text, index): SessionEvent => ({
    type: 'user/message',
    seq: index,
    time: index + 1,
    data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    surfaceOp: 'append',
  }) as SessionEvent)
}

async function mountEngine(backend: Backend): Promise<{ ctx: Context; engine: SessionQueryEngine; cleanup: () => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  if (backend === 'sqlite') {
    await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:' })
    return { ctx, engine: ctx.sessionQuery, cleanup: async () => { await ctx.fiber.dispose() } }
  }
  const indexStream = freshName('dsh_diff_index')
  await ctx.plugin(TimeplusSessionQueryEngine, {
    url: TIMEPLUS_URL!, database: DATABASE, indexStream,
    flushThresholdMs: 50, visibilityPollIntervalMs: 10, visibilityTimeoutMs: 10_000,
  })
  return {
    ctx,
    engine: ctx.sessionQuery,
    cleanup: async () => {
      await ctx.fiber.dispose()
      const client = new HttpTimeplusClient({ url: TIMEPLUS_URL!, database: DATABASE })
      await Promise.all([`${indexStream}_state`, `${indexStream}_docs`].map(s => client.execute(`DROP STREAM IF EXISTS \`${DATABASE}\`.\`${s}\``)))
    },
  }
}

function normalizeSessions(items: readonly SessionSearchHit[]): NormalizedResult['sessions'] {
  return items.map(hit => ({ id: hit.header.id, live: hit.live, persisted: hit.persisted, bestSeq: hit.bestMatch.seq, bestSurface: hit.bestMatch.surface }))
}

async function run(backend: Backend, corpus: readonly Corpus[], probes: readonly Probe[]): Promise<NormalizedResult[]> {
  const { ctx, engine, cleanup } = await mountEngine(backend)
  droppers.push(cleanup)
  for (const session of corpus) {
    ctx.sessions.create(session.id as SessionId, { seed: messageEvents(session.messages), meta: { createdAt: 1000 } })
  }
  const results: NormalizedResult[] = []
  for (const probe of probes) {
    const request = { query: probe.query, ...probe.sessionFilters ? { sessionFilters: probe.sessionFilters } : {}, ...probe.eventFilters ? { eventFilters: probe.eventFilters } : {} }
    const page = await engine.searchSessions(request as Parameters<SessionQueryEngine['searchSessions']>[0])
    const first = page.items[0]
    const events = first === undefined
      ? []
      : (await engine.searchEvents({ sessionId: first.header.id, query: probe.query })).items.map(item => ({ seq: item.seq, surface: item.surface }))
    results.push({ sessions: normalizeSessions(page.items), events })
  }
  return results
}

async function expectSame(corpus: readonly Corpus[], probes: readonly Probe[]): Promise<void> {
  const sqlite = await run('sqlite', corpus, probes)
  const timeplus = await run('timeplus', corpus, probes)
  expect(timeplus).toEqual(sqlite)
}

describe.skipIf(TIMEPLUS_URL === undefined || !hasFts5())('Timeplus vs SQLite session-query differential', () => {
  it('matches on a curated multi-session, multi-message corpus', async () => {
    const corpus: Corpus[] = [
      { id: 'a', messages: ['alpha beta gamma'] },
      { id: 'b', messages: ['alpha beta'] },
      { id: 'c', messages: ['beta gamma delta'] },
      { id: 'd', messages: ['quick brown fox', 'brown fox jumps'] },
      { id: 'e', messages: ['needle in a haystack'] },
      { id: 'f', messages: ['alpha beta', 'alpha beta gamma delta'] },
    ]
    const probes: Probe[] = [
      { query: 'alpha beta' },
      { query: 'beta' },
      { query: 'brown fox' },
      { query: 'gamma' },
      { query: 'needle' },
      { query: 'alpha OR gamma' }, // operators are inert data → matches the literal only
      { query: 'zzz nonexistent' },
      { query: 'beta', eventFilters: [{ kind: 'type', values: ['user/message'] }] },
    ]
    await expectSame(corpus, probes)
  }, 60_000)

  it('matches across randomized word corpora and queries', async () => {
    const vocab = ['alpha', 'beta', 'gamma', 'delta', 'needle', 'haystack', 'quick', 'brown', 'fox']
    const word = fc.constantFrom(...vocab)
    const message = fc.array(word, { minLength: 1, maxLength: 4 }).map(words => words.join(' '))
    const idArb = fc.array(fc.constantFrom(...'abcdefghijklmnop'.split('')), { minLength: 3, maxLength: 6 }).map(chars => chars.join(''))
    const corpusArb = fc.uniqueArray(
      fc.record({ id: idArb, messages: fc.array(message, { minLength: 1, maxLength: 3 }) }),
      { minLength: 1, maxLength: 5, selector: session => session.id },
    )
    const queryArb = fc.array(word, { minLength: 1, maxLength: 2 }).map(words => words.join(' '))

    await fc.assert(fc.asyncProperty(corpusArb, fc.array(queryArb, { minLength: 1, maxLength: 4 }), async (corpus, queries) => {
      await expectSame(corpus, queries.map(query => ({ query })))
    }), { numRuns: Number(process.env['DSH_DIFFERENTIAL_RUNS'] ?? 15), seed: 0x5A17E })
  }, 300_000)
})
