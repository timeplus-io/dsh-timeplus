/** Live-Timeplus scaffolding for the session-query engine tests. */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import { MessageId, freezeMessage } from '@deepseek-ai/dsh-llm'
import TimeplusSessionPersistence from '../../session-persistence-timeplus/src/index.ts'
import { HttpTimeplusClient } from '../src/client.ts'
import TimeplusSessionQueryEngine from '../src/index.ts'

export const TIMEPLUS_URL = process.env['TIMEPLUS_URL']
export const DATABASE = process.env['TIMEPLUS_DATABASE'] ?? 'default'
const FLUSH = 50

export function freshName(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`
}

function rawClient(): HttpTimeplusClient {
  if (TIMEPLUS_URL === undefined) throw new Error('TIMEPLUS_URL is not set')
  return new HttpTimeplusClient({ url: TIMEPLUS_URL, database: DATABASE })
}

async function drop(stream: string): Promise<void> {
  await rawClient().execute(`DROP STREAM IF EXISTS \`${DATABASE}\`.\`${stream}\``)
}

export interface Harness {
  ctx: Context
  dispose: () => Promise<void>
}

/** Mount SessionStore + Timeplus persistence + the Timeplus query engine over fresh streams. */
export async function mount(): Promise<Harness> {
  const persistenceStream = freshName('dsh_q_events')
  const indexStream = freshName('dsh_q_index')
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(TimeplusSessionPersistence, {
    url: TIMEPLUS_URL!, database: DATABASE, stream: persistenceStream,
    flushThresholdMs: FLUSH, visibilityPollIntervalMs: 10, visibilityTimeoutMs: 10_000,
  })
  await ctx.plugin(TimeplusSessionQueryEngine, {
    url: TIMEPLUS_URL!, database: DATABASE, indexStream,
    flushThresholdMs: FLUSH, visibilityPollIntervalMs: 10, visibilityTimeoutMs: 10_000,
  })
  return {
    ctx,
    dispose: async () => {
      await ctx.fiber.dispose()
      await Promise.all([drop(persistenceStream), drop(`${indexStream}_state`), drop(`${indexStream}_docs`)])
    },
  }
}

/** A closed one-turn log whose single user message carries `text`. */
export function userTurn(text: string): SessionEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    {
      type: 'user/message', seq: 2, time: 3, surfaceOp: 'append',
      data: freezeMessage({ id: MessageId(`m-${text}`), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }),
    },
    { type: 'step/end', seq: 3, time: 4, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 4, time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as SessionEvent[]
}

/** Persist a session that is NOT live (no live Session object). */
export async function persistOnly(ctx: Context, id: string, events: SessionEvent[], cwd = '/work'): Promise<SessionId> {
  const sessionId = id as SessionId
  await ctx.sessionPersistence.create({ version: 0, id: sessionId, createdAt: 1000, cwd })
  await ctx.sessionPersistence.append(sessionId, events)
  return sessionId
}

/** Create a live session seeded with `events`. */
export function liveSession(ctx: Context, id: string, events: SessionEvent[], cwd = '/work'): SessionId {
  ctx.sessions.create(id as SessionId, { seed: events, meta: { cwd } })
  return id as SessionId
}
