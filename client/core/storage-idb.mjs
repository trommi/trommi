// storage-idb.mjs: the storage adapter for browsers. One IndexedDB database, one object store `kv` (string keys, values
// stored by structured clone). The device is stored with its non-extractable CryptoKeys (they never exist as bytes).
//
//   const storage = idbStorage({ name: 'trommi', prefix: 'room-1/' })
export function idbStorage({ name = 'trommi', prefix = '' } = {}) {
  let dbp = null
  const db = () => dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1)
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv') }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  const done = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error) })
  const txDone = tx => new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error) })
  // setMany(entries, { durable: true }) asks for strict durability: oncomplete then means on disk (Chrome's default
  // 'relaxed' does not). The client uses it for the outbox and its own chain head before it posts (R4 write-ahead).
  const store = async (mode, durable = false) => (await db()).transaction('kv', mode, durable ? { durability: 'strict' } : undefined).objectStore('kv')
  const P = k => prefix + k
  return {
    extractable_keys: false,
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
      return keys.map(k => k.slice(prefix.length))
    },
    async range(p, { after, before, limit = Infinity, reverse = false } = {}) {
      const s = await store('readonly')
      const lo = after !== undefined ? P(after) : P(p), hi = before !== undefined ? P(before) : P(p) + '￿'
      const range = IDBKeyRange.bound(lo, hi, after !== undefined, before !== undefined)
      const out = []
      await new Promise((resolve, reject) => {
        const req = s.openCursor(range, reverse ? 'prev' : 'next')
        req.onsuccess = () => {
          const c = req.result
          if (!c || out.length >= limit) return resolve()
          out.push([c.key.slice(prefix.length), c.value]); c.continue()
        }
        req.onerror = () => reject(req.error)
      })
      return out
    },
    async saveDevice(device) { await this.set('device', device) },
    async loadDevice() { return (await this.get('device')) ?? null },
    async close() { if (dbp) (await dbp).close(); dbp = null },
  }
}
