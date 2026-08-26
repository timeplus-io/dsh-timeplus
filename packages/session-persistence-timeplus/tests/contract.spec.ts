/**
 * Mounts the upstream persistence conformance suites against this backend:
 *
 * - `runPersistenceContract` — public storage semantics (creation, append,
 *   resume, crash closers, readFrom, revisions, JSON rejection).
 * - `runCoordinatorContract` — write-path orchestration through the real
 *   Session store (lazy creation, fork seeds, adoption/collision cases,
 *   reload, flush, dispose quiescence). No `corruptTail`: a Timeplus batch
 *   cannot half-commit (DESIGN.md §4.3), so torn-tail scenarios do not apply.
 *
 * Both live in the deepseek-harness checkout next to this repo. Each suite
 * gets a fresh, empty backend per test by truncating one shared stream.
 * Requires a reachable Timeplus/Proton (`docker compose up -d`) and
 * TIMEPLUS_URL=http://localhost:8123; the suites skip otherwise.
 */

import { describe } from 'vitest'
import { runPersistenceContract } from '../../../../deepseek-harness/packages/session/session-persistence/tests/contract.ts'
import { runCoordinatorContract } from '../../../../deepseek-harness/packages/session/session-persistence/tests/coordinator-contract.ts'
import TimeplusSessionPersistence from '../src/index.ts'
import { TIMEPLUS_URL, mountShared, pluginConfig, useSharedStream } from './helpers.ts'

describe.skipIf(TIMEPLUS_URL === undefined)('timeplus persistence contract', () => {
  const shared = useSharedStream('dsh_contract')

  runPersistenceContract('timeplus', async () => {
    await shared.reset()
    const mounted = await mountShared(shared.stream)
    return { persistence: mounted.ctx.sessionPersistence, dispose: mounted.dispose }
  })

  runCoordinatorContract('timeplus', async () => {
    await shared.reset()
    return {
      mount: async ctx => ctx.plugin(TimeplusSessionPersistence, pluginConfig(shared.stream)),
      cleanup: async () => {},
    }
  })
})
