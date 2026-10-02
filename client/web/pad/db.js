// Where pad elements live. One element is one record, keyed by id, shaped exactly
// like the record the server will keep (see docs/pad.md). Today the records sit in
// IndexedDB; a server transport offers the same five calls, so swapping it in
// changes this file and nothing else.
//
//   const db = await openStore()
//   db.kind                         'indexeddb' | 'memory' (private window, file://)
//   await db.list(pad)              every record of the pad, tombstones included
//   await db.put(records)           upsert, one record per element
//   await db.putBlob({ id, type, blob })   image and audio bytes, by id
//   await db.getBlob(id)            { id, type, blob } or undefined
//   await db.meta(key[, value])     small per-device things: view, pen (never synced)
//
// Deleting is a put: the record shrinks to a tombstone { id, pad, deleted: true,
// updated, rev, author }, so that "deleted" can win against an older edit when
// two devices sync. Tombstones are filtered out by the pad, never by the store.

const NAME = 'trommi-pad'
const VERSION = 1

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      const elements = db.createObjectStore('elements', { keyPath: 'id' })
      elements.createIndex('pad', 'pad')
      db.createObjectStore('blobs', { keyPath: 'id' })
      db.createObjectStore('meta')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'))
  })
}

function indexedStore(idb) {
  const tx = (stores, mode, fn) => new Promise((resolve, reject) => {
    const t = idb.transaction(stores, mode)
    const out = fn(t)
    t.oncomplete = () => resolve(out?.result ?? out)
    t.onerror = t.onabort = () => reject(t.error)
  })
  return {
    kind: 'indexeddb',
    list: pad => tx('elements', 'readonly', t => t.objectStore('elements').index('pad').getAll(pad)),
    put: records => tx('elements', 'readwrite', t => { for (const r of records) t.objectStore('elements').put(r) }),
    putBlob: rec => tx('blobs', 'readwrite', t => { t.objectStore('blobs').put(rec) }),
    getBlob: id => tx('blobs', 'readonly', t => t.objectStore('blobs').get(id)),
    meta: (key, value) => value === undefined
      ? tx('meta', 'readonly', t => t.objectStore('meta').get(key))
      : tx('meta', 'readwrite', t => { t.objectStore('meta').put(value, key) }),
    /** Test hook: forget everything on this device. */
    wipe: () => tx(['elements', 'blobs', 'meta'], 'readwrite', t => { for (const s of ['elements', 'blobs', 'meta']) t.objectStore(s).clear() }),
  }
}

// Same calls, nothing kept: for a browser that refuses IndexedDB.
function memoryStore() {
  const elements = new Map(), blobs = new Map(), meta = new Map()
  return {
    kind: 'memory',
    list: async pad => [...elements.values()].filter(r => r.pad === pad),
    put: async records => { for (const r of records) elements.set(r.id, r) },
    putBlob: async rec => { blobs.set(rec.id, rec) },
    getBlob: async id => blobs.get(id),
    meta: async (key, value) => (value === undefined ? meta.get(key) : void meta.set(key, value)),
    wipe: async () => { elements.clear(); blobs.clear(); meta.clear() },
  }
}

export async function openStore() {
  try {
    return indexedStore(await open())
  } catch {
    return memoryStore()
  }
}
