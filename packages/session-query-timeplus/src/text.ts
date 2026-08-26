/**
 * Query normalization, phrase matching, and snippet extraction — the
 * backend-neutral text rules the SessionQueryEngine contract requires, ported
 * to match `@deepseek-ai/dsh-session-query-sqlite/src/query.ts` behavior so a
 * differential test against that engine holds on ordinary text.
 *
 * Matching model: the query is data, never search-operator syntax. It is
 * trimmed, its inner whitespace collapsed, tokenized into alphanumeric runs,
 * and matched as a token phrase (tokens adjacent across non-word separators),
 * case-insensitively — the same "literal FTS phrase" the SQLite engine gets
 * from FTS5. Ranking counts phrase occurrences; snippets are built here from
 * the stored text so no server-side highlight is needed.
 */

import { SessionQueryError } from '@deepseek-ai/dsh-session-query'

/** Ellipsis appended/prepended to a truncated snippet window. */
const ELLIPSIS = '…'

/** Collapse all Unicode whitespace to single spaces and trim. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/**
 * Validate and normalize a user query: a non-empty, NUL-free string, trimmed
 * with inner whitespace collapsed. Mirrors the SQLite engine's `normalizeQuery`.
 */
export function normalizeQuery(query: unknown): string {
  if (typeof query !== 'string') {
    throw new SessionQueryError('session-search query must be text', 'SESSION_QUERY_INVALID_QUERY')
  }
  if (query.includes('\0')) {
    throw new SessionQueryError('session-search query must not contain a NUL character', 'SESSION_QUERY_INVALID_QUERY')
  }
  const normalized = collapseWhitespace(query)
  if (normalized.length === 0) {
    throw new SessionQueryError('session-search query must not be empty', 'SESSION_QUERY_INVALID_QUERY')
  }
  return normalized
}

/** Split text into case-folded alphanumeric tokens (the phrase-match unit). */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

const REGEX_META = /[.*+?^${}()|[\]\\]/gu

/**
 * A case-insensitive RE2/JS regex source matching the query as a token phrase:
 * its tokens in order, separated by one or more non-word characters, on token
 * boundaries. Returns `undefined` when the query has no tokens (matches nothing).
 */
export function phrasePattern(normalizedQuery: string): string | undefined {
  const tokens = tokenize(normalizedQuery)
  if (tokens.length === 0) return undefined
  const escaped = tokens.map(token => token.replace(REGEX_META, '\\$&'))
  // \W between tokens (FTS phrase adjacency); anchor on non-word boundaries so
  // a query token is not matched inside a longer word.
  return `(?:^|[^\\p{L}\\p{N}])${escaped.join('[^\\p{L}\\p{N}]+')}(?:[^\\p{L}\\p{N}]|$)`
}

/** Compile {@link phrasePattern} for in-process matching / snippet building. */
export function phraseRegex(normalizedQuery: string): RegExp | undefined {
  const source = phrasePattern(normalizedQuery)
  return source === undefined ? undefined : new RegExp(source, 'giu')
}

/** Count non-overlapping phrase occurrences in text (the relevance signal). */
export function countPhrase(text: string, regex: RegExp): number {
  regex.lastIndex = 0
  let count = 0
  for (;;) {
    const match = regex.exec(text)
    if (match === null) break
    count += 1
    // The pattern consumes a trailing boundary char; step back one so an
    // immediately-following occurrence is not skipped.
    if (regex.lastIndex > match.index + 1) regex.lastIndex -= 1
    if (match[0].length === 0) regex.lastIndex += 1
  }
  return count
}

/** Number of Unicode code points in a string. */
export function codePointLength(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

/** Code-point index of the first phrase match in already-collapsed text (0 if none). */
export function matchStartIndex(cleaned: string, regex: RegExp | undefined): number {
  if (regex === undefined) return 0
  regex.lastIndex = 0
  const match = regex.exec(cleaned)
  if (match === null) return 0
  // The pattern may consume a leading boundary char; the term starts after it.
  const lead = /^[^\p{L}\p{N}]/u.test(match[0]) ? 1 : 0
  return codePointLength(cleaned.slice(0, match.index)) + lead
}

/**
 * Build a plain-text excerpt of at most `maxChars` code points centered on the
 * first phrase match — a direct port of the SQLite engine's `makeSnippet`
 * (window starts `floor(maxChars/3)` before the match; ellipses count toward
 * the budget), so snippets match on ordinary text.
 * @param text - the raw document text (whitespace is collapsed here).
 * @param regex - the compiled phrase matcher, or `undefined` to excerpt the head.
 * @param maxChars - snippet budget in code points (>= 1).
 */
export function makeSnippet(text: string, regex: RegExp | undefined, maxChars: number): string {
  const clean = collapseWhitespace(text)
  const characters = Array.from(clean)
  if (characters.length <= maxChars) return clean
  if (maxChars === 1) return ELLIPSIS
  const matchedIndex = Math.min(matchStartIndex(clean, regex), characters.length - 1)
  let start = Math.max(0, matchedIndex - Math.floor(maxChars / 3))
  const prefix = start > 0 ? ELLIPSIS : ''
  let suffix = ELLIPSIS
  let contentLength = maxChars - prefix.length - suffix.length
  if (contentLength < 1) {
    start = matchedIndex
    suffix = ''
    contentLength = maxChars - prefix.length - suffix.length
  } else if (matchedIndex >= start + contentLength) {
    start = matchedIndex - contentLength + 1
  }
  let end = Math.min(characters.length, start + contentLength)
  if (end === characters.length) {
    suffix = ''
    contentLength = maxChars - prefix.length
    start = Math.max(0, end - contentLength)
  }
  end = Math.min(characters.length, start + contentLength)
  return `${prefix}${characters.slice(start, end).join('')}${suffix}`
}

/** Replace NUL with the Unicode replacement char so indexed text stays clean. */
export function sanitizeText(text: string): string {
  return text.replaceAll('\0', '�')
}
