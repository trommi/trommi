// trommi-core for the browser: what an app imports. Types: trommi-core.d.ts.
//
// Under this file lie the wasm-bindgen module (trommi_core_wasm.js, written by the build) and the .wasm file. This
// layer adds what the core, which is synchronous and has no I/O, cannot do itself in a browser:
//
// - A device's calls are asynchronous and run one after another. After each call, what the core wrote is stored
//   (one transaction of the host's store per write) BEFORE the call's result reaches the caller: nothing leaves a
//   device that is not stored with the state it implies. If storing fails, the device is closed, because its
//   memory is then ahead of what is stored; the app opens the stored state again.
// - A fault inside the core (a panic) stops the WebAssembly module. Every later call is then refused with the
//   code `internal`: the module's memory is no longer trusted. The worker, or the page, is thrown away and loaded
//   again; that also ends whatever the stopped module still held.
// - Arguments are copied when a call is made (see "arguments" below); results are fresh objects of the caller's.
// - Every refusal is a TrommiError with the stable code of the specification's section 16 in `code`.
//
// It runs in a module worker and in the page, needs no bundler, and no more of the Content-Security-Policy than
// script-src 'self' 'wasm-unsafe-eval'.
import initWasm, * as raw from './trommi_core_wasm.js'

/** A refusal or a finding: `code` is its stable code, `message` is for a log and never holds key material. For the
 *  code `storage`, `cause` is what the store threw: a StoreConflict when another owner has, or wrote to, the state. */
export class TrommiError extends Error {
  constructor(code, message, cause) {
    super(message ?? code, cause === undefined ? undefined : { cause })
    this.name = 'TrommiError'
    this.code = code
  }
}

/** What a store's `apply` throws when the stored revision is not the one the write names, and `load` when another
 *  owner holds the state. */
export class StoreConflict extends Error {
  constructor(message = 'another owner wrote to this state') {
    super(message)
    this.name = 'StoreConflict'
  }
}

let loading = null   // the promise of init(), once it was called
let loaded = false   // the module is instantiated
let stopped = false  // a fault stopped the module

/**
 * Loads the WebAssembly module. `source` is where the .wasm comes from: a URL, a Response or a promise of one (so
 * that the app can fetch it with `integrity`), bytes, or a compiled WebAssembly.Module. Without it the file next
 * to the glue is fetched. Calling it again returns the same promise; after a failure it may be called again.
 */
export function init(source) {
  loading ??= initWasm(source === undefined ? undefined : { module_or_path: source }).then(
    () => { loaded = true },
    error => { loading = null; throw error },
  )
  return loading
}

/** One call into the module. An export answers with a pair: [null, value], or [code, message] for a refusal of the
 *  core's. Whatever is thrown instead is a fault (a panic in the core, a misuse of the glue): the module stops for
 *  good. So a refusal cannot be forged by an exception, and a fault cannot pass for a refusal. */
function call(target, name, args) {
  if (!loaded) throw new TrommiError('internal', 'internal: init() has not finished')
  if (stopped) throw new TrommiError('internal', 'internal: the core stopped after a fault: load it again')
  let code, value
  try {
    [code, value] = target[name](...args)
  } catch {
    stopped = true
    throw new TrommiError('internal', 'internal: a fault inside the core: load it again')
  }
  if (code !== null) throw new TrommiError(code, value)
  return value
}

/** snake_case, as the module exports a call, to camelCase, as this file does. */
const camel = name => name.replace(/_([a-z0-9])/g, (_, letter) => letter.toUpperCase())

// ---- arguments ----------------------------------------------------------------------------------------------------
//
// What a caller hands in is copied when the call is made, into plain values of this realm: bytes into a fresh
// Uint8Array of exactly their length, a list into a fresh Array, a record into an object of its own fields. The
// core then never sees a caller's object: nothing of the caller's runs while the core works (no getter, no
// iterator), a later change of an argument changes nothing, and a view of a larger or shared buffer brings along
// only its own bytes. The copies of bytes are overwritten when the call is over. What a store's load() returns is
// treated the same way.

// The brand and the length of a typed array, read past whatever the object itself claims; both work across realms.
const typedArray = Object.getPrototypeOf(Uint8Array.prototype)
const typedArrayName = Object.getOwnPropertyDescriptor(typedArray, Symbol.toStringTag).get
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArray, 'byteLength').get
const fill = Uint8Array.prototype.fill
const MAX_BYTES = 256 * 1024 * 1024 // all bytes of one call together: above the largest stored file, and room for a long room history
const MAX_VALUES = 4 * 1024 * 1024 // every value of one call together: a room's whole log served for a join is far below
const MAX_TEXT = 1024 * 1024       // no call takes longer text
// How deep the deepest argument of any call is nested: a ServedRoom holds a list of groups, each a list of
// Commits, each with its bytes. tests/bindings/manifest.mjs works this out from the facade's declarations and
// fails when this number is another. It keeps a cyclic object from being walked for ever; the budgets above are
// what bounds the work.
const MAX_DEPTH = 5

/** Copies one argument. `copies` collects the byte arrays made, so that they can be overwritten after the call. */
function snapshot(value, copies, depth = 0) {
  if (++copies.values > MAX_VALUES) throw new TrommiError('too-large', 'too-large: the arguments of one call')
  if (value === null || value === undefined) return null
  const type = typeof value
  if (type === 'boolean' || type === 'number') return value
  if (type === 'string') {
    if (value.length > MAX_TEXT) throw new TrommiError('too-large', 'too-large: a text')
    return value
  }
  if (type !== 'object' || depth > MAX_DEPTH) throw new TrommiError('bad-format', 'bad-format: an argument of a kind no call takes')
  if (typedArrayName.call(value) !== undefined) {
    if (typedArrayName.call(value) !== 'Uint8Array') throw new TrommiError('bad-format', 'bad-format: bytes are a Uint8Array')
    copies.bytes += typedArrayLength.call(value)
    if (copies.bytes > MAX_BYTES) throw new TrommiError('too-large', 'too-large: the arguments of one call')
    let copy
    try { copy = new Uint8Array(value) } catch { throw new TrommiError('bad-format', 'bad-format: the bytes cannot be read') }
    copies.made.push(copy)
    return copy
  }
  if (Array.isArray(value)) {
    const length = value.length
    if (!(length <= MAX_VALUES)) throw new TrommiError('too-large', 'too-large: a list')
    const copy = new Array(length)
    for (let at = 0; at < length; at++) copy[at] = snapshot(value[at], copies, depth + 1)
    return copy
  }
  const copy = Object.create(null)
  for (const key of Object.keys(value)) copy[key] = snapshot(value[key], copies, depth + 1)
  return copy
}

/** The arguments of one call, copied, and the way to overwrite the copies of their bytes afterwards: an argument
 *  may be a key. If copying fails half-way, what was copied is overwritten at once. */
function taken(args) {
  const copies = { bytes: 0, values: 0, made: [] }
  const wipe = () => { for (const copy of copies.made) fill.call(copy, 0) }
  try {
    return { args: args.map(argument => snapshot(argument, copies)), wipe }
  } catch (error) {
    wipe()
    throw error
  }
}

/** One call into the module with the caller's arguments: copied before, the copies overwritten after. */
function callWith(target, name, args) {
  const copied = taken(args)
  try {
    return call(target, name, copied.args)
  } finally {
    copied.wipe()
  }
}

/** Overwrites every byte array in a result that reaches nobody. */
function wipeResult(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH + 1) return
  if (value instanceof Uint8Array) fill.call(value, 0)
  else for (const inner of Array.isArray(value) ? value : Object.values(value)) wipeResult(inner, depth + 1)
}

/** Overwrites the bytes of records the module made for a store (they hold private keys), once they were used. */
function wipe(entries) {
  for (const entry of entries) fill.call(entry.value, 0)
}

// ---- the device ---------------------------------------------------------------------------------------------------

// The device's calls, by the names the module exports them under.
const DEVICE_CALLS = [
  'id', 'room', 'cursor', 'is_human', 'is_owner', 'room_roles', 'groups', 'group', 'holds_key',
  'outbox', 'outbox_accepted', 'outbox_refused', 'key_packages_to_upload', 'key_package',
  'found_room', 'found_session', 'found_helper', 'add_to_session', 'remove_agents',
  'remove_human_devices', 'clean_session', 'readmit_helper', 'readmit_human', 'update', 'archive',
  'join_welcome', 'observe_room', 'observe_session', 'process_log_entry', 'feed',
  'send_handover', 'handovers_sent', 'handover_read', 'send_stroke_piece', 'send_work_trail', 'hub_sign_in',
  'holds_recovery_mac', 'key_is_confirmed', 'send_recovery_auth', 'post_sealed_key', 'verify_founding',
  'join_room_with_code', 'join_session_with_code', 'new_recovery_code', 'replace_code', 'prepare_recovery', 'recover',
  'learn_history', 'group_past',
  'invite_open', 'invite_accept', 'invite_confirm', 'invite_recommit', 'invite_steps', 'invite_handover', 'invite_checked', 'invite_forget',
  'join_request', 'join_reveal', 'join_observe', 'join_invited',
  'seal', 'outbox_voided', 'envelope_abandon', 'receive_envelope', 'receive_relay', 'heads_due', 'compare_heads',
  'cut_of', 'chain_head', 'chain_cut', 'object', 'objects', 'object_owner', 'register', 'register_of', 'board_load',
  'command', 'command_finished', 'commands_pending', 'commands_uncertain', 'findings', 'findings_read',
]

const CONSTRUCT = Symbol('Device')
// The store objects that belong to a device, or are being opened for one: a store object serves one device.
const owned = new WeakSet()

/**
 * One device over the host's store. Exactly one Device works on a stored state at a time; the store holds the lock
 * that makes it so (see idb-store.js).
 */
export class Device {
  #raw
  #store
  #tail = Promise.resolve()   // the end of the queue of calls
  #closed = null              // why the device answers no more

  constructor(token, rawDevice, store) {
    if (token !== CONSTRUCT) throw new TypeError('use Device.create(store) or Device.open(store)')
    this.#raw = rawDevice
    this.#store = store
  }

  /** A new device in the empty store: a fresh signature key, no room yet. `storage` when the store is not empty. */
  static create(store) { return Device.#start(store, 'create') }

  /** The device the store holds. `storage` when anything in it does not decode or fit together. */
  static open(store) { return Device.#start(store, 'open') }

  static async #start(store, how) {
    if (owned.has(store)) throw new TrommiError('storage', 'storage: this store object already belongs to a device')
    owned.add(store)
    let loadedState
    try {
      loadedState = await store.load()
    } catch (error) {
      // A store whose load failed owns nothing, and cleans up after itself: it is not closed from here.
      owned.delete(store)
      throw storageError(error)
    }
    // From here the store is this device's, and is closed if anything fails before the device stands.
    try {
      // What the store handed over is copied like any argument: the core reads the copy, which is then overwritten.
      const rawDevice = callWith(raw.RawDevice, how, [loadedState])
      const device = new Device(CONSTRUCT, rawDevice, store)
      await device.#enqueue(() => undefined)   // stores what creating wrote: the new key
      return device
    } catch (error) {
      await closeStore(store)
      throw error
    }
  }

  /** Runs `work` after every earlier call, then stores what it wrote, then hands on what it returned or threw. */
  #enqueue(work) {
    const job = this.#tail.then(async () => {
      if (this.#closed) throw this.#closed
      let result, refusal
      try {
        result = work()
      } catch (error) {
        refusal = error
      }
      // Also after a refusal: whatever the call wrote is stored before anyone hears of it. A result that is
      // withheld because storing failed may hold decrypted content: it is overwritten, not left to the collector.
      try {
        await this.#flush()
      } catch (error) {
        wipeResult(result)
        throw error
      }
      if (refusal) throw refusal
      return result
    })
    this.#tail = job.catch(() => {})
    return job
  }

  async #flush() {
    let writes
    try {
      writes = call(this.#raw, 'take_writes', [])
    } catch (error) {
      await this.#shut(error)
      throw error
    }
    try {
      try {
        // A call that wrote several times (feed) is stored in one step where the store can: all of it or none.
        if (writes.length > 1 && typeof this.#store.applyAll === 'function') await this.#store.applyAll(writes)
        else for (const write of writes) await this.#store.apply(write)
      } catch (error) {
        const failure = storageError(error)
        await this.#shut(failure)
        throw failure
      }
    } finally {
      // Stored or not, this side's copies of what was written go.
      for (const write of writes) wipe(write.put)
    }
  }

  /** Closes the raw device and the store, once. */
  async #shut(reason) {
    if (this.#closed) return
    this.#closed = reason
    if (!stopped) {
      try { this.#raw.close(); this.#raw.free() } catch { stopped = true }
    }
    await closeStore(this.#store)
  }

  /**
   * Closes the device after the calls already made, wipes what the core holds of it, and closes the store (which
   * releases its lock). Every later call is refused. The stored state is untouched and can be opened again.
   */
  close() {
    const job = this.#tail.then(() => this.#shut(new TrommiError('internal', 'internal: the device is closed')))
    this.#tail = job.catch(() => {})
    return job
  }

  static {
    for (const name of DEVICE_CALLS) {
      Device.prototype[camel(name)] = function (...args) {
        // Copied now, not when the call's turn comes: what the caller does with its objects afterwards is its own.
        let copied
        try { copied = taken(args) } catch (error) { return Promise.reject(error) }
        const job = this.#enqueue(() => call(this.#raw, name, copied.args))
        // Whether the call ran, was refused, or never got its turn: the copies go.
        job.then(copied.wipe, copied.wipe)
        return job
      }
    }
  }
}

function storageError(error) {
  if (error instanceof TrommiError) return error
  // The store's own words, as the core reports a store's failure. A store never puts a stored value into them.
  // What it threw goes along as the cause: `error.cause instanceof StoreConflict` is "open somewhere else".
  return new TrommiError('storage', `storage: ${error instanceof Error ? error.message : 'the store failed'}`, error)
}

async function closeStore(store) {
  try { await store.close?.() } catch { /* a store that fails to close is closed as far as this side can tell */ }
  owned.delete(store)
}

// ---- files --------------------------------------------------------------------------------------------------------

const CALL = Symbol('call')

/** What an encryptor and a decryptor share: the object in the module, and its end. */
class FileObject {
  #raw
  constructor(rawObject) { this.#raw = rawObject }

  /** A call on the object in the module; `internal` once the object was used up or closed. */
  [CALL](name, args, last = false) {
    if (!this.#raw) throw new TrommiError('internal', 'internal: the object is closed')
    const rawObject = this.#raw
    if (last) this.#raw = null
    try {
      return callWith(rawObject, name, args)
    } finally {
      if (last && !stopped) { try { rawObject.free() } catch { stopped = true } }
    }
  }

  /** Gives the object up without finishing: its key and what it holds of the file are wiped. */
  close() {
    const rawObject = this.#raw
    this.#raw = null
    if (rawObject && !stopped) { try { rawObject.free() } catch { stopped = true } }
  }
}

/** Encrypts one file piece by piece, under a key it makes for that file alone. Everything `update` and `finish`
 *  return, in order, is the stored file. */
export class FileEncryptor extends FileObject {
  constructor() { super(call(raw.RawFileEncryptor, 'create', [])) }
  fileId() { return this[CALL]('file_id', []) }
  update(plaintext) { return this[CALL]('update', [plaintext]) }
  finish() { return this[CALL]('finish', [], true) }
}

/** Decrypts a stored file piece by piece. What `update` handed out counts only once `finish` succeeded. */
export class FileDecryptor extends FileObject {
  constructor(file) { super(callWith(raw.RawFileDecryptor, 'create', [file])) }
  update(stored) { return this[CALL]('update', [stored]) }
  finish() { return this[CALL]('finish', [], true) }
}

// ---- everything without state -------------------------------------------------------------------------------------

const plain = name => (...args) => callWith(raw, name, args)

export const versions = plain('versions')
export const selfTest = plain('self_test')
export const logFinding = plain('log_finding')
export const errorCodeText = plain('error_code_text')
export const errorCodeFromText = plain('error_code_from_text')
export const keyPackageInfo = plain('key_package_info')
export const roomGroupId = plain('room_group_id')
export const sessionGroupId = plain('session_group_id')
export const base64urlEncode = plain('base64url_encode')
export const base64urlDecode = plain('base64url_decode')
export const fileLayout = plain('file_layout')
export const fileChunk = plain('file_chunk')
export const openFileChunk = plain('open_file_chunk')
export const shareLinkCreate = plain('share_link_create')
export const shareLinkParse = plain('share_link_parse')
export const checkShareExpiry = plain('check_share_expiry')
export const normaliseEmail = plain('normalise_email')
export const checkPassword = plain('check_password')
export const kdfRecord = plain('kdf_record')
export const passwordKeys = plain('password_keys')
export const kitKeys = plain('kit_keys')
export const passkeyWrapKey = plain('passkey_wrap_key')
export const passkeyPrfInput = plain('passkey_prf_input')
export const sealRecoveryCode = plain('seal_recovery_code')
export const openRecoveryCode = plain('open_recovery_code')
export const generateRecoveryCode = plain('generate_recovery_code')
export const formatRecoveryCode = plain('format_recovery_code')
export const parseRecoveryCode = plain('parse_recovery_code')
export const generateKitWords = plain('generate_kit_words')
export const parseKitWords = plain('parse_kit_words')
export const generateUserHandle = plain('generate_user_handle')
export const generatePushKey = plain('generate_push_key')
export const openApnsPush = plain('open_apns_push')
export const readWebPush = plain('read_web_push')
export const recoveryAnchor = plain('recovery_anchor')
export const recoverySignIn = plain('recovery_sign_in')
export const boardReduce = plain('board_reduce')
export const inviteLinkParse = plain('invite_link_parse')
export const checkEmoji = plain('check_emoji')
export const hubAddress = plain('hub_address')
export const kitKeysFor = plain('kit_keys_for')
export const accountIdParse = plain('account_id_parse')
export const envelopeHeader = plain('envelope_header')
