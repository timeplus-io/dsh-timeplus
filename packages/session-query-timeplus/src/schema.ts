/**
 * Derived search-index DDL. Two versioned_kv streams give the engine an
 * upsert/soft-delete projection: `table()` returns the latest row per PRIMARY
 * KEY (last write wins), and a `deleted` flag row hides a key (queries filter
 * `deleted = 0`) — the mutable-index primitive the SQLite backend gets from
 * REPLACE/DELETE. (changelog_kv is unsuitable here: its `table()` returns the
 * full delta log rather than the collapsed latest value.)
 *
 * - `<prefix>_state`  (PK source, session_id): one row per indexed session,
 *   carrying its header and a change token (`rev` = persistence revision for
 *   persisted sessions, content fingerprint for live ones).
 * - `<prefix>_docs`   (PK source, session_id, seq): one row per event that has
 *   searchable semantic text.
 *
 * `source` distinguishes the persisted and live copies of a session so search
 * can prefer the live one. Both are derived and disposable: drop them and the
 * next search rebuilds from `sessionPersistence` + `ctx.sessions`.
 */

import type { TimeplusClient } from './client.ts'
import { quoteIdentifier } from './identifier.ts'

export interface SchemaConfig {
  readonly database: string
  /** Base stream name; the state/docs streams append `_state` / `_docs`. */
  readonly indexStream: string
  /** Stream flush_threshold_ms (bounds index-write visibility lag). */
  readonly flushThresholdMs: number
}

export function stateStream(config: SchemaConfig): string {
  return `${quoteIdentifier(config.database)}.${quoteIdentifier(`${config.indexStream}_state`)}`
}

export function docsStream(config: SchemaConfig): string {
  return `${quoteIdentifier(config.database)}.${quoteIdentifier(`${config.indexStream}_docs`)}`
}

export const STATE_COLUMNS = [
  'source', 'session_id', 'rev',
  'version', 'created_at', 'cwd', 'parent_session', 'seed_length', 'delegation_depth', 'agent_preset',
  'deleted',
] as const

export const DOC_COLUMNS = [
  'source', 'session_id', 'seq', 'rev', 'type', 'event_time', 'surface', 'text', 'text_len',
  'deleted',
] as const

export async function bootstrapSchema(client: TimeplusClient, config: SchemaConfig): Promise<void> {
  await client.execute(`
    CREATE STREAM IF NOT EXISTS ${stateStream(config)} (
      source           enum8('persisted' = 0, 'live' = 1),
      session_id       string,
      rev              string,
      version          int32,
      created_at       int64,
      cwd              nullable(string),
      parent_session   nullable(string),
      seed_length      nullable(int64),
      delegation_depth nullable(int64),
      agent_preset     nullable(string),
      deleted          uint8 DEFAULT 0
    )
    PRIMARY KEY (source, session_id)
    SETTINGS mode = 'versioned_kv', flush_threshold_ms = ${config.flushThresholdMs}
  `)
  await client.execute(`
    CREATE STREAM IF NOT EXISTS ${docsStream(config)} (
      source     enum8('persisted' = 0, 'live' = 1),
      session_id string,
      seq        int64,
      rev        string,
      type       string,
      event_time int64,
      surface    enum8('current' = 0, 'shadowed' = 1, 'log-only' = 2),
      text       string,
      text_len   int64,
      deleted    uint8 DEFAULT 0
    )
    PRIMARY KEY (source, session_id, seq)
    SETTINGS mode = 'versioned_kv', flush_threshold_ms = ${config.flushThresholdMs}
  `)
}
