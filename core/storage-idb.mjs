// storage-idb.mjs: the storage adapter for browsers. One IndexedDB database, one object store `kv` (string keys, values
// stored by structured clone). The device's private keys are stored wrapped (AES-GCM) by a non-extractable AES key that
// is stored beside them, and unwrapped as non-extractable CryptoKeys: WebKit (Safari on iPhone, iPad and Mac) stores an
// X25519 CryptoKey in IndexedDB without an error but reads it back as null, so a device kept as plain CryptoKeys was
// lost on the next start (the room was stored, its device was not: the app showed the start page and Log in said
// "signed in already"). saveDevice reads the device back and fails when it does not come back whole.
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
    /** Every key and value in ONE read transaction (a consistent picture while another tab writes), except under skip prefixes. */
    async snapshot({ skip = [] } = {}) {
      const s = await store('readonly')
      const out = new Map()
      await new Promise((resolve, reject) => {
        const req = s.openCursor(IDBKeyRange.bound(P(''), P('') + '\uffff'))
        req.onsuccess = () => {
          const c = req.result
          if (!c) return resolve()
          const k = c.key.slice(prefix.length)
          const sk = skip.find(p => k.startsWith(p))
          if (sk) return c.continue(P(sk) + '\uffff')
          out.set(k, c.value); c.continue()
        }
        req.onerror = () => reject(req.error)
      })
      return out
    },
    async saveDevice(device) {
      let record = device
      if (device.signKey?.extractable && device.kexKey?.extractable) {
        const subtle = globalThis.crypto.subtle
        const wrapKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey'])
        const wrap = async key => { const iv = globalThis.crypto.getRandomValues(new Uint8Array(12)); return { iv, data: new Uint8Array(await subtle.wrapKey('pkcs8', key, wrapKey, { name: 'AES-GCM', iv })) } }
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
      const d = await this.get('device')
      if (!d) return null
      if (d.wrapKey) {
        const subtle = globalThis.crypto.subtle
        const unwrap = (w, alg, usages) => subtle.unwrapKey('pkcs8', w.data, d.wrapKey, { name: 'AES-GCM', iv: w.iv }, { name: alg }, false, usages)
        return { id: d.id, signPub: d.signPub, kexPub: d.kexPub, signKey: await unwrap(d.signWrapped, 'Ed25519', ['sign']), kexKey: await unwrap(d.kexWrapped, 'X25519', ['deriveBits']) }
      }
      // A device stored as plain CryptoKeys (before the wrapping, or a browser without pkcs8 wrapping): whole or not at all.
      return d.signKey && d.kexKey ? d : null
    },
    async close() { if (dbp) (await dbp).close(); dbp = null },
  }
}
