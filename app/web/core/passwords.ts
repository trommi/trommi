// passwords.ts: what the account screens check and make on the PAGE, before anything goes to the core worker: is
// this an e-mail address, is the new password long enough, are these twelve words, and a generated password to offer.
//
// The rules themselves are the core's (core/src/account.rs: normaliseEmail, checkPassword, parseKitWords), and the
// core decides: account.ts asks it again in the worker for everything that is sent or derived, and its refusals
// (`bad-email`, `weak-password`, `bad-recovery-words`) are worded by the screens exactly like these checks. The page's
// thread never loads the core (its WASM is the worker's), so a form's own word, said while the person types and
// before a passkey is made for an address, is checked here:
// - the e-mail rule and the password rule are written out again, and tests/web/account runs both against the core
//   over spec/account-vectors.json and more, so that the two cannot drift apart unnoticed;
// - the kit's words are only counted: whether each is a word of the list is the core's to say.
// Nothing here derives a key. The Emergency Kit's words are made by the core (generateKitWords), never here.
import { WORDS } from './wordlist.ts'

export const PASSWORD_MIN = 12

const refusal = (code: string, message: string): Error => Object.assign(new Error(message), { code })

/**
 * An e-mail address as the account keeps it; `bad-email` for anything else. The rule is spelled out over single
 * characters and uses no Unicode table:
 *   1. Leading and trailing space, tab, line feed, vertical tab, form feed and carriage return are dropped.
 *   2. Every character left is printable ASCII, U+0021 to U+007E. Anything else is refused, never mapped: an address
 *      with other characters is written in its ASCII form (a domain as punycode).
 *   3. A to Z become a to z.
 *   4. At most 254 characters; exactly one "@"; 1 to 64 characters before it; after it a "." with 1 to 190 characters
 *      before and 2 to 63 after.
 */
export function normaliseEmail(email: unknown): string {
  const bad = (): Error => refusal('bad-email', 'not an email address')
  const s = String(email ?? '')
  const blank = (c: number): boolean => c === 0x20 || (c >= 0x09 && c <= 0x0d)
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

/** null if the password may be set, else why not. The only rule: its NFC form has at least 12 code points. */
export function passwordProblem(password: unknown): string | null {
  return [...String(password ?? '').normalize('NFC')].length >= PASSWORD_MIN ? null : `at least ${PASSWORD_MIN} characters`
}

/**
 * The Emergency Kit's words as typed, lowercase with one space between, if they are twelve runs of letters;
 * `bad-recovery-words` otherwise. Whether each is a word of the kit's list is not looked at here: the core says.
 */
export function parseRecoveryWords(text: unknown): string {
  const words = String(text ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean)
  if (words.length !== 12) throw refusal('bad-recovery-words', 'the Emergency Kit has 12 words')
  return words.join(' ')
}

/** A strong password to offer: five uniformly random words of the list joined by "-" (about 64 bits), e.g.
 *  'acorn-velvet-tidy-hamper-oxford'. Rejection sampling, no modulo bias. */
export function generatePassword(): string {
  const out: string[] = []
  const limit = Math.floor(65536 / WORDS.length) * WORDS.length
  while (out.length < 5) {
    for (const v of crypto.getRandomValues(new Uint16Array(10))) if (v < limit && out.length < 5) out.push(WORDS[v % WORDS.length]!)
  }
  return out.join('-')
}
