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
//   code `internal`: the module's memory is no longer trusted. The worker, or the page, is loaded again.
// - Every refusal is a TrommiError with the stable code of the specification's section 16 in `code`.
//
// It runs in a module worker and in the page, needs no bundler, and no more of the Content-Security-Policy than
// script-src 'self' 'wasm-unsafe-eval'.
import initWasm, * as raw from './trommi_core_wasm.js'

/** A refusal or a finding: `code` is its stable code, `message` is for a log and never holds key material. */
export class TrommiError extends Error {
  constructor(code, message) {
    super(message ?? code)
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

/** One call into the module. Anything it throws that is not a refusal of the core's own is a fault: the module
 *  stops for good. */
function call(target, name, args) {
  if (!loaded) throw new TrommiError('internal', 'internal: init() has not finished')
  if (stopped) throw new TrommiError('internal', 'internal: the core stopped after a fault: load it again')
  try {
    return target[name](...args)
  } catch (error) {
    if (error instanceof Error && error.name === 'TrommiError' && typeof error.code === 'string') {
      throw new TrommiError(error.code, error.message)
    }
    stopped = true
    throw new TrommiError('internal', 'internal: a fault inside the core: load it again')
  }
}

/** snake_case, as the module exports a call, to camelCase, as this file does. */
const camel = name => name.replace(/_([a-z0-9])/g, (_, letter) => letter.toUpperCase())

// ---- the device ---------------------------------------------------------------------------------------------------

// The device's calls, by the names the module exports them under.
const DEVICE_CALLS = [
  'id', 'room', 'cursor', 'is_human', 'is_owner', 'room_roles', 'groups', 'group', 'content_key',
  'outbox', 'outbox_accepted', 'outbox_refused', 'key_packages_to_upload', 'key_package',
  'found_room', 'found_session', 'found_helper', 'add_human_device', 'add_to_session', 'change_agents',
  'remove_human_devices', 'clean_session', 'readmit_helper', 'update', 'archive',
  'join_welcome', 'observe_room', 'observe_session', 'process_log_entry',
  'send_handover', 'handovers_sent', 'handover_read', 'send_stroke_piece', 'send_work_trail', 'hub_sign_in',
]

const CONSTRUCT = Symbol('Device')

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
    let loadedState
    try {
      loadedState = await store.load()
    } catch (error) {
      await closeStore(store)
      throw storageError(error)
    }
    let rawDevice
    try {
      rawDevice = call(raw.RawDevice, how, [loadedState])
    } catch (error) {
      await closeStore(store)
      throw error
    }
    const device = new Device(CONSTRUCT, rawDevice, store)
    await device.#enqueue(() => undefined)   // stores what creating wrote: the new key
    return device
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
      // Also after a refusal: whatever the call wrote is stored before anyone hears of it.
      await this.#flush()
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
    for (const write of writes) {
      try {
        await this.#store.apply(write)
      } catch (error) {
        const failure = storageError(error)
        await this.#shut(failure)
        throw failure
      }
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
        return this.#enqueue(() => call(this.#raw, name, args))
      }
    }
  }
}

function storageError(error) {
  if (error instanceof TrommiError) return error
  if (error instanceof StoreConflict) return new TrommiError('storage', `storage: ${error.message}`)
  // The store's own words, as the core reports a store's failure. A store never puts a stored value into them.
  return new TrommiError('storage', `storage: ${error instanceof Error ? error.message : 'the store failed'}`)
}

async function closeStore(store) {
  try { await store.close?.() } catch { /* a store that fails to close is closed as far as this side can tell */ }
}

// ---- files --------------------------------------------------------------------------------------------------------

/** Encrypts one file piece by piece, under a key it makes for that file alone. Everything `update` and `finish`
 *  return, in order, is the stored file. */
export class FileEncryptor {
  #raw = call(raw.RawFileEncryptor, 'create', [])
  fileId() { return call(this.#raw, 'file_id', []) }
  update(plaintext) { return call(this.#raw, 'update', [plaintext]) }
  finish() { return ending(this.#raw) }
}

/** Decrypts a stored file piece by piece. What `update` handed out counts only once `finish` succeeded. */
export class FileDecryptor {
  #raw
  constructor(file) { this.#raw = call(raw.RawFileDecryptor, 'create', [file]) }
  update(stored) { return call(this.#raw, 'update', [stored]) }
  finish() { return ending(this.#raw) }
}

/** `finish` of an encryptor or decryptor, which uses the object up: its memory in the module is freed with it. */
function ending(rawObject) {
  try {
    return call(rawObject, 'finish', [])
  } finally {
    if (!stopped) { try { rawObject.free() } catch { stopped = true } }
  }
}

// ---- everything without state -------------------------------------------------------------------------------------

const plain = name => (...args) => call(raw, name, args)

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
