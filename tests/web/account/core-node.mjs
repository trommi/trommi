// core-node.mjs: stands where app/web/core/core-wasm.ts stands in the app, for the account's tests in Node. TEST ONLY.
// core-wasm.ts fetches the .wasm from the address the build wrote into it, which Node has none of; this module loads
// the SAME binding (core/wasm/pkg) from the disk and hands it out as core-wasm.ts does: the functions without state
// as they are, and `errorCode`. Every password key, e-mail kit key, sealed copy, word and code in these tests is the
// real core's. (A `Device` is not handed out here; room-fake.mjs makes its own where a test runs against the real hub.)
//
// TWO CALLS HERE ARE A TEST DOUBLE, NOT THE CORE: `kitKeysFor` and `accountIdParse`, which core-api.ts names as
// provisional because the binding in this worktree does not export them (the core has them: core/src/account.rs
// `kit_keys_for`, `AccountId::parse`, v2-core 11b0511). The double below is written from that file's own words:
//   salt = SHA-256("trommi/v2/account-salt/id" 0x00 ‖ account id, 16 bytes)
//   auth key = HKDF-SHA-256(r, salt, info = "trommi/v1/recovery-auth" 0x00, 32), wrap key with "trommi/v1/recovery-wrap-key"
//   r = the UTF-8 of the twelve words as the REAL core's `parseKitWords` normalises them
// and vectors.test.mjs holds it to the core's known answers for exactly this (id-kit-vectors.json, a copy of
// spec/vectors/account.json of that commit), and to the real `kitKeys` for the e-mail form. So what the account's
// tests show for an account without e-mail is account.ts's logic over a double; that the app's core derives these
// keys is NOT shown here. `provisional.missing = true` makes both calls refuse with `core-missing`, as core-wasm.ts
// answers them today. If the binding exports the two names, they are taken from it and the double is not used.
import { createHash, hkdfSync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import * as binding from '../../../core/wasm/pkg/trommi-core.js'

const { init, Device: _Device, TrommiError, StoreConflict: _StoreConflict, ...stateless } = binding

/** Whether the two provisional calls are the binding's own (then nothing here stands in for them). */
export const provisional = { missing: false, real: typeof stateless.kitKeysFor === 'function' && typeof stateless.accountIdParse === 'function' }
const missing = call => Object.assign(new Error(`core-missing: the core's WASM binding has no ${call} yet`), { name: 'CoreMissing', code: 'core-missing' })
const labelled = (label, more = new Uint8Array(0)) => Buffer.concat([Buffer.from(label), Buffer.from([0]), more])
const double = {
  kitKeysFor(name, words) {
    if (provisional.missing) throw missing('kitKeysFor')
    if (name.kind === 'email') return stateless.kitKeys(name.email, words)
    if (!(name.id instanceof Uint8Array) || name.id.length !== 16) throw new TrommiError('bad-format')
    const salt = createHash('sha256').update(labelled('trommi/v2/account-salt/id', name.id)).digest()
    const r = Buffer.from(stateless.parseKitWords(words))
    const key = label => new Uint8Array(hkdfSync('sha256', r, salt, labelled(label), 32))
    return { authKey: key('trommi/v1/recovery-auth'), wrapKey: key('trommi/v1/recovery-wrap-key') }
  },
  accountIdParse(text) {
    if (provisional.missing) throw missing('accountIdParse')
    if (typeof text !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(text)) throw new TrommiError('bad-format')
    return new Uint8Array(Buffer.from(text.replaceAll('-', ''), 'hex'))
  },
}

let loading = null
export function loadCore() {
  loading ??= readFile(new URL('../../../core/wasm/pkg/trommi_core_wasm_bg.wasm', import.meta.url)).then(init).then(() => ({
    ...(provisional.real ? {} : double),
    ...stateless,
    errorCode: error => (error instanceof TrommiError ? error.code : error?.code === 'core-missing' ? 'core-missing' : null),
  }))
  return loading
}
export { binding }
