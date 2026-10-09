// Stores for the tests of the browser binding, with the core's contract: a store in memory (for Node, where there
// is no IndexedDB), and a wrapper that makes the next write of any store fail.
import { StoreConflict } from '../../core/wasm/pkg/trommi-core.js'

/** What survives a "restart" in a test: name -> { revision, entries (Map of hex key -> { key, value }), owned }. */
const disk = new Map()
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

/** A store in memory. One owner at a time, by a flag that stands for the lock of a real store. */
export class MemoryStore {
  #name
  #state = null
  constructor(name) { this.#name = name }

  async load() {
    const state = disk.get(this.#name) ?? { revision: 0, entries: new Map(), owned: false }
    if (state.owned) throw new StoreConflict('another owner has this state open')
    state.owned = true
    disk.set(this.#name, state)
    this.#state = state
    return { revision: state.revision, entries: [...state.entries.values()].map(({ key, value }) => ({ key: key.slice(), value: value.slice() })) }
  }

  async apply(write) {
    const state = this.#state
    if (state.revision !== write.expectedRevision) throw new StoreConflict()
    for (const key of write.delete) state.entries.delete(hex(key))
    for (const { key, value } of write.put) state.entries.set(hex(key), { key: key.slice(), value: value.slice() })
    state.revision += 1
  }

  close() {
    if (this.#state) this.#state.owned = false
    this.#state = null
  }
}

/** Any store, with a switch that makes its next write fail, writing nothing. */
export class FailingStore {
  #inner
  #failNext = false
  constructor(inner) { this.#inner = inner }
  failNextWrite() { this.#failNext = true }
  load() { return this.#inner.load() }
  async apply(write) {
    if (this.#failNext) { this.#failNext = false; throw new Error('the disk is full') }
    return this.#inner.apply(write)
  }
  close() { return this.#inner.close() }
}
