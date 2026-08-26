/** Offline unit tests for query normalization, phrase matching, and snippets. */

import { describe, expect, it } from 'vitest'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import {
  codePointLength,
  countPhrase,
  makeSnippet,
  matchStartIndex,
  normalizeQuery,
  phraseRegex,
  tokenize,
} from '../src/text.ts'

describe('normalizeQuery', () => {
  it('trims and collapses inner whitespace', () => {
    expect(normalizeQuery('  hello   world \n')).toBe('hello world')
  })
  it('rejects non-strings, empty/whitespace, and NUL', () => {
    for (const bad of [42, undefined, null, {}]) {
      expect(() => normalizeQuery(bad)).toThrow(SessionQueryError)
    }
    expect(() => normalizeQuery('')).toThrow('must not be empty')
    expect(() => normalizeQuery('   ')).toThrow('must not be empty')
    expect(() => normalizeQuery('a\0b')).toThrow('NUL')
  })
})

describe('tokenize', () => {
  it('splits on non-alphanumerics and case-folds, keeping unicode letters/digits', () => {
    expect(tokenize('Alpha, beta! 123')).toEqual(['alpha', 'beta', '123'])
    expect(tokenize('café—/ünï')).toEqual(['café', 'ünï'])
    expect(tokenize('   ')).toEqual([])
  })
})

describe('phrase matching', () => {
  const count = (text: string, query: string): number => {
    const regex = phraseRegex(query)
    return regex === undefined ? 0 : countPhrase(text, regex)
  }
  it('matches a case-insensitive token phrase on token boundaries', () => {
    expect(count('xx alpha beta yy', 'alpha beta')).toBe(1)
    expect(count('ALPHA   BETA', 'alpha beta')).toBe(1)
    expect(count('start alpha beta then alpha beta end', 'alpha beta')).toBe(2)
  })
  it('requires adjacency and whole tokens (operators are inert data)', () => {
    expect(count('alpha middle beta', 'alpha beta')).toBe(0)
    expect(count('alphabeta', 'alpha')).toBe(0)
    expect(count('zalpha', 'alpha')).toBe(0)
    expect(count('needle', 'needle OR absent')).toBe(0)
    expect(count('needle or absent word', 'needle OR absent')).toBe(1)
  })
  it('has no tokens for a punctuation-only query (matches nothing)', () => {
    expect(phraseRegex('***')).toBeUndefined()
  })
})

describe('makeSnippet', () => {
  it('returns the whole cleaned text when it fits', () => {
    expect(makeSnippet('  short\ntext  ', undefined, 240)).toBe('short text')
  })
  it('truncates the head with a trailing ellipsis when there is no match', () => {
    expect(makeSnippet('abcdefghij', undefined, 5)).toBe('abcd…')
  })
  it('collapses to a single ellipsis at maxChars 1', () => {
    expect(makeSnippet('abcdefghij', undefined, 1)).toBe('…')
  })
  it('centers a bounded window on the first match with code-point budget', () => {
    const text = 'the quick brown fox jumps over the lazy dog'
    const regex = phraseRegex('brown')
    const snippet = makeSnippet(text, regex, 11)
    expect(codePointLength(snippet)).toBeLessThanOrEqual(11)
    expect(snippet).toContain('brown')
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
  })
  it('drops the trailing ellipsis when the window reaches the end', () => {
    // Spaced so each letter is its own token; 'f' is the final token (index 10).
    const text = 'a b c d e f'
    const regex = phraseRegex('f')
    expect(matchStartIndex(text, regex)).toBe(10)
    expect(makeSnippet(text, regex, 2)).toBe('…f')
    const wide = makeSnippet(text, regex, 5)
    expect(wide.startsWith('…')).toBe(true)
    expect(wide.endsWith('f')).toBe(true)
    expect(codePointLength(wide)).toBeLessThanOrEqual(5)
  })
})
