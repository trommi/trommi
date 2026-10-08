// storage-memory.ts: the storage adapter in memory (tests, throwaway clients). Same interface as the others.
import type { RangeOptions, Storage, StoredDevice } from './types.ts'

export interface MemoryStorage extends Storage { _map: Map<string, unknown>; snapshot(opts?: { skip?: readonly string[] }): Promise<Map<string, any>> }

export function memoryStorage({ extractable_keys = true }: { extractable_keys?: boolean } = {}): MemoryStorage {
  const map = new Map<string, unknown>()
  let device: StoredDevice | null = null
  const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v))
  return {
    extractable_keys,
    _map: map,
    async get(key) { return clone(map.get(key)) },
    async set(key, value) { map.set(key, clone(value)) },
    async delete(key) { map.delete(key) },
    async setMany(entries) { for (const [k, v] of entries) v === undefined ? map.delete(k) : map.set(k, clone(v)) },
    async keys(prefix = '') { return [...map.keys()].filter(k => k.startsWith(prefix)).sort() },
    async range(prefix, opts = {}) { return rangeOf(map, prefix, opts).map(([k, v]) => [k, clone(v)]) },
    async snapshot({ skip = [] } = {}) { return new Map([...map].filter(([k]) => !skip.some(p => k.startsWith(p))).map(([k, v]) => [k, clone(v)])) },
    async saveDevice(d) { device = d },
    async loadDevice() { return device },
    async close() {},
  }
}

/** Shared by the in-memory adapters: ordered [key, value] pairs under a prefix, between after/before (exclusive). */
export function rangeOf<V>(map: Map<string, V>, prefix: string, { after, before, limit = Infinity, reverse = false }: RangeOptions = {}): [string, V][] {
  let keys = [...map.keys()].filter(k => k.startsWith(prefix) && (after === undefined || k > after) && (before === undefined || k < before)).sort()
  if (reverse) keys.reverse()
  if (keys.length > limit) keys = keys.slice(0, limit)
  return keys.map(k => [k, map.get(k)!])
}
