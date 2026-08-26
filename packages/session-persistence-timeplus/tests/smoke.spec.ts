/**
 * The CLAUDE.md smoke test, automated: boot upstream's headless-agent
 * composition through the REAL Loader (`@deepseek-ai/dsh-app-boot`, cordis
 * include + patches, keyless mock LLM) with the persistence row patched to
 * this provider, run a session with a real bash tool round trip in one
 * process, then resume that session id from a second process and continue
 * it. `SELECT count() FROM table(<stream>)` must grow across the restart.
 *
 * Each run is a child `node --import tsx` process resolving `@deepseek-ai/*`
 * through upstream's tsconfig paths, exactly like upstream's keyless smoke.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DATABASE, TIMEPLUS_URL, dropStream, freshStreamName, rawClient, TEST_FLUSH_THRESHOLD_MS } from './helpers.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const upstream = resolve(here, '../../../../deepseek-harness')
const driver = join(here, 'fixtures/smoke-driver.ts')
const pluginEntry = resolve(here, '../src/index.ts')
const mockLlm = join(upstream, 'examples/headless-agent/tests/fixtures/cli-mock-llm.ts')
const baseConfig = join(upstream, 'examples/headless-agent/cordis.yml')
const tsconfigPath = join(upstream, 'tsconfig.json')

interface Line { type: string; sessionId?: string; event?: SessionEvent; output?: string; events?: number }

function parse(stdout: string): Line[] {
  return stdout.trimEnd().split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as Line)
}

async function sessionRows(stream: string, sessionId: string): Promise<{ total: number; session: number; headers: number }> {
  const rows = await rawClient().query<{ total: number; session: number; headers: number }>(
    `SELECT count() AS total,
            count_if(session_id = {sid:string}) AS session,
            count_if(session_id = {sid:string} AND kind = 'header') AS headers
     FROM table(\`${DATABASE}\`.\`${stream}\`)`,
    { sid: sessionId },
  )
  return rows[0] ?? { total: 0, session: 0, headers: 0 }
}

/**
 * Set DSH_SMOKE_STREAM=<name> to write into a fixed stream and keep it after
 * the run, so the persisted session can be inspected by hand:
 *   DSH_SMOKE_STREAM=dsh_smoke_keep TIMEPLUS_URL=... pnpm vitest run .../smoke.spec.ts
 *   SELECT session_id, seq, kind, type FROM table(dsh_smoke_keep) ORDER BY _tp_time, seq
 */
const keepStream = process.env['DSH_SMOKE_STREAM']

describe.skipIf(TIMEPLUS_URL === undefined)('dsh CLI smoke: run, restart, resume against Timeplus', () => {
  const stream = keepStream ?? freshStreamName('dsh_smoke')
  const dirs: string[] = []
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
    if (TIMEPLUS_URL !== undefined && keepStream === undefined) await dropStream(stream)
  })

  async function writeConfig(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-timeplus-smoke-config-'))
    dirs.push(dir)
    const configPath = join(dir, 'cordis.yml')
    // The upstream keyless fixture, with the persistence row swapped for this
    // provider (plugins may be referenced by file path, like the mock LLM).
    await writeFile(configPath, [
      '- id: cli-mock-llm',
      `  name: ${JSON.stringify(mockLlm)}`,
      '',
      '- id: base',
      "  name: '@deepseek-ai/cordis-plugin-include'",
      '  config:',
      `    path: ${JSON.stringify(baseConfig)}`,
      '    patches:',
      '      - id: llm-deepseek',
      "        name: '@deepseek-ai/dsh-llm-deepseek'",
      '        disabled: true',
      '      - id: agent-spine',
      "        name: '@deepseek-ai/dsh-agent-spine-demo'",
      '        config:',
      '          agents:',
      '            - id: main',
      '              provider: cli-mock',
      '              model: cli-mock',
      '              cwd: !!js process.cwd()',
      '          workspaceContext: false',
      "          dshHome: './.dsh-home'",
      '          skills:',
      '            filesystem:',
      "              agentsHome: './.agents-home'",
      "          persona: 'Timeplus persistence smoke.'",
      '      - id: persistence',
      "        name: '@deepseek-ai/dsh-session-persistence-jsonl'",
      '        disabled: true',
      '',
      '- id: timeplus-persistence',
      `  name: ${JSON.stringify(pluginEntry)}`,
      '  config:',
      `    url: ${JSON.stringify(TIMEPLUS_URL)}`,
      `    database: ${JSON.stringify(DATABASE)}`,
      `    stream: ${JSON.stringify(stream)}`,
      `    flushThresholdMs: ${TEST_FLUSH_THRESHOLD_MS}`,
      '    visibilityPollIntervalMs: 10',
      '',
    ].join('\n'))
    return configPath
  }

  it('persists a real tool round trip, survives a process restart, and resumes from the stream', async () => {
    const configPath = await writeConfig()

    // Process 1: fresh session, one scripted turn with a real bash call.
    const first = await runLoaderSmoke({
      label: 'timeplus-smoke (new)',
      tempDirPrefix: 'dsh-timeplus-smoke-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      binArgs: [configPath, 'new', 'prove the tool path'],
      tsconfigPath,
    })
    expect(first.stderr).toBe('')
    const firstLines = parse(first.stdout)
    const firstResult = firstLines.at(-1)
    expect(firstResult?.type).toBe('result')
    expect(String(firstResult?.output)).toContain('CLI_TOOL_ROUND_TRIP')
    const sessionId = firstResult?.sessionId
    if (sessionId === undefined) throw new Error('driver reported no session id')
    const firstEvents = firstLines.filter(line => line.type === 'session_event').map(line => line.event as SessionEvent)
    expect(firstEvents.some(event => event.type === 'tool/call' && event.data.name === 'bash')).toBe(true)

    const afterFirst = await sessionRows(stream, sessionId)
    expect(afterFirst.headers).toBe(1)
    expect(afterFirst.session).toBeGreaterThan(firstEvents.length) // header + every event

    // Process 2: a new process resumes the same session id from Timeplus and continues it.
    const second = await runLoaderSmoke({
      label: 'timeplus-smoke (resume)',
      tempDirPrefix: 'dsh-timeplus-smoke-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      binArgs: [configPath, 'resume', sessionId, 'prove the tool path again'],
      tsconfigPath,
    })
    expect(second.stderr).toBe('')
    const secondLines = parse(second.stdout)
    expect(secondLines.at(-1)).toMatchObject({ type: 'result', sessionId })
    const secondEvents = secondLines.filter(line => line.type === 'session_event').map(line => line.event as SessionEvent)
    expect(secondEvents.some(event => event.type === 'tool/result')).toBe(true)
    // Resumed seqs continue past the first process's log.
    const firstMaxSeq = Math.max(...firstEvents.map(event => event.seq))
    expect(Math.min(...secondEvents.map(event => event.seq))).toBeGreaterThan(firstMaxSeq)

    const afterSecond = await sessionRows(stream, sessionId)
    expect(afterSecond.total).toBeGreaterThan(afterFirst.total)
    // Every event the second process emitted landed (plus the resume's own
    // `session/end-seed` boundary, appended before our listener attached).
    expect(afterSecond.session).toBeGreaterThanOrEqual(afterFirst.session + secondEvents.length)
    // The stream holds exactly the resumed session's full log plus its header row.
    expect(afterSecond.session).toBe((secondLines.at(-1)?.events ?? 0) + 1)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS * 2)
})
