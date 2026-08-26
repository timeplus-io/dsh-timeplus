/**
 * Opaque pagination cursor. A base64url JSON payload bound to the engine
 * instance, the search scope, the normalized-request fingerprint, and a
 * generation token. Mirrors the SQLite backend so behavior matches:
 * - wrong instance / scope / fingerprint, tampered or non-JSON → INVALID_CURSOR
 * - generation moved on (corpus changed) → STALE_CURSOR
 */

import { SessionQueryError, SessionSearchCursor } from '@deepseek-ai/dsh-session-query'

export interface CursorPayload {
  version: 1
  instance: string
  scope: 'sessions' | 'events'
  fingerprint: string
  generation: string
  offset: number
}

export function encodeCursor(payload: CursorPayload): SessionSearchCursor {
  return SessionSearchCursor(Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url'))
}

export function decodeCursor(
  cursor: string,
  instance: string,
  scope: CursorPayload['scope'],
  fingerprint: string,
  generation: string,
): number {
  let decoded: Partial<CursorPayload>
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorPayload>
  } catch (error: unknown) {
    throw invalidCursor(error)
  }
  if (
    decoded.version !== 1
    || decoded.instance !== instance
    || decoded.scope !== scope
    || decoded.fingerprint !== fingerprint
    || typeof decoded.offset !== 'number'
    || !Number.isSafeInteger(decoded.offset)
    || decoded.offset < 0
  ) {
    throw invalidCursor(new Error('cursor does not belong to this normalized request'))
  }
  if (decoded.generation !== generation) {
    throw new SessionQueryError(
      'session-search cursor is stale because its relevant corpus changed',
      'SESSION_QUERY_STALE_CURSOR',
    )
  }
  return decoded.offset
}

function invalidCursor(cause: unknown): SessionQueryError {
  return new SessionQueryError('session-search cursor is invalid', 'SESSION_QUERY_INVALID_CURSOR', { cause })
}
