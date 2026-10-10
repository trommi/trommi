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

export { normaliseEmail } from './account-name.ts'

export const PASSWORD_MIN = 12

const refusal = (code: string, message: string): Error => Object.assign(new Error(message), { code })

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
