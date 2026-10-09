// A device's store on IndexedDB, with the contract the core asks of a store (core/swift/src/store.rs):
//
// - All or nothing, durable on return: every write is ONE readwrite transaction with durability "strict"; `apply`
//   resolves when the transaction completed, and rejects, with nothing written, when it aborted.
// - The revision: one number beside the entries. A write is made only if the stored number is the one it names
//   (compared inside the same transaction), and then makes it one more. Otherwise: StoreConflict.
// - One owner: a Web Lock on the database's name, taken before anything is read and held until close(). A second
//   tab or worker that opens the same state gets StoreConflict (or waits, with { wait: true }).
//
// The values are private keys, stored as they are: IndexedDB of the app's origin protects them as it protects
// everything else the app stores. Types: idb-store.d.ts.
import { StoreConflict } from './trommi-core.js'

const ENTRIES = 'entries'   // key: the entry's key (bytes); value: the entry's value (bytes)
const META = 'meta'         // 'revision' -> how many writes were ever applied

/** Resolves when the request succeeded, with its result. */
const done = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

/** Resolves when the transaction is committed and durable; rejects when it aborted. */
const committed = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve()
  transaction.onabort = () => reject(transaction.error ?? new Error('the transaction was aborted'))
  transaction.onerror = event => event.preventDefault()   // the abort that follows reports it
})

export class IdbStore {
  #name
  #wait
  #db = null
  #release = null   // releases the Web Lock

  /** `name` names the stored state: the IndexedDB database and the lock. One per device. */
  constructor(name, { wait = false } = {}) {
    this.#name = name
    this.#wait = wait
  }

  /** Takes the lock and holds it until `close`. */
  #lock() {
    if (!globalThis.navigator?.locks) throw new Error('Web Locks are not available: one owner cannot be ensured')
    return new Promise((resolve, reject) => {
      navigator.locks.request(`trommi-core:${this.#name}`, { mode: 'exclusive', ifAvailable: !this.#wait }, lock => {
        if (!lock) { reject(new StoreConflict('another tab or worker has this state open')); return undefined }
        resolve()
        // The lock is held for as long as this promise is pending.
        return new Promise(release => { this.#release = release })
      }).catch(reject)
    })
  }

  async load() {
    if (this.#db) throw new Error('the store was loaded before')
    await this.#lock()
    const open = indexedDB.open(this.#name, 1)
    open.onupgradeneeded = () => {
      open.result.createObjectStore(ENTRIES)
      open.result.createObjectStore(META)
    }
    this.#db = await done(open)
    // Another context that wants a newer layout must not wait on this one for ever.
    this.#db.onversionchange = () => this.close()
    const transaction = this.#db.transaction([ENTRIES, META], 'readonly')
    const keys = done(transaction.objectStore(ENTRIES).getAllKeys())
    const values = done(transaction.objectStore(ENTRIES).getAll())
    const revision = done(transaction.objectStore(META).get('revision'))
    await committed(transaction)
    const [k, v, r] = [await keys, await values, await revision]
    return { revision: r ?? 0, entries: k.map((key, at) => ({ key: new Uint8Array(key), value: v[at] })) }
  }

  async apply(write) {
    if (!this.#db) throw new Error('the store is closed')
    const transaction = this.#db.transaction([ENTRIES, META], 'readwrite', { durability: 'strict' })
    const finished = committed(transaction)
    const entries = transaction.objectStore(ENTRIES)
    const meta = transaction.objectStore(META)
    let conflict = false
    const stored = meta.get('revision')
    stored.onsuccess = () => {
      if ((stored.result ?? 0) !== write.expectedRevision) { conflict = true; transaction.abort(); return }
      for (const key of write.delete) entries.delete(key)
      for (const { key, value } of write.put) entries.put(value, key)
      meta.put(write.expectedRevision + 1, 'revision')
    }
    try {
      await finished
    } catch (error) {
      throw conflict ? new StoreConflict() : error
    }
  }

  /** Closes the database and releases the lock. */
  close() {
    this.#db?.close()
    this.#db = null
    this.#release?.()
    this.#release = null
  }

  /** Deletes a stored state for good: for a device that was removed, or a test. Nothing may have it open. */
  static async destroy(name) {
    await done(indexedDB.deleteDatabase(name))
  }
}
