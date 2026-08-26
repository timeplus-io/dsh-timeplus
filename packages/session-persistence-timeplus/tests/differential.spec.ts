/**
 * Differential suite (DESIGN.md §7.2): the Timeplus backend must be
 * observationally identical to upstream's SQLite backend for the same
 * logical logs — inspect/list/readFrom results, revision stability, and
 * survival across a remount. Ported from
 * deepseek-harness/packages/session/session-persistence-sqlite/tests/differential.spec.ts;
 * the SQLite-only physical-row assertions are dropped (no packing here).
 *
 * Randomized runs default to 25 (each run is several network round trips);
 * raise with DSH_DIFFERENTIAL_RUNS=100 for a fuller sweep.
 */

import { afterEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import SessionPersistenceSqlite from '@deepseek-ai/dsh-session-persistence-sqlite'
import { meta } from '../../../../deepseek-harness/packages/session/session-persistence/tests/contract.ts'
import { TIMEPLUS_URL, mountShared, useSharedStream } from './helpers.ts'

type BackendName = 'sqlite' | 'timeplus'

interface MountedBackend {
  readonly persistence: SessionPersistence
  dispose(): Promise<void>
}

const RUNS = Number(process.env['DSH_DIFFERENTIAL_RUNS'] ?? 25)

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function freshDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

function closedChunkLog(
  entries: readonly { readonly chunk: StreamChunk; readonly time: number; readonly ignorable?: true }[],
): SessionEvent[] {
  const chunks = entries.map(({ chunk, time, ignorable }, index): SessionEvent => ({
    type: 'assistant/chunk',
    seq: index + 2,
    time,
    data: { turn: 1, step: 1, chunk },
    ...ignorable === true ? { ignorable } : {},
  }))
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    ...chunks,
    { type: 'step/end', seq: chunks.length + 2, time: 3, data: { turn: 1, step: 1 } },
    {
      type: 'turn/end',
      seq: chunks.length + 3,
      time: 4,
      data: { turn: 1, reason: { kind: 'completed' } },
    },
  ]
}

function packingMatrixLog(): SessionEvent[] {
  const entries: { chunk: StreamChunk; time: number; ignorable?: true }[] = [
    ...Array.from({ length: 5 }, (_, index) => ({
      chunk: { type: 'text-delta' as const, index: 0, text: `text-${index}` },
      time: 1_000 + index,
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      chunk: { type: 'reasoning-delta' as const, index: 1, text: `reason-${index}` },
      time: 990 - index,
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      chunk: {
        type: 'tool-call-delta' as const,
        index: 2,
        id: CallId('named-call'),
        name: 'write',
        argumentsDelta: `{${index}`,
      },
      time: 2_000 + index,
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
      chunk: {
        type: 'tool-call-delta' as const,
        index: 3,
        id: CallId('unnamed-call'),
        argumentsDelta: `${index}}`,
      },
      time: 3_000 + index,
    })),
    { chunk: { type: 'block-start', index: 4, blockType: 'text' }, time: 4_000 },
    { chunk: { type: 'text-delta', index: 4, text: 'short-a' }, time: 4_001 },
    { chunk: { type: 'text-delta', index: 4, text: 'short-b' }, time: 4_002 },
    { chunk: { type: 'text-delta', index: 5, text: 'scalar-envelope' }, time: 4_003, ignorable: true },
    { chunk: { type: 'finish', reason: { kind: 'stop' } }, time: 4_004 },
  ]
  return closedChunkLog(entries)
}

function storageTagCollisionLog(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    ...['text-chunks', 'reasoning-chunks', 'tool-call-chunks'].map((type, index) => ({
      type,
      seq: index + 1,
      time: index + 2,
      data: { future: true },
      ignorable: true as const,
    }) as unknown as SessionEvent),
    { type: 'turn/end', seq: 4, time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

function batches(events: readonly SessionEvent[], sizes: readonly number[]): SessionEvent[][] {
  const result: SessionEvent[][] = []
  let offset = 0
  let index = 0
  while (offset < events.length) {
    const size = sizes[index % sizes.length] as number
    result.push(events.slice(offset, offset + size))
    offset += size
    index += 1
  }
  return result
}

/** Everything a caller can observe through the public service for one session. */
interface Observation {
  inspection: unknown
  list: unknown
  suffixes: unknown[]
}

async function observe(persistence: SessionPersistence, id: string, length: number): Promise<Observation> {
  const header = meta(id, '/work')
  const suffixes: unknown[] = []
  for (let fromSeq = 0; fromSeq <= length + 1; fromSeq += 1) {
    suffixes.push((await persistence.readFrom(header.id, fromSeq)).events)
  }
  return {
    inspection: await persistence.inspect(header.id),
    list: await persistence.list(),
    suffixes,
  }
}

const streamChunkArbitrary: fc.Arbitrary<StreamChunk> = fc.oneof(
  fc.record({ type: fc.constant<'text-delta'>('text-delta'), index: fc.nat(2), text: fc.string() }),
  fc.record({ type: fc.constant<'reasoning-delta'>('reasoning-delta'), index: fc.nat(2), text: fc.string() }),
  fc.record({
    type: fc.constant<'tool-call-delta'>('tool-call-delta'),
    index: fc.nat(2),
    id: fc.constantFrom(CallId('call-1'), CallId('call-2')),
    argumentsDelta: fc.string(),
  }),
  fc.record({
    type: fc.constant<'tool-call-delta'>('tool-call-delta'),
    index: fc.nat(2),
    id: fc.constantFrom(CallId('call-1'), CallId('call-2')),
    name: fc.constantFrom('read', 'write'),
    argumentsDelta: fc.string(),
  }),
  fc.record({
    type: fc.constant<'block-start'>('block-start'),
    index: fc.nat(2),
    blockType: fc.constant<'text'>('text'),
  }),
  fc.record({ type: fc.constant<'finish'>('finish'), reason: fc.constant({ kind: 'stop' as const }) }),
)

const randomWorkload = fc.record({
  entries: fc.array(fc.record({
    chunk: streamChunkArbitrary,
    time: fc.oneof(
      { weight: 4, arbitrary: fc.integer({ min: 0, max: 10_000 }) },
      { weight: 1, arbitrary: fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }) },
    ),
    ignorable: fc.option(fc.constant<true>(true), { nil: undefined }),
  }), { maxLength: 30 }),
  batchSizes: fc.array(fc.integer({ min: 1, max: 8 }), { minLength: 1, maxLength: 8 }),
}).map(({ entries, batchSizes }) => ({
  events: JSON.parse(JSON.stringify(closedChunkLog(entries.map(({ chunk, time, ignorable }) => ({
    chunk,
    time,
    ...ignorable === true ? { ignorable } : {},
  }))))) as SessionEvent[],
  batchSizes,
}))

describe.skipIf(TIMEPLUS_URL === undefined)('Timeplus vs SQLite differential behavior', () => {
  const shared = useSharedStream('dsh_diff')

  async function mount(name: BackendName, root: string): Promise<MountedBackend> {
    if (name === 'timeplus') {
      const mounted = await mountShared(shared.stream)
      return { persistence: mounted.ctx.sessionPersistence, dispose: mounted.dispose }
    }
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceSqlite, { path: join(root, 'sessions.db') })
    return { persistence: ctx.sessionPersistence, dispose: () => ctx.fiber.dispose() }
  }

  /** Drive one backend through the workload and return everything observable, before and after a remount. */
  async function run(name: BackendName, root: string, events: readonly SessionEvent[], sizes: readonly number[]): Promise<{
    before: Observation
    after: Observation
  }> {
    const header = { ...meta('differential', '/work'), delegationDepth: 0 }
    let mounted = await mount(name, root)
    let before: Observation
    try {
      await mounted.persistence.create(header)
      for (const batch of batches(events, sizes)) {
        await mounted.persistence.append(header.id, batch)
      }
      const revision = (await mounted.persistence.listSnapshots())[0]?.revision
      before = await observe(mounted.persistence, 'differential', events.length)
      expect(before.inspection, name).toEqual({ meta: header, events })
      expect(before.list, name).toEqual([header])
      expect((await mounted.persistence.listSnapshots())[0]?.revision, name).toBe(revision)
    } finally {
      await mounted.dispose()
    }
    mounted = await mount(name, root)
    try {
      const after = await observe(mounted.persistence, 'differential', events.length)
      expect(after.inspection, `${name} reopen`).toEqual({ meta: header, events })
      return { before, after }
    } finally {
      await mounted.dispose()
    }
  }

  async function compare(events: readonly SessionEvent[], sizes: readonly number[], label: string): Promise<void> {
    const directory = await freshDirectory(`dsh-diff-${label}-`)
    await shared.reset()
    const timeplus = await run('timeplus', directory, events, sizes)
    const sqlite = await run('sqlite', directory, events, sizes)
    expect(timeplus.before).toEqual(sqlite.before)
    expect(timeplus.after).toEqual(sqlite.after)
  }

  it('preserves ignorable logical events whose names match SQLite physical storage tags', async () => {
    await compare(storageTagCollisionLog(), [2, 1], 'tags')
  })

  it('matches SQLite for every chunk kind, scalar fallback, suffix, partition, and reopen', async () => {
    const events = packingMatrixLog()
    for (const [partitionIndex, sizes] of [[events.length], [1], [2, 1, 5, 3]].entries()) {
      await compare(events, sizes, `matrix-${partitionIndex}`)
    }
  }, 120_000)

  it('matches SQLite across randomized logical logs and append partitions', async () => {
    await fc.assert(fc.asyncProperty(randomWorkload, async ({ events, batchSizes }) => {
      await compare(events, batchSizes, 'property')
    }), { numRuns: RUNS, seed: 0x5A17E })
  }, 600_000)
})
