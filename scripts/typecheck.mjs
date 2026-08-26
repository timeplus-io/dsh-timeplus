#!/usr/bin/env node
/**
 * Type-check src + tests against the deepseek-harness checkout's sources
 * (tsconfig.typecheck.json extends upstream's tsconfig.base.json so every
 * @deepseek-ai/* import resolves to source). Upstream's vendored packages
 * (vendor/cordis, cosmokit, schemastery) compile under relaxed flags in their
 * own project references, so diagnostics inside them are not ours to fix and
 * are filtered out; anything else fails the check.
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tsc = path.join(root, 'node_modules/.bin/tsc')
const projects = [
  'packages/session-persistence-timeplus/tsconfig.typecheck.json',
  'packages/session-query-timeplus/tsconfig.typecheck.json',
]

const vendor = /^\.\.\/deepseek-harness\/vendor\//
let failed = false
for (const relative of projects) {
  const result = spawnSync(tsc, ['--noEmit', '--pretty', 'false', '-p', path.join(root, relative)], { encoding: 'utf8' })
  if (result.error) throw result.error
  const kept = []
  let skip = false
  for (const line of `${result.stdout}${result.stderr}`.split('\n')) {
    const isDiagnostic = /^\S.*\(\d+,\d+\): error TS\d+:/.test(line)
    if (isDiagnostic) skip = vendor.test(line)
    else if (!/^\s/.test(line)) skip = false // continuation lines are indented
    if (!skip && line.trim().length > 0) kept.push(line)
  }
  if (kept.length > 0) {
    console.error(`# ${relative}`)
    console.error(kept.join('\n'))
    failed = true
  }
}

if (failed) process.exit(1)
console.log('typecheck: ok')
