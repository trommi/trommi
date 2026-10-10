// account-name.ts: how an account is named outside the hub, in public texts. Used on the page (the screens'
// own checks, the QR code on the Emergency Kit) and in the core worker (account.ts) alike; no key, no core.
//
// - An e-mail address as the account keeps it: the core's rule (core/src/account.rs normaliseEmail), written out
//   again for the page, which never loads the core; tests/web/account runs both over the same cases.
// - The one field "E-mail or account ID": told apart by its form alone, exactly as the hub tells it apart
//   (hub/src/accounts.rs `name_of`, `parse_id`; spec/hub-api.md "One field names an account").
// - The Emergency Kit's address, `https://<app>/#k1.<hub>.<id>`: what the kit's QR code holds, so that the recovery
//   screen opens with the hub and the account's id filled in (spec/hub-api.md "The kit sheet"). It lives in the
//   fragment, which reaches no server, and never holds the kit's words.
import { hubAddress } from './hub.ts'
import { b64u, unb64u } from './ids.ts'

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

/** How the one field names an account: by its e-mail, as the account keeps it, or by its id, in the id's one
 *  printed form (lower case, with dashes). */
export type AccountNamed = { kind: 'email'; email: string } | { kind: 'id'; account: string }

/** An account id as it is printed (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`) from 32 hex digits. */
const idText = (digits: string): string => `${digits.slice(0, 8)}-${digits.slice(8, 12)}-${digits.slice(12, 16)}-${digits.slice(16, 20)}-${digits.slice(20)}`

/**
 * The one field "E-mail or account ID", told apart by its form alone, as the hub does: a text with an `@` is an
 * e-mail address (`bad-email` if it is none); any other is an account id, taken without regard to case, white
 * space and dashes, and what is left must be 32 hex digits (`bad-account` otherwise). Nothing is guessed: an
 * e-mail without its `@` is not an e-mail.
 */
export function accountName(text: unknown): AccountNamed {
  const s = String(text ?? '')
  if (s.includes('@')) return { kind: 'email', email: normaliseEmail(s) }
  const digits = s.replace(/[\s-]/gu, '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(digits)) throw refusal('bad-account', 'not an email address and not an account id')
  return { kind: 'id', account: idText(digits) }
}

/**
 * The address the QR code on an Emergency Kit holds: the app's recovery screen with the hub and the account's id
 * filled in, `https://<app>/#k1.<hub address, base64url of its UTF-8>.<account id, 32 hex digits>`. All of it is in
 * the fragment, which reaches no server, and none of it is secret: the kit's words are never part of it (this
 * function is not handed them).
 */
export function kitAddress(app_origin: string, hub_url: string, account: string): string {
  const named = accountName(account)
  if (named.kind !== 'id') throw refusal('bad-account', 'a kit address names the account by its id')
  const origin = new URL(app_origin).origin
  return `${origin}/#k1.${b64u(new TextEncoder().encode(hubAddress(hub_url)))}.${named.account.replaceAll('-', '')}`
}

/**
 * Reads a kit address, or only its fragment (`#k1.…`): the hub's address and the account's id. Strict: exactly the
 * two parts in their one spelling, the hub in its canonical form (`hubAddress`), the id as 32 lower-case hex
 * digits; null for anything else, a fragment that carries more included. What comes back was written by whoever
 * made the link: the screen shows the hub before anything is typed.
 */
export function parseKitAddress(text: unknown): { hub_url: string; account: string } | null {
  const s = String(text ?? ''), at = s.indexOf('#')
  const m = /^#k1\.([A-Za-z0-9_-]{1,700})\.([0-9a-f]{32})$/.exec(at < 0 ? '' : s.slice(at))
  if (!m) return null
  try {
    const hub = new TextDecoder('utf-8', { fatal: true }).decode(unb64u(m[1]!))
    if (hubAddress(hub) !== hub) return null
    return { hub_url: hub, account: idText(m[2]!) }
  } catch { return null }
}
