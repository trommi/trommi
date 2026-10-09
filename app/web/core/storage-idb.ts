// storage-idb.ts: the storage adapter for browsers. One IndexedDB database, one object store `kv` (string keys, values
// stored by structured clone). The device's private keys are stored wrapped (AES-GCM) by a non-extractable AES key that
// is stored beside them, and unwrapped as non-extractable CryptoKeys: WebKit (Safari on iPhone, iPad and Mac) stores an
// X25519 CryptoKey in IndexedDB without an error but reads it back as null, so a device kept as plain CryptoKeys is
// lost on the next start (the room is stored, its device is not). saveDevice reads the device back and fails when it
// does not come back whole.
//
//   const storage = idbStorage({ name: 'trommi', prefix: 'room-1/' })
import type { Storage, StoredDevice } from './types.ts'

interface Wrapped { iv: Uint8Array<ArrayBuffer>; data: Uint8Array<ArrayBuffer> }
/** A device as IndexedDB keeps it: its private keys wrapped under a non-extractable AES key stored beside them. */
interface WrappedDevice { id: Uint8Array; signPub: Uint8Array; kexPub: Uint8Array; wrapKey: CryptoKey; signWrapped: Wrapped; kexWrapped: Wrapped }

export interface IdbStorage extends Storage { snapshot(opts?: { skip?: readonly string[] }): Promise<Map<string, any>> }

export function idbStorage({ name = 'trommi', prefix = '' }: { name?: string; prefix?: string } = {}): IdbStorage {
  let dbp: Promise<IDBDatabase> | null = null
  const db = () => dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name, 1)
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv') }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  const done = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error) })
  const txDone = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error) })
  // setMany(entries, { durable: true }) asks for strict durability: oncomplete then means on disk (Chrome's default
  // 'relaxed' does not). The client uses it for the outbox and its own chain head before it posts (R4 write-ahead).
  const store = async (mode: IDBTransactionMode, durable = false) => (await db()).transaction('kv', mode, durable ? { durability: 'strict' } : undefined).objectStore('kv')
  const P = (k: string) => prefix + k
  const unprefixed = (k: IDBValidKey) => (k as string).slice(prefix.length)
  return {
    extractable_keys: false,
    wraps_keys: true,   // give saveDevice extractable keys: it wraps them and hands back non-extractable ones
    async get(key) { return done((await store('readonly')).get(P(key))) },
    async set(key, value) { const s = await store('readwrite'); s.put(value, P(key)); await txDone(s.transaction) },
    async delete(key) { const s = await store('readwrite'); s.delete(P(key)); await txDone(s.transaction) },
    async setMany(entries, { durable = false } = {}) {
      const s = await store('readwrite', durable)
      for (const [k, v] of entries) v === undefined ? s.delete(P(k)) : s.put(v, P(k))
      await txDone(s.transaction)
    },
    async keys(p = '') {
      const s = await store('readonly')
      const keys = await done(s.getAllKeys(IDBKeyRange.bound(P(p), P(p) + '￿')))
      return keys.map(unprefixed)
    },
    async range(p, { after, before, limit = Infinity, reverse = false } = {}) {
      const s = await store('readonly')
      const lo = after !== undefined ? P(after) : P(p), hi = before !== undefined ? P(before) : P(p) + '￿'
      const range = IDBKeyRange.bound(lo, hi, after !== undefined, before !== undefined)
      // Forwards: keys and values in two bulk reads (a cursor costs one event per record).
      if (!reverse) {
        const n = Number.isFinite(limit) ? limit : undefined
        const [keys, values] = await Promise.all([done(s.getAllKeys(range, n)), done(s.getAll(range, n))])
        return keys.map((k, i): [string, unknown] => [unprefixed(k), values[i]])
      }
      const out: [string, unknown][] = []
      await new Promise<void>((resolve, reject) => {
        const req = s.openCursor(range, reverse ? 'prev' : 'next')
        req.onsuccess = () => {
          const c = req.result
          if (!c || out.length >= limit) return resolve()
          out.push([unprefixed(c.key), c.value]); c.continue()
        }
        req.onerror = () => reject(req.error)
      })
      return out
    },
    /** Every key and value in ONE read transaction (a consistent picture while another tab writes), except under skip
     *  prefixes. The key ranges between the skipped prefixes, each in two bulk reads (keys, values): a cursor costs
     *  one event per record. */
    async snapshot({ skip = [] } = {}) {
      const s = await store('readonly')
      const ranges: IDBKeyRange[] = []
      let lo = P(''), lowerOpen = false
      const end = P('') + '￿'
      for (const p of skip.filter(Boolean).sort()) {   // (an empty prefix skips nothing)
        const from = P(p), to = P(p) + '￿'
        if (from > lo) ranges.push(IDBKeyRange.bound(lo, from, lowerOpen, true))
        if (to > lo) { lo = to; lowerOpen = true }
      }
      if (end > lo) ranges.push(IDBKeyRange.bound(lo, end, lowerOpen))
      const parts = await Promise.all(ranges.map(r => Promise.all([done(s.getAllKeys(r)), done(s.getAll(r))])))
      const out = new Map<string, unknown>()
      for (const [keys, values] of parts) keys.forEach((k, i) => out.set(unprefixed(k), values[i]))
      return out
    },
    async saveDevice(device) {
      let record: StoredDevice | WrappedDevice = device
      if (device.signKey?.extractable && device.kexKey?.extractable) {
        const subtle = globalThis.crypto.subtle
        const wrapKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey'])
        const wrap = async (key: CryptoKey): Promise<Wrapped> => { const iv = globalThis.crypto.getRandomValues(new Uint8Array(12)); return { iv, data: new Uint8Array(await subtle.wrapKey('pkcs8', key, wrapKey, { name: 'AES-GCM', iv })) } }
        record = { id: device.id, signPub: device.signPub, kexPub: device.kexPub, wrapKey, signWrapped: await wrap(device.signKey), kexWrapped: await wrap(device.kexKey) }
      }
      await this.set('device', record)
      // Read back what a later start will read: a device this browser cannot keep must fail here, before it joins.
      const back = await this.loadDevice().catch(() => null)
      if (!back) {
        await this.delete('device').catch(() => {})
        throw Object.assign(new Error('this browser did not keep the device keys in its storage'), { code: 'device-not-stored' })
      }
      device.signKey = back.signKey; device.kexKey = back.kexKey   // from now on non-extractable
    },
    async loadDevice() {
      const d = await this.get('device') as (StoredDevice & Partial<WrappedDevice>) | undefined
      if (!d) return null
      if (d.wrapKey) {
        const wrapKey = d.wrapKey
        const subtle = globalThis.crypto.subtle
        const unwrap = (w: Wrapped, alg: string, usages: KeyUsage[]) => subtle.unwrapKey('pkcs8', w.data, wrapKey, { name: 'AES-GCM', iv: w.iv }, { name: alg }, false, usages)
        return { id: d.id, signPub: d.signPub, kexPub: d.kexPub, signKey: await unwrap(d.signWrapped!, 'Ed25519', ['sign']), kexKey: await unwrap(d.kexWrapped!, 'X25519', ['deriveBits']) }
      }
      // A device stored as plain CryptoKeys (before the wrapping, or a browser without pkcs8 wrapping): whole or not at all.
      return d.signKey && d.kexKey ? d : null
    },
    async close() { if (dbp) (await dbp).close(); dbp = null },
  }
}
