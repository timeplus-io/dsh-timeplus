#!/usr/bin/env node
/**
 * Loader smoke driver (see tests/smoke.spec.ts): boots a real dsh
 * composition from a cordis.yml and runs one scripted turn.
 *
 *   smoke-driver.ts <config-path> new <task...>
 *   smoke-driver.ts <config-path> resume <session-id> <task...>
 *
 * `new` drives the composition's root agent (a fresh session); `resume` loads
 * the persisted session through `ctx.agents.resume` — the same path the CLI's
 * `--resume` takes — and continues it. Every session event and the final
 * result are streamed to stdout as JSONL. Mirrors upstream's
 * examples/headless-agent/tests/fixtures/headless-driver.ts.
 */

import type { Context } from '@deepseek-ai/cordis'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'

const NAME = 'timeplus-smoke-driver'
const [configPath, mode, ...rest] = process.argv.slice(2)
if (configPath === undefined || (mode !== 'new' && mode !== 'resume')) {
  throw new Error(`${NAME}: expected <config-path> new|resume ...`)
}

function emit(sessionId: string, event: SessionEvent): void {
  process.stdout.write(`${JSON.stringify({ type: 'session_event', sessionId, event })}\n`)
}

const uninstallFailLoud = installFailLoud(NAME)
let ctx: Context | undefined
try {
  loadEnv(NAME)
  ctx = await boot(NAME, resolveConfigPath(configPath, undefined))
  if (mode === 'new') {
    const result = await runFixtureTurn(ctx, { task: rest.join(' '), onEvent: emit })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } else {
    const [sessionId, ...taskParts] = rest
    if (sessionId === undefined || taskParts.length === 0) throw new Error(`${NAME}: resume needs <session-id> <task...>`)
    const handle = await ctx.agents.resume({
      resumeSessionId: SessionId(sessionId),
      agentOptions: { provider: 'cli-mock', model: 'cli-mock' },
    })
    const { agent } = handle
    const stop = ctx.on('session/event', (session, event) => {
      if (session === agent.session) emit(session.id, event)
    })
    try {
      await agent.whenIdle()
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: taskParts.join(' ') }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
      await ctx.sessions.flush(agent.session)
    } finally {
      stop()
    }
    process.stdout.write(`${JSON.stringify({ type: 'result', sessionId: agent.session.id, events: agent.session.events.length })}\n`)
  }
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
