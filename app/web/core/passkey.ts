// passkey.ts: the two things a passkey ceremony on the PAGE needs before the core worker has anything to do
// (public/auth.mjs, beside navigator.credentials): the hub's challenge for a sign-in or a new account, asked without
// a token, and the fixed input every Trommi passkey evaluates its prf over.
//
// No key is derived here and nothing is sealed: the prf output goes to the worker as bytes, where the core makes
// the passkey's wrap key (account.ts, core `passkeyWrapKey`). The page's thread never loads the core, so the prf
// input is written out here; it is the core's constant (core/src/account.rs PASSKEY_PRF_INPUT, `passkeyPrfInput()`),
// and tests/web/account compares the two.
import { Hub } from './hub.ts'
import { b64u } from './ids.ts'

/** The fixed input of the prf extension: a constant of the client, never chosen by a hub. */
export const PASSKEY_PRF_INPUT: Uint8Array<ArrayBuffer> = new TextEncoder().encode('trommi/v1/passkey-prf')

/** A challenge for a passkey ceremony (base64url; two minutes, one use at the hub): for a login or a new account. */
export async function passkeyChallenge({ hub_url, fetch = null, client = null }: { hub_url: string; fetch?: typeof globalThis.fetch | null; client?: string | null }): Promise<string> {
  return b64u(await new Hub({ hub_url, client_name: client, ...(fetch ? { fetch } : {}) }).passkeyChallenge())
}
