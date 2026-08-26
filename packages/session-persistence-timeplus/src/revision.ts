/**
 * Revision derivation (DESIGN.md §4.4): opaque, source-qualified, changes on
 * every stored-log change, stable across repeated observation of an
 * unchanged log.
 *
 * The log is append-only (repairs append too), so the row count alone moves
 * on every change; the max ingest timestamp is folded in as a second witness.
 * `loadStored` derives the token from the rows in hand and
 * `readStoredRevision` from one aggregate query — both feed this function so
 * the representation is identical.
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'

/** The two aggregates every revision is built from. */
export interface RevisionWitness {
  /** Number of stored rows for the session (header + events + repairs). */
  readonly rowCount: number
  /** `max(_tp_time)` over those rows, in Unix milliseconds. */
  readonly maxIngestMs: number
}

export function deriveRevision(
  storeIdentity: string,
  id: SessionId,
  witness: RevisionWitness,
): SessionPersistenceRevision {
  return SessionPersistenceRevision(
    `timeplus:${storeIdentity}:${id as string}:${witness.rowCount}:${witness.maxIngestMs}`,
  )
}
