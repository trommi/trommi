// setup.mjs: what the account's tests share. TEST ONLY.
//
// account.ts imports two modules that cannot run in Node as they are: core-wasm.ts (it fetches the .wasm the app's
// build names) and room.ts (the engine, which needs a browser's store, and whose joining with the code the core's
// binding does not have yet). A resolve hook puts core-node.mjs (the REAL binding, loaded from core/wasm/pkg) and
// room-fake.mjs (a fake of exactly room.ts's contract) in their places, for account.ts and nothing else. hub.ts,
// ids.ts, passwords.ts and passkey.ts are the app's own files, unchanged.
import { registerHooks } from 'node:module'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import assert from 'node:assert/strict'

const at = path => new URL(path, import.meta.url).href
const SWAPS = new Map([
  [at('../../../app/web/core/core-wasm.ts'), at('./core-node.mjs')],
  [at('../../../app/web/core/room.ts'), at('./room-fake.mjs')],
])
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context)
    const swap = context.parentURL === at('../../../app/web/core/account.ts') ? SWAPS.get(resolved.url) : undefined
    return swap ? { url: swap, shortCircuit: true } : resolved
  },
})

/** Why nothing can run, or null: the binding is built by core/wasm/build.sh (for now with TROMMI_STAND_IN_RECOVERY=1). */
export const no_core = existsSync(new URL('../../../core/wasm/pkg/trommi_core_wasm_bg.wasm', import.meta.url)) ? null : 'the core\'s WASM binding is not built (core/wasm/build.sh)'
if (no_core) console.warn(`\nSKIPPED: the account's tests need the real core: ${no_core}.\n`)

export const { loadCore } = no_core ? { loadCore: null } : await import('./core-node.mjs')
export const core = no_core ? null : await loadCore()
export const account = no_core ? null : await import('../../../app/web/core/account.ts')
export const { stage, resetStage } = await import('./room-fake.mjs')
export { b64u, hex, unb64u, unhex } from '../../../app/web/core/ids.ts'

export const bytes = n => new Uint8Array(randomBytes(n))
export const utf8 = text => new TextEncoder().encode(text)
export const sha256 = data => new Uint8Array(createHash('sha256').update(data).digest())

/** A passkey as a ceremony on the page would hand it over, for the FAKE hub: that hub checks no attestation and
 *  names the credential by the attestation's hash, so the id here is that hash; the prf output is random. */
export function passkeyFor(challenge) {
  const attestation_object = bytes(96)
  return {
    credential_id: sha256(attestation_object).subarray(0, 16).slice(), attestation_object, prf: bytes(32),
    client_data_json: utf8(JSON.stringify({ type: 'webauthn.create', challenge, origin: 'https://app.trommi.test' })), transports: ['internal', 'hybrid'],
  }
}
/** The assertion of a get() with that passkey over a login challenge, with the same prf output. */
export const assertionOf = (passkey, challenge) => ({
  credential_id: passkey.credential_id.slice(), authenticator_data: bytes(37), signature: bytes(70), user_handle: null, prf: passkey.prf.slice(),
  client_data_json: utf8(JSON.stringify({ type: 'webauthn.get', challenge, origin: 'https://app.trommi.test' })),
})
/** The way in a signed-in device gives again with that passkey (its own copy of the prf: account.ts zeroes it). */
export const unlockWith = passkey => ({ passkey: { credential_id: passkey.credential_id.slice(), prf: passkey.prf.slice() } })

/** Every error a test saw thrown, for the scan at the end: no secret in a message or a field. */
export const thrown = []
/** Rejects with this code; the error is kept for the scan. Returns it. */
export async function refused(promise, code) {
  let error = null
  try { await promise } catch (e) { error = e }
  assert.ok(error, `refused with ${code}, but it went through`)
  thrown.push(error)
  assert.equal(error.code, code, `refused with ${code}, not ${error.code}: ${error.message}`)
  assert.equal(typeof error.message, 'string')
  return error
}
/** Everything of an error that could reach a screen, a log or the page's thread (worker-protocol.ts WireError). */
export const told = error => `${error.name} ${error.message} ${error.stack ?? ''} ${JSON.stringify(Object.entries(error))}`
