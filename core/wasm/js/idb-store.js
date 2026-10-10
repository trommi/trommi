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
//   connection stays open as long, so nobody deletes or upgrades the state under a live device. A lock that is
//   taken away (`steal`, which nothing of Trommi does) is noticed: the next write is a StoreConflict, which closes
//   the device. What the device reads from memory until then is not fenced; the revision is the check behind it.
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

/**
 * Takes the Web Lock `name`. Resolves with `release`, which gives the lock back and resolves once the browser has
 * let it go (the next owner can take it without waiting from then on), and `lost`, a promise that resolves if the
 * lock is taken away while it is held (another context asked for it with `steal`); `onLost` is called at that
 * moment, in the same step in which the browser reports it. With `signal`, a wait for the
 * lock can be given up.
 */
function lock(name, wait, signal, onLost = () => {}) {
  if (!globalThis.navigator?.locks) return Promise.reject(new Error('Web Locks are not available: one owner cannot be ensured'))
  return new Promise((resolve, reject) => {
    let release
    let stolen
    const lost = new Promise(settle => { stolen = settle })
    // `signal` and `ifAvailable` do not go together: only a request that waits can be given up.
    const options = wait ? { mode: 'exclusive', signal } : { mode: 'exclusive', ifAvailable: true }
    const request = navigator.locks.request(name, options, held => {
      if (!held) { reject(new StoreConflict('another tab or worker has this state open')); return undefined }
      // The lock is held for as long as this promise is pending.
      const holding = new Promise(free => { release = free })
      resolve({ release: () => { release(); return request.then(() => {}, () => {}) }, lost })
      return holding
    })
    // The request settles when the lock is gone: resolved after a release, rejected when it was stolen, or when it
    // was never granted (given up, or refused by the browser).
    // `onLost` runs in this very step: the holder is marked before anything else of the page runs.
    request.then(() => {}, error => { if (release) { onLost(); stolen() } else reject(error) })
  })
}

export class IdbStore {
  #name
  #wait
  #state = 'new'    // 'new' → 'loading' → 'open' → 'closed'
  #db = null
  #lock = null                    // the Web Lock, while it is held
  #waiting = new AbortController() // gives up a wait for the lock
  #lost = false                   // the lock was taken away
  #acquiring = null               // the request for the lock, while it is not yet answered
  #closing = null                 // the one closing, once it began

  /** `name` names the stored state: the IndexedDB database and the lock. One per device. */
  constructor(name, { wait = false } = {}) {
    this.#name = name
    this.#wait = wait
  }

  async load() {
    if (this.#state !== 'new') throw new Error('this store was loaded before: a store object serves one device, once')
    this.#state = 'loading'
    try {
      // A lock that is taken away ends this owner: nothing more is written.
      this.#acquiring = lock(lockName(this.#name), this.#wait, this.#waiting.signal, () => { this.#lost = true })
      this.#lock = await this.#acquiring
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
      await this.close()
      throw error
    }
  }

  apply(write) { return this.applyAll([write]) }

  /** Several writes, in order, in ONE transaction: all of them or none. Each names the revision the one before it
   *  left; the first must name the stored one. */
  async applyAll(writes) {
    if (this.#lost) throw new StoreConflict('another tab or worker took this state over')
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
      let revision = stored.result ?? 0
      for (const write of writes) {
        if (revision !== write.expectedRevision) { conflict = true; transaction.abort(); return }
        for (const key of write.delete) entries.delete(exact(key))
        for (const { key, value } of write.put) entries.put(exact(value), exact(key))
        revision += 1
      }
      meta.put(revision, 'revision')
    }
    try {
      await finished
    } catch (error) {
      throw conflict ? new StoreConflict() : error
    }
  }

  /**
   * Closes the database and releases the lock, for good. Resolves once the browser has let the lock go: a store
   * opened on the same state after that finds it free. A `load` that still waits for the lock is given up and
   * rejects; it never takes the lock.
   */
  close() {
    this.#closing ??= this.#end()
    return this.#closing
  }

  async #end() {
    this.#state = 'closed'
    this.#waiting.abort()
    this.#db?.close()
    this.#db = null
    // A request for the lock that was granted while this ran is released too: its answer is waited for.
    const held = this.#lock ?? await this.#acquiring?.catch(() => null)
    this.#lock = null
    await held?.release()
  }

  /** Deletes a stored state for good: for a device that was removed, or a test. StoreConflict while a device has
   *  it open. */
  static async destroy(name) {
    const held = await lock(lockName(name), false)
    try {
      await done(indexedDB.deleteDatabase(name))
    } finally {
      await held.release()
    }
  }
}

/** The bytes alone: a view of a larger buffer would be stored with all of that buffer. */
const exact = bytes => bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice()
