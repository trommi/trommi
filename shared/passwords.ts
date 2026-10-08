// passwords.ts: the account's light parts, without the key derivation or a room behind them (the account screens use
// them in the page, account.ts and the worker the rest): an email as the account keeps it, the password rule, generated
// passwords and the Emergency Kit's words (the EFF word list, wordlist.ts).
import * as z from './crypto/zcrypto.mjs'
import { WORDS } from './wordlist.ts'

const { ZError } = z
export const PASSWORD_MIN = 12
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/

export function normaliseEmail(email: unknown): string {
  const e = String(email ?? '').normalize('NFC').trim().toLowerCase()
  if (e.length > 254 || !EMAIL.test(e)) throw new ZError('bad-email', 'not an email address')
  return e
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
