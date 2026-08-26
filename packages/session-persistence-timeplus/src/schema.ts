/** Stream DDL bootstrap (DESIGN.md §3). */

import type { TimeplusClient } from './client.ts'

export interface SchemaConfig {
  readonly database: string
  readonly stream: string
  /**
   * Stream-level `flush_threshold_ms`: how often the streaming store is
   * flushed to the historical store that `table()` reads. This bounds the
   * ingest-to-visibility lag `appendBatch` waits out (DESIGN.md §4.2). Only
   * honored at CREATE time — Timeplus does not allow altering it later.
   */
  readonly flushThresholdMs: number
}

/** Stream holding one random UUID per store, namespacing revisions (§4.4). */
export const STORE_IDENTITY_STREAM = 'dsh_store_identity'

export const EVENTS_DDL = (config: SchemaConfig): string => `
  CREATE STREAM IF NOT EXISTS ${qualifiedStream(config)} (
    session_id string,
    seq        int64,
    kind       enum8('header' = 0, 'event' = 1, 'repair' = 2),
    type       string,
    turn       int32 DEFAULT -1,
    step       int32 DEFAULT -1,
    event_time int64,
    data       string
  )
  SETTINGS flush_threshold_ms = ${config.flushThresholdMs}
`

export const IDENTITY_DDL = (config: SchemaConfig): string => `
  CREATE STREAM IF NOT EXISTS ${qualifiedIdentityStream(config)} (
    store_id string
  )
  SETTINGS flush_threshold_ms = ${config.flushThresholdMs}
`

export function qualifiedStream(config: SchemaConfig): string {
  return `${quoteIdentifier(config.database)}.${quoteIdentifier(config.stream)}`
}

export function qualifiedIdentityStream(config: SchemaConfig): string {
  return `${quoteIdentifier(config.database)}.${quoteIdentifier(STORE_IDENTITY_STREAM)}`
}

/** Backtick-quote an identifier; rejects names that cannot be quoted safely. */
export function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new TypeError(`Timeplus identifier "${name}" must match [A-Za-z_][A-Za-z0-9_]*`)
  }
  return `\`${name}\``
}

export async function bootstrapSchema(client: TimeplusClient, config: SchemaConfig): Promise<void> {
  await client.execute(EVENTS_DDL(config))
  await client.execute(IDENTITY_DDL(config))
}
