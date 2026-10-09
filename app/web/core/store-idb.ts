// store-idb.ts: the web app's storage. Three IndexedDB databases per `name`:
//
//   <name>          the device's state. NOT implemented here: it is the binding's IdbStore (core/wasm/js/idb-store.js),
//                   which gives what the core asks of a store (core/src/store.rs, spec/v2.md 13.2): one strict
//                   transaction per write, the revision compared inside it, and a Web Lock on the name held from
//                   `load()` until `close()`, so one tab or worker owns a stored state at a time.
//   <name>:wrap     one record: the key the device's entries are wrapped under (below). Never deleted.
//   <name>:cache    the app's own records under string keys (model cache, timeline pages, settings, the receipts
//                   of forwarded calls): not the device's state, safe to lose, no lock.
//
// `openDeviceStore` returns the binding's store with two things added:
//
// 1. Wrapping at rest. The core's state holds private keys as plain bytes, so every entry's value is stored as
//    AES-256-GCM ciphertext: a fresh random 12-byte nonce per value, the entry's key as additional data (a value
//    cannot be moved under another key), under a NON-extractable WebCrypto key that is generated once, when the
//    state is still empty, and kept in <name>:wrap. Values are encrypted in `apply` before the binding's
//    transaction starts and decrypted in `load`.
//    Honestly, what that is worth: little. It keeps the private keys out of anything that reads the database's
//    values as data without this origin's WebCrypto (a storage inspector, an export, a bug that leaks a stored
//    value), and no script can read the wrapping key's bytes. It does NOT protect against a copy of the browser
//    profile (the browser writes the key's material into the same profile, unprotected), and not against script
//    running in the origin (XSS, a hostile extension): such a script cannot export the key, but it can open both
//    databases and ask the key to decrypt every entry. It is no rollback protection: an old copy of both databases
//    opens as well as the newest. And it adds one way to lose a device: entries without their key do not open.
//    So a key is only ever made while the state is empty, a key that is there is never replaced, and
//    `deleteStores` leaves the key where it is (it wraps nothing then, and the next device of this name uses it):
//    deleting it could take the key from under a device another tab creates in the same moment.
// 2. `load()` may be called twice and gives the same state: once by the app, which has to look before it decides
//    (is anything stored? does another tab own it: StoreConflict), and once by `Device.open(store)`.
//
// Values may be private keys: nothing here logs a value or puts one into an error.
import type { IdbStore } from '../../../core/wasm/js/idb-store.js'
import type { Store, StoredState, StoreEntry, StoreWrite } from './core-api.ts'

/** The binding's store class. A parameter, because only core-wasm.ts loads the binding's modules. */
export type IdbStoreClass = typeof IdbStore

export interface DeviceStore extends Store {
  /** Takes the owner lock (rejects with the binding's StoreConflict when another tab holds it, or waits for it with
   *  `wait`), reads and unwraps everything. A second call gives the same state. */
  load(): Promise<StoredState>
  /** Closes the database and frees the lock, for good; resolves once the lock is free. A `load()` that still waits
   *  for the lock is given up and rejects. */
  close(): Promise<void>
}
export interface Cache {
  get(key: string): Promise<unknown>
  /** `durable`: resolved only once it is on disk (a strict transaction), for a record something else relies on. */
  set(key: string, value: unknown, opts?: { durable?: boolean }): Promise<void>
  /** `undefined` deletes; one transaction: all of the entries or none. */
  setMany(entries: [key: string, value: unknown | undefined][]): Promise<void>
  /** The records whose key starts with `prefix`, in key order; `after` and `before` are exclusive bounds. */
  range(prefix: string, opts?: { after?: string; before?: string; limit?: number; reverse?: boolean }): Promise<[string, unknown][]>
  delete(key: string): Promise<void>
  close(): void
}
export interface StorageError extends Error { code: 'storage-failed' }

const WRAP = 'wrap', WRAP_KEY = 'key'
const CACHE = 'records'
const FORM = 1                    // first byte of a wrapped value: this layout (form, 12-byte nonce, ciphertext and tag)
const NONCE = 12, TAG = 16
const wrapName = (name: string) => `${name}:wrap`
const cacheName = (name: string) => `${name}:cache`

type Bytes = Uint8Array<ArrayBuffer>
const fail = (message: string): StorageError => Object.assign(new Error(message), { code: 'storage-failed' as const })
/** A failure of the browser's store: its error's name (QuotaExceededError, AbortError, …), never a stored value. */
const failed = (what: string, error: unknown): StorageError => fail(`${what}: ${(error as { name?: string } | null)?.name ?? 'unknown error'}`)
const copy = (bytes: Uint8Array): Bytes => new Uint8Array(bytes)

const requested = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error) })
const completed = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error) })

/** A database of one object store. It closes itself when another connection wants to delete it. */
function openDatabase(name: string, store: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1)
    req.onupgradeneeded = () => { req.result.createObjectStore(store) }
    req.onsuccess = () => { const db = req.result; db.onversionchange = () => db.close(); resolve(db) }
    req.onerror = () => reject(failed('a database of the app did not open', req.error))
  })
}
function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(failed('a database of the app could not be deleted', req.error))
  })
}

/** The wrapping key of `name`: read, or, only while the state is `empty` and its store `open`, generated and stored
 *  if there is still none (never over a key that is there). */
async function wrapKeyOf(name: string, empty: boolean, open: () => boolean): Promise<CryptoKey> {
  const db = await openDatabase(wrapName(name), WRAP)
  try {
    const read = () => requested(db.transaction(WRAP).objectStore(WRAP).get(WRAP_KEY))
    let key: unknown = await read()
    if (key === undefined) {
      if (!empty) throw fail('the wrapping key of the device store is gone: the stored device cannot be opened')
      const fresh = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      const tx = db.transaction(WRAP, 'readwrite', { durability: 'strict' })
      const records = tx.objectStore(WRAP)
      const there = records.get(WRAP_KEY)
      there.onsuccess = () => { if (there.result === undefined && open()) records.put(fresh, WRAP_KEY) }
      await completed(tx).catch(e => { throw failed('the wrapping key could not be stored', e) })
      key = await read()   // what a later start will read: a browser that cannot keep the key fails here, not then
    }
    if (!(key instanceof CryptoKey) || key.extractable || key.algorithm.name !== 'AES-GCM') throw fail('this browser did not keep the wrapping key of the device store')
    return key
  } finally { db.close() }
}

async function wrap(wrapKey: CryptoKey, key: Uint8Array, value: Uint8Array): Promise<Bytes> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE))
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: copy(key) }, wrapKey, copy(value)))
  const out = new Uint8Array(1 + NONCE + sealed.length)
  out[0] = FORM; out.set(nonce, 1); out.set(sealed, 1 + NONCE)
  return out
}
async function unwrap(wrapKey: CryptoKey, key: Uint8Array, stored: unknown): Promise<Bytes> {
  if (!(stored instanceof Uint8Array) || stored.length < 1 + NONCE + TAG || stored[0] !== FORM) throw fail('a stored entry is not in the form of this store')
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: copy(stored.subarray(1, 1 + NONCE)), additionalData: copy(key) }, wrapKey, copy(stored.subarray(1 + NONCE))))
  } catch { throw fail('a stored entry did not open with the wrapping key') }
}

/**
 * The device store `name`: the binding's IdbStore, its values wrapped at rest. Nothing is opened and no lock is
 * taken before `load()`. With `wait`, `load()` waits until the tab that owns the state is gone.
 */
export function openDeviceStore({ name, wait = false, IdbStore }: { name: string; wait?: boolean; IdbStore: IdbStoreClass }): DeviceStore {
  const inner = new IdbStore(name, { wait })
  let wrapKey: CryptoKey | null = null
  let state: Promise<StoredState> | null = null
  let closed = false

  const shut = fail('the device store was closed')
  const read = async (): Promise<StoredState> => {
    const stored = await inner.load()   // the lock is held from here on (a load that fails has given it back)
    try {
      const key = await wrapKeyOf(name, stored.revision === 0 && stored.entries.length === 0, () => !closed)
      const entries = await Promise.all(stored.entries.map(async (e): Promise<StoreEntry> => ({ key: e.key, value: await unwrap(key, e.key, e.value) })))
      if (closed) throw shut
      wrapKey = key
      return { revision: stored.revision, entries }
    } catch (e) { await inner.close(); throw e }   // (what fails here, after the binding's load, gives the lock back too)
  }

  return {
    load(): Promise<StoredState> { return closed ? Promise.reject(shut) : state ??= read() },
    async apply(write: StoreWrite): Promise<void> {
      const key = wrapKey
      if (closed || !key) throw fail('the device store is not open')
      const put = await Promise.all(write.put.map(async (e): Promise<StoreEntry> => ({ key: e.key, value: await wrap(key, e.key, e.value) })))
      await inner.apply({ expectedRevision: write.expectedRevision, put, delete: write.delete })
    },
    async close(): Promise<void> {
      closed = true
      wrapKey = null
      await inner.close()
    },
  }
}

/** The app's own records of `name`. Any number of tabs may have it open. */
export async function openCache(name: string): Promise<Cache> {
  const db = await openDatabase(cacheName(name), CACHE)
  const store = (mode: IDBTransactionMode, durable = false): IDBObjectStore => {
    try { return db.transaction(CACHE, mode, durable ? { durability: 'strict' } : undefined).objectStore(CACHE) } catch (e) { throw failed('the cache is not open', e) }
  }
  /** One write transaction: everything `fill` puts, or, when a value cannot be stored, nothing. */
  const written = async (fill: (s: IDBObjectStore) => void, durable = false): Promise<void> => {
    const s = store('readwrite', durable)
    const done = completed(s.transaction)
    try { fill(s) } catch (e) { done.catch(() => {}); s.transaction.abort(); throw failed('a record cannot be stored in the cache', e) }
    await done.catch(e => { throw failed('the cache write did not complete', e) })
  }
  return {
    async get(key) { return requested(store('readonly').get(key)) },
    set(key, value, { durable = false } = {}) { return written(s => { s.put(value, key) }, durable) },
    delete(key) { return written(s => { s.delete(key) }) },
    setMany(entries) { return written(s => { for (const [key, value] of entries) { if (value === undefined) s.delete(key); else s.put(value, key) } }) },
    async range(prefix, { after, before, limit, reverse = false } = {}) {
      const range = IDBKeyRange.bound(after ?? prefix, before ?? prefix + '￿', after !== undefined, before !== undefined)
      const s = store('readonly')
      // Forwards: keys and values in two bulk reads of one transaction (a cursor costs one event per record).
      if (!reverse) {
        const [keys, values] = await Promise.all([requested(s.getAllKeys(range, limit)), requested(s.getAll(range, limit))])
        return keys.map((key, i): [string, unknown] => [key as string, values[i]])
      }
      const out: [string, unknown][] = []
      await new Promise<void>((resolve, reject) => {
        const req = s.openCursor(range, 'prev')
        req.onsuccess = () => {
          const cursor = req.result
          if (!cursor || (limit !== undefined && out.length >= limit)) return resolve()
          out.push([cursor.key as string, cursor.value]); cursor.continue()
        }
        req.onerror = () => reject(req.error)
      })
      return out
    },
    close(): void { db.close() },
  }
}

/**
 * Deletes what is stored under `name`: the device's state and the cache. Refused with the binding's StoreConflict
 * while a device has the state open, in any tab: close it first. Caches open on it close themselves. The wrapping
 * key stays (see the header): it wraps nothing any more and cannot be read.
 */
export async function deleteStores({ name, IdbStore }: { name: string; IdbStore: IdbStoreClass }): Promise<void> {
  await IdbStore.destroy(name)
  await deleteDatabase(cacheName(name))
}
