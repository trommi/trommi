// core-wasm.ts: the Rust core (`trommi-core`) as the web app holds it, made from its WASM binding (core/wasm). THE
// ONLY MODULE that imports the binding's scripts and fetches its .wasm; everything else is written against the `Core`
// of core-api.ts, which the tests' stand-in implements as well.
//
// What it does: loads the WebAssembly module once (`loadCore`), then hands out the binding as it is: its functions
// without state (versions, the self test, the account, files, share links, ids, push), a `Device` made or opened
// over a store, and `errorCode`. What core-api.ts calls PROVISIONAL, the calls the binding does not have yet, is
// added as refusals: each throws (a device's: rejects with) a `core-missing` error that names the call. The two
// tables below are all of it; a name leaves its table the day the binding exports the call.
//
// Where the files come from (app/web/dev/build.mjs "the Rust core"): the binding's scripts (its own layer
// trommi-core.js, wasm-bindgen's glue under it, idb-store.js) are bundled into the worker with this module, like the
// app's own code. Only the .wasm is a file of its own, named by its content in the deployed bundle; the build tells
// this module its address and the SHA-256 of its bytes through the two constants below (the dev server too).
//
// Integrity: the .wasm is fetched with that SHA-256 (`fetch(url, { integrity })`), so the browser hands over nothing
// but the bytes the build saw, and the binding instantiates exactly that response. No script of the core is loaded
// on its own: all of it is inside the worker's one file, which is as trustworthy as the worker itself (this origin
// only, CSP `script-src 'self'`; a worker's script and its imports take no integrity).
import * as binding from '../../../core/wasm/js/trommi-core.js'
import type { Core, Device, ErrorCode, ProvisionalDevice, ProvisionalStateless, Store } from './core-api.ts'

/** The binding's store on IndexedDB (store-idb.ts is handed this class and wraps it). */
export { IdbStore } from '../../../core/wasm/js/idb-store.js'

/** The address of the .wasm and the base64 SHA-256 of its bytes (app/web/dev/build.mjs coreFiles). */
declare const __TROMMI_CORE_WASM__: string
declare const __TROMMI_CORE_WASM_SHA256__: string

/** The calls of core-api.ts the binding does not have yet (a Record: a call missing here, or one too many, does not compile). */
const MISSING_ON_DEVICE: Record<keyof ProvisionalDevice, true> = {
  seal: true, receiveEnvelope: true, headsDue: true, cutOf: true,
  inviteOpen: true, inviteAccept: true, inviteConfirm: true, joinRequest: true, joinReveal: true,
  recoverySignIn: true, joinWithCode: true, replaceRecoveryCode: true, sendRecoveryAuth: true,
}
const MISSING_STATELESS: Record<keyof ProvisionalStateless, true> = { inviteLinkParse: true, checkEmoji: true, hubAddress: true, boardReduce: true }

/** What a call the binding lacks answers with. */
class CoreMissing extends Error {
  readonly code = 'core-missing'
  constructor(call: string) {
    super(`core-missing: the core's WASM binding has no ${call} yet`)
    this.name = 'CoreMissing'
  }
}

/** The refusals for a table of names: each throws CoreMissing, or returns a rejected promise where the real call is asynchronous. */
function refusals<T>(missing: Record<keyof T & string, true>, asynchronous: boolean): T {
  const refuse = (name: string) => () => { if (asynchronous) return Promise.reject(new CoreMissing(name)); throw new CoreMissing(name) }
  return Object.fromEntries(Object.keys(missing).map(name => [name, refuse(name)])) as T
}

/** The binding's device, with the calls it lacks added to that same object (its own calls need it to be itself). */
const whole = (device: binding.Device): Device => Object.assign(device, refusals<ProvisionalDevice>(MISSING_ON_DEVICE, true))

async function load(): Promise<Core> {
  await binding.init(fetch(__TROMMI_CORE_WASM__, { integrity: `sha256-${__TROMMI_CORE_WASM_SHA256__}` }))
  const { init: _init, Device: _Device, TrommiError: _TrommiError, StoreConflict: _StoreConflict, ...stateless } = binding
  return {
    ...stateless,
    ...refusals<ProvisionalStateless>(MISSING_STATELESS, false),
    createDevice: async (store: Store) => whole(await binding.Device.create(store)),
    openDevice: async (store: Store) => whole(await binding.Device.open(store)),
    errorCode: (error: unknown): ErrorCode | 'core-missing' | null => (error instanceof binding.TrommiError ? error.code : error instanceof CoreMissing ? error.code : null),
  }
}

let loading: Promise<Core> | null = null
/** The core, loaded and instantiated once. A failed load (offline, a .wasm that is not the build's) is not kept:
 *  the next call tries again. */
export function loadCore(): Promise<Core> {
  loading ??= load().catch(err => { loading = null; throw err })
  return loading
}
