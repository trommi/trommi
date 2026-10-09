// passwords.ts: the account's light parts, without the key derivation or a room behind them (the account screens use
// them in the page, account.ts and the worker the rest): an email as the account keeps it, the password rule, generated
// passwords and the Emergency Kit's words (the EFF word list, wordlist.ts).
import * as z from './crypto/zcrypto.mjs'
import { WORDS } from './wordlist.ts'

const { ZError } = z
export const PASSWORD_MIN = 12

/**
 * An email address as the account keeps it. Its bytes are the input of the account's salt, so the rule is spelled out
 * over single characters and uses no Unicode table (trimming, case mapping and normalisation differ between
 * runtimes): the iOS app's code is the same steps, and both run spec/account-vectors.json "email".
 *   1. Leading and trailing space, tab, line feed, vertical tab, form feed and carriage return are dropped.
 *   2. Every character left is printable ASCII, U+0021 to U+007E. Anything else is refused, never mapped: an address
 *      with other characters is written in its ASCII form (a domain as punycode).
 *   3. A to Z become a to z.
 *   4. At most 254 characters; exactly one "@"; 1 to 64 characters before it; after it a "." with 1 to 190 characters
 *      before and 2 to 63 after.
 * Anything else: ZError 'bad-email'.
 */
export function normaliseEmail(email: unknown): string {
  const bad = () => new ZError('bad-email', 'not an email address')
  const s = String(email ?? '')
  const blank = (c: number) => c === 0x20 || (c >= 0x09 && c <= 0x0d)
  let from = 0, to = s.length
  while (from < to && blank(s.charCodeAt(from))) from++
  while (to > from && blank(s.charCodeAt(to - 1))) to--
  if (to - from > 254) throw bad()
  let e = '', at = -1
  for (let i = from; i < to; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x21 || c > 0x7e) throw bad()
    if (c === 0x40) { if (at >= 0) throw bad(); at = e.length }
    e += String.fromCharCode(c >= 0x41 && c <= 0x5a ? c + 0x20 : c)
  }
  if (at < 1 || at > 64) throw bad()
  const domain = e.slice(at + 1)
  for (let dot = domain.indexOf('.'); dot >= 0; dot = domain.indexOf('.', dot + 1)) {
    const after = domain.length - dot - 1
    if (dot >= 1 && dot <= 190 && after >= 2 && after <= 63) return e
  }
  throw bad()
}
/** null if the password may be used, else why not. The only rule: at least 12 characters. */
export function passwordProblem(password: unknown): string | null {
  return [...String(password ?? '').normalize('NFC')].length >= PASSWORD_MIN ? null : `at least ${PASSWORD_MIN} characters`
}

/** n uniformly random words of the list (rejection sampling, no modulo bias). */
function randomWords(n: number): string[] {
  const out: string[] = []
  const limit = Math.floor(65536 / WORDS.length) * WORDS.length
  while (out.length < n) {
    for (const v of crypto.getRandomValues(new Uint16Array(n * 2))) if (v < limit && out.length < n) out.push(WORDS[v % WORDS.length]!)
  }
  return out
}
/** A strong password to offer: five words joined by "-" (≈64 bits), e.g. 'acorn-velvet-tidy-hamper-oxford'. */
export function generatePassword(): string { return randomWords(5).join('-') }
/** The Emergency Kit's recovery words: twelve words (≈155 bits), one space between. */
export function generateRecoveryWords(): string { return randomWords(12).join(' ') }
const WORD_SET = new Set(WORDS)
/** Normalised recovery words (lowercase, single spaces), or ZError 'bad-recovery-words'. */
export function parseRecoveryWords(text: unknown): string {
  const words = String(text ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean)
  if (words.length !== 12) throw new ZError('bad-recovery-words', 'the Emergency Kit has 12 words')
  const unknown = words.filter(w => !WORD_SET.has(w))
  if (unknown.length) throw new ZError('bad-recovery-words', `not a word of the kit: ${unknown.join(', ')}`)
  return words.join(' ')
}
