// A device's store on IndexedDB, with the contract the core asks of a store (core/swift/src/store.rs):
//
// - All or nothing: every write is ONE readwrite transaction. `apply` resolves when the transaction completed, and
//   rejects, with nothing written, when it aborted; any request in it that fails aborts it.
// - Durable on return: the transaction asks for durability "strict" (flushed to the disk before it completes),
//   and a browser that does not say it granted that is refused: nothing weaker is taken silently.
// - The revision: one number beside the entries. A write is made only if the stored number is the one it names
//   (compared inside the same transaction), and then makes it one more. Otherwise: StoreConflict.
// - One owner: a Web Lock on the state's name, taken before anything is read and held until close(). A second
//   tab or worker that opens the same state gets StoreConflict (or waits, with { wait: true }). The database
//   connection stays open as long, so nobody deletes or upgrades the state under a live device.
//
// One store object serves one device, once: after close() it stays closed.
//
// The values are private keys, stored as they are: IndexedDB of the app's origin protects them as it protects
// everything else the app stores. Types: idb-store.d.ts.
import { StoreConflict } from './trommi-core.js'

const ENTRIES = 'entries'   // key: the entry's key (bytes); value: the entry's value (bytes)
const META = 'meta'         // 'revision' -> how many writes were ever applied
const lockName = name => `trommi-core:${name}`

/** Resolves when the request succeeded, with its result. */
const done = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

/** Resolves when the transaction is committed; rejects when it aborted, with the first error in it. A failed
 *  request aborts its transaction (nothing here prevents that): no part of a write is ever committed alone. */
const committed = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve()
  transaction.onabort = () => reject(transaction.error ?? new Error('the transaction was aborted'))
})

/** Takes the Web Lock `name`; resolves with the function that releases it. */
function lock(name, wait) {
  if (!globalThis.navigator?.locks) return Promise.reject(new Error('Web Locks are not available: one owner cannot be ensured'))
  return new Promise((resolve, reject) => {
    navigator.locks.request(name, { mode: 'exclusive', ifAvailable: !wait }, held => {
      if (!held) { reject(new StoreConflict('another tab or worker has this state open')); return undefined }
      // The lock is held for as long as this promise is pending.
      return new Promise(release => resolve(release))
    }).catch(reject)
  })
}

export class IdbStore {
  #name
  #wait
  #state = 'new'    // 'new' → 'loading' → 'open' → 'closed'
  #db = null
  #release = null   // releases the Web Lock

  /** `name` names the stored state: the IndexedDB database and the lock. One per device. */
  constructor(name, { wait = false } = {}) {
    this.#name = name
    this.#wait = wait
  }

  async load() {
    if (this.#state !== 'new') throw new Error('this store was loaded before: a store object serves one device, once')
    this.#state = 'loading'
    try {
      this.#release = await lock(lockName(this.#name), this.#wait)
      if (this.#state !== 'loading') throw new Error('the store was closed while it loaded')
      const open = indexedDB.open(this.#name, 1)
      open.onupgradeneeded = () => {
        open.result.createObjectStore(ENTRIES)
        open.result.createObjectStore(META)
      }
      this.#db = await done(open)
      if (this.#state !== 'loading') throw new Error('the store was closed while it loaded')
      const transaction = this.#db.transaction([ENTRIES, META], 'readonly')
      const finished = committed(transaction)
      // One cursor gives each key with its value; two separate lists would have to be trusted to agree.
      const entries = []
      const cursor = transaction.objectStore(ENTRIES).openCursor()
      cursor.onsuccess = () => {
        const at = cursor.result
        if (!at) return
        entries.push({ key: new Uint8Array(at.key), value: at.value })
        at.continue()
      }
      const revision = transaction.objectStore(META).get('revision')
      await finished
      if (this.#state !== 'loading') throw new Error('the store was closed while it loaded')
      this.#state = 'open'
      return { revision: revision.result ?? 0, entries }
    } catch (error) {
      this.close()
      throw error
    }
  }

  async apply(write) {
    if (this.#state !== 'open') throw new Error('the store is closed')
    const transaction = this.#db.transaction([ENTRIES, META], 'readwrite', { durability: 'strict' })
    if (transaction.durability !== 'strict') {
      transaction.abort()
      throw new Error('the browser does not grant a strict transaction')
    }
    const finished = committed(transaction)
    const entries = transaction.objectStore(ENTRIES)
    const meta = transaction.objectStore(META)
    let conflict = false
    const stored = meta.get('revision')
    stored.onsuccess = () => {
      if ((stored.result ?? 0) !== write.expectedRevision) { conflict = true; transaction.abort(); return }
      for (const key of write.delete) entries.delete(exact(key))
      for (const { key, value } of write.put) entries.put(exact(value), exact(key))
      meta.put(write.expectedRevision + 1, 'revision')
    }
    try {
      await finished
    } catch (error) {
      throw conflict ? new StoreConflict() : error
    }
  }

  /** Closes the database and releases the lock, for good. */
  close() {
    this.#state = 'closed'
    this.#db?.close()
    this.#db = null
    this.#release?.()
    this.#release = null
  }

  /** Deletes a stored state for good: for a device that was removed, or a test. StoreConflict while a device has
   *  it open. */
  static async destroy(name) {
    const release = await lock(lockName(name), false)
    try {
      await done(indexedDB.deleteDatabase(name))
    } finally {
      release()
    }
  }
}

/** The bytes alone: a view of a larger buffer would be stored with all of that buffer. */
const exact = bytes => bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice()
