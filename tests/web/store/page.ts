// page.ts: the test page of the web app's storage (store-idb.ts) and of one owner per profile (tabs.ts), bundled by
// run.mjs and loaded into headless Chromium. What needs one page only runs here in one go (`T.single()`); what needs
// several tabs, a quota or a reload is cut into steps that run.mjs calls over the DevTools protocol.
//
// Real here: IndexedDB, Web Locks, BroadcastChannel and WebCrypto of the browser; the binding's IdbStore; and, in the
// tests named "core:", the Rust core's Device from the WASM build run.mjs serves under /pkg/. NOT real: the client.
// The tabs run the fakes of fake-client.ts; there is no engine and no hub.
import { deleteStores, openCache, openDeviceStore } from '../../../app/web/core/store-idb.ts'
import type { Cache, DeviceStore, IdbStoreClass } from '../../../app/web/core/store-idb.ts'
import { adoptInTabs, callKey, forgetCalls, openRoomInTabs } from '../../../app/web/core/tabs.ts'
import type { CallReceipt, ClientLike, TabClient } from '../../../app/web/core/tabs.ts'
import type { StoredState, StoreEntry, StoreWrite } from '../../../app/web/core/core-api.ts'
import type * as Binding from '../../../core/wasm/js/trommi-core.js'
import { hex, keyOf, openFake, openReal } from './fake-client.ts'
import type { FakeClient } from './fake-client.ts'

/** ok: null is a test that could not run, with the reason in `detail`. */
interface Result { name: string; ok: boolean | null; detail: string }
class Skip extends Error {}

// The binding as run.mjs serves it (never bundled: the glue fetches its .wasm from beside itself).
const pkg = '/pkg/'
const core = await import(`${pkg}trommi-core.js`) as typeof Binding
const IdbStore = (await import(`${pkg}idb-store.js`) as { IdbStore: IdbStoreClass }).IdbStore
await core.init()
const recovery = core.versions().recovery
const canFound = !recovery.startsWith('not built')

const utf8 = new TextEncoder(), text = new TextDecoder()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const bytes = (...b: number[]) => new Uint8Array(b)
const put = (key: Uint8Array, value: Uint8Array | string): StoreEntry => ({ key, value: typeof value === 'string' ? utf8.encode(value) : value })
const write = (expectedRevision: number, puts: StoreEntry[], deletes: Uint8Array[] = []): StoreWrite => ({ expectedRevision, put: puts, delete: deletes })
/** What a store holds, as text: "key=value" sorted by key. */
const shown = (entries: StoreEntry[]) => entries.map(e => `${hex(e.key)}=${text.decode(e.value)}`).sort().join(' ')
let names = 0
const fresh = (what: string) => `t-${what}-${Date.now().toString(36)}-${names++}`

function check(cond: unknown, what: string): asserts cond { if (!cond) throw new Error(what) }
function same(got: unknown, want: unknown, what: string): void {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g !== w) throw new Error(`${what}: got ${g}, expected ${w}`)
}
/** The error a promise or a function ends with; fails when there is none. */
async function refused(run: () => unknown, what: string): Promise<{ code?: string; name?: string; message: string }> {
  try { await run() } catch (e) { return e as { code?: string; name?: string; message: string } }
  throw new Error(`${what}: was not refused`)
}
async function until(cond: () => unknown, what: string, ms = 8000): Promise<void> {
  const t = Date.now()
  while (!await cond()) { if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`); await sleep(20) }
}
const deviceStore = (name: string, wait = false) => openDeviceStore({ name, wait, IdbStore })
/** A loaded store. It waits for the lock: the binding frees it a moment AFTER close() returned, so a store opened
 *  right after another was closed must wait, or it meets the lock of the one that just went. */
async function opened(name: string): Promise<{ store: DeviceStore; revision: number; entries: StoreEntry[] }> {
  const store = deviceStore(name, true)
  return { store, ...await store.load() }
}
/** A database read or changed with plain IndexedDB: not through store-idb.ts, not through the binding, and without the lock. */
function plain<T>(name: string, stores: string[], mode: IDBTransactionMode, run: (tx: IDBTransaction) => T): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(stores, mode)
      const out = run(tx)
      tx.oncomplete = () => { db.close(); resolve(out) }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  })
}
async function raw(name: string, store: string): Promise<{ keys: IDBValidKey[]; values: unknown[] }> {
  const [keys, values] = await plain(name, [store], 'readonly', tx => [tx.objectStore(store).getAllKeys(), tx.objectStore(store).getAll()] as const)
  return { keys: keys.result, values: values.result }
}
const contains = (hay: Uint8Array, needle: Uint8Array): boolean => {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) { for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer; return true }
  return false
}
const lockHeld = async (name: string) => (await navigator.locks.query()).held?.some(l => l.name === `trommi-core:${name}`) ?? false
const freed = (name: string) => until(async () => !await lockHeld(name), 'the lock to be free')
const databases = async (name: string) => (await indexedDB.databases()).map(d => d.name).filter(n => n?.startsWith(name)).sort()

/** The options of a tab over the fake client. `Channel: null` is a browser without BroadcastChannel. */
function fakeTab(name: string, more: { cache?: Cache; Channel?: typeof BroadcastChannel | null; count?: { opens: number } } = {}) {
  return {
    name,
    store: (wait: boolean) => deviceStore(name, wait),
    open: async (store: DeviceStore, stored: StoredState): Promise<ClientLike | null> => { if (more.count) more.count.opens++; return openFake(name, store, stored, { create: true }) },
    ...(more.cache ? { cache: more.cache } : {}),
    ...(more.Channel !== undefined ? { Channel: more.Channel } : {}),
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// One page

const tests: [string, () => Promise<void>][] = [
  ['store: an empty store loads as revision 0 with no entries; load() twice gives the same state; the lock is held from load() to close()', async () => {
    const name = fresh('empty')
    const store = deviceStore(name)
    same(await lockHeld(name), false, 'the lock before load()')
    const state = await store.load()
    same([state.revision, state.entries.length, await lockHeld(name)], [0, 0, true], 'empty store')
    check(await store.load() === state, 'a second load() read again')
    const other = deviceStore(name)
    same((await refused(() => other.load(), 'a second owner')).name, 'StoreConflict', 'the second owner')
    store.close()
    await freed(name)
    const again = await opened(name)
    again.store.close()
  }],
  ['store: writes are applied in order and are there after reopening', async () => {
    const name = fresh('order')
    const a = await opened(name)
    await a.store.apply(write(0, [put(bytes(1, 1), 'one'), put(bytes(1, 2), 'two')]))
    await a.store.apply(write(1, [put(bytes(1, 1), 'ONE'), put(bytes(2), 'three')], [bytes(1, 2)]))
    // deletes come first: a key both deleted and put ends up put; of two puts of one key the later counts
    await a.store.apply(write(2, [put(bytes(9), 'early'), put(bytes(9), 'late'), put(bytes(2), 'again')], [bytes(2), bytes(7, 7)]))
    a.store.close()
    const b = await opened(name)
    same([b.revision, shown(b.entries)], [3, '0101=ONE 02=again 09=late'], 'after reopen')
    // an empty value and an empty write are a value and a revision like any other
    await b.store.apply(write(3, [put(bytes(3), new Uint8Array(0))]))
    await b.store.apply(write(4, []))
    b.store.close()
    const c = await opened(name)
    same([c.revision, shown(c.entries)], [5, '0101=ONE 02=again 03= 09=late'], 'after the second reopen')
    c.store.close()
  }],
  ['store: a write that names the wrong revision is refused with StoreConflict and nothing of it is stored', async () => {
    const name = fresh('conflict')
    const a = await opened(name)
    same((await refused(() => a.store.apply(write(5, [put(bytes(1), 'no')])), 'expected 5 at revision 0')).name, 'StoreConflict', 'refusal')
    await a.store.apply(write(0, [put(bytes(1), 'yes')]))
    same((await refused(() => a.store.apply(write(0, [put(bytes(1), 'twice'), put(bytes(2), 'more')])), 'expected 0 at revision 1')).name, 'StoreConflict', 'second refusal')
    a.store.close()
    const b = await opened(name)
    same([b.revision, shown(b.entries)], [1, '01=yes'], 'stored')
    b.store.close()
    same((await refused(() => deviceStore(fresh('unloaded')).apply(write(0, [])), 'a write before load()')).code, 'storage-failed', 'before load')
  }],
  ['store: another owner wrote behind this one\'s back (past the lock): the next write is refused whole', async () => {
    const name = fresh('behind')
    const a = await opened(name)
    await a.store.apply(write(0, [put(bytes(1), 'mine')]))
    // what a second owner would do if the lock had failed: one more write, the revision counted up
    await plain(name, ['meta'], 'readwrite', tx => { tx.objectStore('meta').put(2, 'revision') })
    same((await refused(() => a.store.apply(write(1, [put(bytes(1), 'overwritten'), put(bytes(2), 'new')])), 'the write behind another owner')).name, 'StoreConflict', 'refusal')
    a.store.close()
    const b = await opened(name)
    same([b.revision, shown(b.entries)], [2, '01=mine'], 'what is stored')
    b.store.close()
  }],
  ['store: values are wrapped at rest (no plaintext in IndexedDB), a fresh nonce per write, bound to their key, under a non-extractable key', async () => {
    const name = fresh('wrapped')
    const secret = crypto.getRandomValues(new Uint8Array(64))
    const a = await opened(name)
    await a.store.apply(write(0, [put(bytes(1), secret), put(bytes(2), secret), put(bytes(3), 'other')]))
    const once = (await raw(name, 'entries')).values as Uint8Array[]
    await a.store.apply(write(1, [put(bytes(1), secret)]))   // the same value under the same key again
    a.store.close()
    const device = await raw(name, 'entries')
    same(device.keys.map(k => hex(new Uint8Array(k as ArrayBuffer))), ['01', '02', '03'], 'the raw keys are the entries\' key bytes')
    const stored = device.values as Uint8Array[]
    for (const v of stored) check(v instanceof Uint8Array && !contains(v, secret.subarray(0, 16)) && !contains(v, utf8.encode('other')), 'a stored value shows its plaintext')
    same([stored[0]!.length, stored[0]![0]], [1 + 12 + 64 + 16, 1], 'form byte, nonce, ciphertext, tag')
    const nonces = [once[0]!, once[1]!, once[2]!, stored[0]!].map(v => hex(v.subarray(1, 13)))
    same(new Set(nonces).size, 4, `the nonces of four writes: ${nonces}`)
    const keys = await raw(`${name}:wrap`, 'wrap')
    const key = keys.values[0] as CryptoKey
    check(keys.values.length === 1 && key instanceof CryptoKey && key.extractable === false && key.algorithm.name === 'AES-GCM', 'the wrapping key is not a single non-extractable AES-GCM key')
    await refused(() => crypto.subtle.exportKey('raw', key), 'exporting the wrapping key')
    // the key is kept, not made again: a second store on the name reads what the first wrote
    const b = await opened(name)
    same(b.entries.map(e => hex(e.value)).sort(), [hex(secret), hex(secret), hex(utf8.encode('other'))].sort(), 'unwrapped on load')
    b.store.close()
    // a stored value moved under another key does not open (the key is the additional data)
    await plain(name, ['entries'], 'readwrite', tx => { tx.objectStore('entries').put(stored[0], new Uint8Array([3]).buffer) })
    await freed(name)
    const c = deviceStore(name)
    const e = await refused(() => c.load(), 'loading a moved value')
    same(e.code, 'storage-failed', 'a moved value')
    await freed(name)   // (the failed load gave the lock back)
    check(!e.message.includes(hex(secret).slice(0, 8)), 'the error shows stored bytes')
  }],
  ['store: entries whose wrapping key is gone do not open, and no new key is made over them', async () => {
    const name = fresh('keyless')
    const a = await opened(name)
    await a.store.apply(write(0, [put(bytes(1), 'sealed')]))
    a.store.close()
    await new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase(`${name}:wrap`); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error) })
    await freed(name)
    same((await refused(() => deviceStore(name).load(), 'loading without the key')).code, 'storage-failed', 'refusal')
    same((await raw(`${name}:wrap`, 'wrap')).values.length, 0, 'no key was made')
    await freed(name)
  }],
  ['store: close() while load() waits for the lock: that load() is refused and the lock is given back the moment it comes (the binding cannot leave the line)', async () => {
    const name = fresh('line')
    const a = await opened(name)
    const b = deviceStore(name, true)
    let outcome = 'waiting'
    const loading = b.load().then(() => { outcome = 'loaded' }, () => { outcome = 'refused' })
    await sleep(150)
    same(outcome, 'waiting', 'the second store while the first owns')
    b.close()
    a.store.close()
    await loading
    same(outcome, 'refused', 'after both closed')
    await freed(name)
    const c = deviceStore(name, true)
    same((await c.load()).revision, 0, 'a waiting load() with nobody in front')
    c.close()
  }],
  ['store: deleteStores removes the state and the cache, also under an open store; the wrapping key stays and serves the next device', async () => {
    const name = fresh('deleted')
    const a = await opened(name)
    await a.store.apply(write(0, [put(bytes(1), 'gone soon')]))
    const cache = await openCache(name)
    await cache.set('x', 1)
    same(await databases(name), [name, `${name}:cache`, `${name}:wrap`], 'before')
    await deleteStores({ name, IdbStore })
    same(await databases(name), [`${name}:wrap`], 'after')
    await refused(() => a.store.apply(write(1, [put(bytes(2), 'late')])), 'a write after the delete')
    same((await refused(() => cache.get('x'), 'the cache after the delete')).code, 'storage-failed', 'cache')
    a.store.close()
    const b = await opened(name)
    same([b.revision, b.entries.length], [0, 0], 'a new store on the name')
    await b.store.apply(write(0, [put(bytes(1), 'the next device')]))
    b.store.close()
    const c = await opened(name)
    same([shown(c.entries), (await raw(`${name}:wrap`, 'wrap')).values.length], ['01=the next device', 1], 'the next device, under the one key')
    c.store.close()
  }],
  ['cache: get, set, delete, setMany in one transaction, range by prefix with bounds, limit and reverse; no lock, two handles', async () => {
    const name = fresh('cache')
    const c = await openCache(name), second = await openCache(name)
    same(await c.get('nothing'), undefined, 'a missing key')
    await c.set('a/1', { n: 1, m: new Map([['k', new Uint8Array([1, 2])]]) })
    same(((await second.get('a/1')) as { m: Map<string, Uint8Array> }).m.get('k')!.length, 2, 'structured values, read through the other handle')
    await c.setMany([['a/2', 2], ['a/3', 3], ['a/4', 4], ['b/1', 'b'], ['a', 'bare'], ['a/1', undefined]])
    same(await c.range('a/'), [['a/2', 2], ['a/3', 3], ['a/4', 4]], 'prefix')
    same(await c.range('a/', { limit: 2 }), [['a/2', 2], ['a/3', 3]], 'limit')
    same(await c.range('a/', { reverse: true, limit: 2 }), [['a/4', 4], ['a/3', 3]], 'reverse')
    same(await c.range('a/', { after: 'a/2' }), [['a/3', 3], ['a/4', 4]], 'after')
    same(await c.range('a/', { before: 'a/4' }), [['a/2', 2], ['a/3', 3]], 'before')
    same(await c.range('a/', { after: 'a/2', before: 'a/4', reverse: true }), [['a/3', 3]], 'both, reverse')
    same((await c.range('')).map(([k]) => k), ['a', 'a/2', 'a/3', 'a/4', 'b/1'], 'everything')
    await c.delete('a/3')
    same((await c.range('a/')).map(([k]) => k), ['a/2', 'a/4'], 'after delete')
    // a value that cannot be stored: nothing of that setMany is written
    same((await refused(() => c.setMany([['a/9', 9], ['a/8', () => {}]]), 'a function as a value')).code, 'storage-failed', 'uncloneable')
    same([(await c.range('a/')).map(([k]) => k), await second.get('a/9')], [['a/2', 'a/4'], undefined], 'nothing of it')
    await c.set('a/5', 5, { durable: true })
    same(await second.get('a/5'), 5, 'a durable set')
    c.close(); second.close()
    same((await refused(() => c.get('a'), 'a closed cache')).code, 'storage-failed', 'closed')
  }],

  ['core: a real Device over the wrapped store: created, a room founded, closed, opened again from what is stored', async () => {
    const name = fresh('device')
    const device = await core.Device.create(deviceStore(name))
    const id = hex(await device.id())
    same([id.length, await device.room(), await lockHeld(name)], [64, null, true], 'a new device')
    same((await refused(() => core.Device.open(deviceStore(name)), 'a second Device on an owned store')).code, 'storage', 'the second owner')
    if (!canFound) { await device.close(); throw new Skip(`the core's build has no recovery construct (${recovery}): no room can be founded; build with TROMMI_STAND_IN_RECOVERY=1`) }
    const room = hex(await device.foundRoom(core.generateRecoveryCode(), Date.now()))
    const outbox = (await device.outbox()).map(e => `${e.id}:${e.kind}:${e.parts.map(p => p.length)}`)
    check(room.length === 64 && outbox.length > 0, `room ${room}, outbox ${outbox}`)
    await device.close()
    await freed(name)
    // nothing of it is stored in the clear, and the binding's own store cannot open it without the unwrapping
    const stored = (await raw(name, 'entries')).values as Uint8Array[]
    check(stored.length > 0 && stored.every(v => v[0] === 1 && v.length >= 29), 'the stored entries are not in the wrapped form')
    same((await refused(() => core.Device.open(new IdbStore(name)), 'opening the wrapped state unwrapped')).code, 'storage', 'unwrapped')
    const again = await core.Device.open(deviceStore(name, true))
    same([hex(await again.id()), hex((await again.room())!), (await again.outbox()).map(e => `${e.id}:${e.kind}:${e.parts.map(p => p.length)}`)], [id, room, outbox], 'the device after reopening')
    await again.close()
    same((await refused(() => core.Device.create(deviceStore(name, true)), 'creating over a stored device')).code, 'storage', 'create on a full store')
  }],
  ['core: another owner wrote behind a real Device: its next write fails, it closes itself and frees the lock; the stored state opens again without that write', async () => {
    const name = fresh('device-behind')
    if (!canFound) throw new Skip(`the core's build has no recovery construct (${recovery}): the Device has nothing to write after its creation`)
    const device = await core.Device.create(deviceStore(name))
    const id = hex(await device.id())
    const before = (await raw(name, 'meta')).values[0] as number
    await plain(name, ['meta'], 'readwrite', tx => { tx.objectStore('meta').put(before + 1, 'revision') })
    same((await refused(() => device.foundRoom(core.generateRecoveryCode(), Date.now()), 'the write behind another owner')).code, 'storage', 'the failed call')
    const later = await refused(() => device.id(), 'a call after the failure')
    check(later.code === 'storage' || later.code === 'internal', `a later call: ${later.code}`)
    await freed(name)   // (the device that closed itself gave the lock back)
    // recovery is the app's: a new store, the device from what is stored
    const again = await core.Device.open(deviceStore(name))
    same([hex(await again.id()), await again.room(), (await again.outbox()).length], [id, null, 0], 'the stored state: the device without the room')
    const room = await again.foundRoom(core.generateRecoveryCode(), Date.now())
    same(room.length, 32, 'and it goes on')
    await again.close()
  }],

  ['tabs: forgetCalls deletes only the receipts older than a day', async () => {
    const cache = await openCache(fresh('forget'))
    const old = `${(Date.now() - 3 * 86_400_000).toString(36).padStart(9, '0')}-aa`, recent = `${Date.now().toString(36).padStart(9, '0')}-bb`
    await cache.setMany([[callKey(old), { started: 1 }], [callKey(recent), { started: 2 }], ['other', 3]])
    await forgetCalls(cache)
    same((await cache.range('')).map(([k]) => k), [callKey(recent), 'other'], 'what stays')
    cache.close()
  }],
  ['tabs: nothing stored: openRoomInTabs gives null and leaves the lock free', async () => {
    const name = fresh('none')
    same(await openRoomInTabs({ name, store: wait => deviceStore(name, wait), open: async (store, stored) => openFake(name, store, stored) }), null, 'no device')
    await freed(name)
  }],
  ['tabs: two in one profile: one owner, the follower gets the snapshot, the patches and the events, and its calls run in the owner', async () => {
    const name = fresh('two')
    const count = { opens: 0 }
    const a = (await openRoomInTabs(fakeTab(name, { count })))!
    await a.call('seal', ['before'])
    const b = (await openRoomInTabs(fakeTab(name, { count })))!
    same([a.tabRole, b.tabRole, count.opens, b.client], ['leader', 'follower', 1, null], 'roles')
    check(b.model !== a.model, 'the follower holds the owner\'s own model object')
    same([b.model.stack, b.model.room.last_envelope_number, b.model.room.room_id], [['before'], 1, name], 'the snapshot')
    const changes: unknown[] = [], alerts: unknown[] = []
    b.on('change', (c: { stack: boolean; room: boolean }) => changes.push([c.stack, c.room, [...b.model.stack]]))
    b.on('alert', (x: unknown) => alerts.push(x))
    await a.call('poke', ['by the owner'])
    same(await b.call('seal', ['by the follower']), 'BY THE FOLLOWER', 'the forwarded call\'s answer')
    await a.call('alert', ['look'])
    await until(() => alerts.length === 1 && changes.length === 2, 'the patches at the follower')
    same(changes, [[true, true, ['before', 'by the owner']], [true, true, ['before', 'by the owner', 'by the follower']]], 'the follower\'s change events')
    same([alerts, b.model.room.last_envelope_number], [[{ what: 'look' }], 2], 'event and revision')
    same((a.client as FakeClient).ran, { seal: 2, poke: 1 }, 'what ran in the owner')
    // two calls at once keep their order and both their writes
    same(await Promise.all([b.call('seal', ['x']), b.call('seal', ['y'])]), ['X', 'Y'], 'two forwarded calls at once')
    // structured values travel both ways; a refusal arrives as the same error; a result that cannot travel is a refusal, once
    same(await b.call('echo', [{ bytes: new Uint8Array([1, 2, 3]), map: new Map([[1, 'x']]) }]).then((v: any) => [v.bytes.length, v.map.get(1)]), [3, 'x'], 'echo')
    const e = await refused(() => b.call('fail'), 'a refused call') as { code?: string; status?: number; message: string }
    same([e.code, e.status, e.message], ['fake-refusal', 418, 'the fake refuses'], 'the refusal')
    same((await refused(() => b.call('nothing-there'), 'an unknown call')).code, 'bad-argument', 'unknown call')
    same((await refused(() => b.call('uncloneable'), 'a result that cannot be cloned')).name, 'DataCloneError', 'uncloneable result')
    same((a.client as FakeClient).ran['uncloneable'], 1, 'it ran once')
    // a device being made while another tab owns the store is refused
    same((await refused(() => adoptInTabs({ name, store: wait => deviceStore(name, wait), make: async (store, stored) => openFake(name, store, stored, { create: true })! }), 'adopting an owned store')).code, 'owned-elsewhere', 'adopt')
    await b.close(); await a.close()
    const c = await opened(name)
    same(c.entries.map(e => text.decode(e.value)).sort(), ['before', 'by the follower', 'x', 'y'], 'stored, each once')
    c.store.close()
  }],
  ['tabs: a forwarded call that is sent again (no answer for 2.5 s) runs once and is answered once', async () => {
    const name = fresh('retry')
    const a = (await openRoomInTabs(fakeTab(name)))!, b = (await openRoomInTabs(fakeTab(name)))!
    let sent = 0
    const spy = new BroadcastChannel(`trommi-tabs:${name}`)
    spy.onmessage = ({ data }) => { if (data?.t === 'call') sent++ }
    let answers = 0
    const value = await b.call('slow', [3200]).then(v => { answers++; return v })
    await sleep(300)
    spy.close()
    check(sent >= 2, `the call was sent ${sent} time(s): the test did not exercise a retry`)
    same([value, (a.client as FakeClient).ran['slow'], answers], [1, 1, 1], 'ran once, answered once')
    await b.close(); await a.close()
  }],
  ['tabs: the owner leaves: the follower takes over from what is stored, announces a reset, and its waiting call runs', async () => {
    const name = fresh('leave')
    const a = (await openRoomInTabs(fakeTab(name)))!, b = (await openRoomInTabs(fakeTab(name)))!
    await b.call('seal', ['one'])
    await a.call('poke', ['not stored'])
    await until(() => b.model.stack.length === 2, 'the patch')
    let resets = 0
    b.on('reset', () => resets++)
    await b.call('start', [{ kept: true }])   // (a follower's start is kept for the takeover, not forwarded)
    const waiting = b.call('seal', ['two'])
    await a.close()                            // (closed before the call's message is delivered: the owner never saw it)
    same(await waiting, 'TWO', 'the call that waited through the change')
    check(b.tabRole === 'leader' && resets === 1 && b.client !== null, `role ${b.tabRole}, resets ${resets}`)
    same(b.model.stack, ['one', 'two'], 'the new owner\'s model: what is stored, and the call')
    await b.close()
    await freed(name)
  }],
  ['tabs: receipts: a call the old owner finished but whose answer was lost is answered from its receipt; one it only started is refused as outcome-unknown; neither runs twice', async () => {
    const name = fresh('receipts')
    const cache = await openCache(name)
    // an owner whose answers never arrive
    class Mute extends BroadcastChannel { override postMessage(m: { t?: string }) { if (m?.t !== 'result') super.postMessage(m) } }
    const a = (await openRoomInTabs(fakeTab(name, { cache, Channel: Mute })))!, b = (await openRoomInTabs(fakeTab(name, { cache })))!
    const finished = b.call('seal', ['finished']), started = b.call('sealAndHang', ['started'])
    started.catch(() => {})
    await until(async () => (await cache.range('call/')).filter(([, r]) => (r as CallReceipt).outcome).length === 1 && a.model.stack.length === 2, 'the owner ran both')
    same((await cache.range('call/')).map(([, r]) => (r as CallReceipt).outcome?.ok ?? null).sort(), [null, true], 'the receipts: one only started, one with its outcome')
    await a.close()
    same(await finished, 'FINISHED', 'answered from the receipt')
    same((await refused(() => started, 'the call that was only started')).code, 'outcome-unknown', 'the started call')
    same([b.tabRole, b.model.stack, (b.client as FakeClient).ran], ['leader', ['finished', 'started'], {}], 'the new owner: both stored once, nothing run again')
    await until(async () => (await cache.range('call/')).length === 0, 'the receipts to be dropped once answered')
    // a call id older than a day is refused, not run
    const spy = new BroadcastChannel(`trommi-tabs:${name}`)
    const outcome = new Promise<{ ok: boolean; error?: { code?: string } }>(resolve => { spy.onmessage = ({ data }) => { if (data?.t === 'result' && data.to === 'spy') resolve(data.outcome) } })
    spy.postMessage({ t: 'call', id: `${(Date.now() - 2 * 86_400_000).toString(36).padStart(9, '0')}-old`, from: 'spy', method: 'seal', args: ['too late'] })
    same([(await outcome).error?.code, b.model.stack.length], ['expired', 2], 'an expired call')
    spy.close()
    await b.close()
    cache.close()
  }],
  ['tabs: stop on the owner is leaving: it frees the lock, the follower takes over, and there are never two owners', async () => {
    const name = fresh('stop')
    const a = (await openRoomInTabs(fakeTab(name)))!, b = (await openRoomInTabs(fakeTab(name)))!
    await a.call('seal', ['kept'])
    await a.call('stop')
    same([a.tabRole, a.client, (await refused(() => a.call('seal', ['late']), 'a call after stop')).code], ['follower', null, 'closed'], 'the stopped tab')
    await until(() => b.tabRole === 'leader', 'the takeover')
    same(b.model.stack, ['kept'], 'the new owner\'s model')
    same(await b.call('seal', ['next']), 'NEXT', 'and it works')
    await b.close()
  }],
  ['tabs: close() while the client is still being opened gives the lock back', async () => {
    const name = fresh('opening')
    let reached = () => {}
    const atOpen = new Promise<void>(r => { reached = r })
    const a = (await openRoomInTabs(fakeTab(name)))!
    const b = (await openRoomInTabs({ ...fakeTab(name), open: async (store, stored) => { reached(); await sleep(1500); return openFake(name, store, stored, { create: true }) } }))!
    await a.close()        // b is granted the lock and starts to open its client, slowly
    await atOpen
    await b.close()
    await freed(name)      // (well before the slow open() returns)
    const c = (await openRoomInTabs(fakeTab(name)))!
    same(c.tabRole, 'leader', 'the next tab')
    await c.close()
  }],
  ['tabs: the client says its Device closed: the tab drops it and stands in line for the lock again', async () => {
    const name = fresh('lost')
    const a = (await openRoomInTabs(fakeTab(name)))!
    await a.call('seal', ['mine'])
    const first = a.client
    let resets = 0
    a.on('reset', () => resets++)
    await a.call('deviceClosed')
    same([a.tabRole, a.client, a.model.stack], ['follower', null, ['mine']], 'at once: no owner, the last model still shown')
    // (its client closed the store, so here the lock is free and this same tab is the next in line)
    await until(() => a.tabRole === 'leader' && a.client !== first && a.client !== null, 'leading again with a new client')
    same([resets, a.model.stack], [1, ['mine']], 'a reset, and the model from what is stored')
    same(await a.call('seal', ['on']), 'ON', 'and it works')
    await a.close()
  }],
  ['tabs: without BroadcastChannel: the first tab owns and works, a second is refused (owned-elsewhere), never a second owner', async () => {
    const name = fresh('alone')
    const count = { opens: 0 }
    const a = (await openRoomInTabs(fakeTab(name, { Channel: null, count })))!
    same([a.tabRole, await a.call('seal', ['alone'])], ['leader', 'ALONE'], 'the first tab')
    same([(await refused(() => openRoomInTabs(fakeTab(name, { Channel: null, count })), 'a second tab')).code, count.opens], ['owned-elsewhere', 1], 'the second tab')
    await a.close()
  }],
]

async function single(): Promise<Result[]> {
  const out: Result[] = []
  for (const [name, run] of tests) {
    let timer = 0
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('not finished after 30 s')), 30_000) as unknown as number })
    try { await Promise.race([run(), deadline]); out.push({ name, ok: true, detail: '' }) } catch (e) { out.push({ name, ok: e instanceof Skip ? null : false, detail: String((e as Error)?.message ?? e) }) } finally { clearTimeout(timer) }
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------------
// Steps run.mjs drives

let tab: TabClient | null = null
let store: DeviceStore | null = null
const seen = { resets: 0, changes: 0, errors: [] as string[] }
const calls = new Map<string, { done: boolean; value?: unknown; error?: string }>()

const steps = {
  single,
  recovery: () => recovery,
  /** When this document was loaded: another number after a reload. */
  born: () => performance.timeOrigin,

  // ---- real tabs
  /** kind 'fake': the fake client, with receipts in the cache if `receipts`; 'real': the real core's Device. */
  async tabOpen(name: string, kind: 'fake' | 'real', receipts: boolean) {
    const cache = receipts ? await openCache(name) : null
    tab = await openRoomInTabs({
      name,
      store: wait => deviceStore(name, wait),
      open: async (s, stored) => (kind === 'real' ? openReal(core, name, s, stored) : openFake(name, s, stored, { create: true })),
      ...(cache ? { cache } : {}),
    })
    tab!.on('reset', () => seen.resets++)
    tab!.on('change', () => seen.changes++)
    tab!.on('error', (e: { code?: string }) => seen.errors.push(String(e?.code)))
    return tab!.tabRole
  },
  tabState() {
    const room = tab!.model.room
    return { role: tab!.tabRole, stack: tab!.model.stack, revision: room.last_envelope_number, room: room.room_id, device: room.my_device_id, ...seen, ran: (tab!.client as FakeClient | null)?.ran ?? null }
  },
  tabCall(method: string, args: unknown[]) { return tab!.call(method, args) },
  /** Starts a call and returns at once; `callState(key)` says how it ended. */
  callStart(key: string, method: string, args: unknown[]) {
    const state: { done: boolean; value?: unknown; error?: string } = { done: false }
    calls.set(key, state)
    tab!.call(method, args).then(v => { state.done = true; state.value = v }, e => { state.done = true; state.error = String(e?.code ?? e?.message) })
    return null
  },
  callState(key: string) { return calls.get(key) ?? null },

  // ---- a write that fails for a real reason: the origin's quota (run.mjs sets it before the first step)
  async quotaBefore(name: string) {
    const a = await opened(name)
    store = a.store
    await store.apply(write(0, [put(bytes(1), 'the last good state')]))
    return a.revision
  },
  async quotaWrite(megabytes: number) {
    const s = store!
    const big = new Uint8Array(megabytes * 1024 * 1024)
    for (let i = 0; i < big.length; i += 65536) crypto.getRandomValues(big.subarray(i, i + 65536))   // (does not compress)
    const e = await refused(() => s.apply(write(1, [put(bytes(2), big), put(bytes(1), 'overwritten')])), 'the write over quota')
    s.close()   // (what a Device does when its write failed)
    return { name: e.name, message: e.message }
  },
  async quotaAfter(name: string) {
    const b = await opened(name)   // recovery: a new store, loaded
    const state = { revision: b.revision, entries: shown(b.entries) }
    await b.store.apply(write(b.revision, [put(bytes(4), 'on again')]))
    b.store.close()
    const c = await opened(name)
    c.store.close()
    return { ...state, then: [c.revision, shown(c.entries)] }
  },

  // ---- a reload in the middle of a write
  async midWriteSetup(name: string) {
    const a = await opened(name)
    await a.store.apply(write(0, [put(bytes(0, 0, 0, 0), 'base')]))
    a.store.close()
    return null
  },
  /**
   * Starts a write of many entries and leaves the page before it is awaited to the end: `at` >= 0 leaves `at` ms
   * after the write was handed over; `at` < 0 leaves from INSIDE the write's transaction, when its (-at)-th entry was
   * put (seen by wrapping IDBObjectStore.put), so the transaction is open and half filled when the page goes.
   */
  async midWrite(name: string, at: number, entries: number, size: number) {
    const a = await opened(name)
    const value = crypto.getRandomValues(new Uint8Array(size))   // (size: at most 65536, the most getRandomValues gives)
    const puts: StoreEntry[] = [put(bytes(0, 0, 0, 0), 'replaced')]
    for (let i = 1; i <= entries; i++) puts.push(put(keyOf(i), value))
    if (at < 0) {
      const original = IDBObjectStore.prototype.put
      let n = 0
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
        const request = original.apply(this, args)
        if (this.name === 'entries' && ++n === -at) location.reload()
        return request
      }
    }
    void a.store.apply(write(a.revision, puts)).catch(() => {})
    if (at >= 0) setTimeout(() => location.reload(), at)
    return null
  },
  async midWriteCheck(name: string, entries: number, size: number) {
    const b = await opened(name)
    b.store.close()
    const base = b.entries.find(e => e.key.length === 4 && new DataView(e.key.buffer, e.key.byteOffset).getUint32(0) === 0)
    return { revision: b.revision, count: b.entries.length - 1, base: base ? text.decode(base.value) : null, sizesOk: b.entries.every(e => e === base || e.value.length === size), want: entries }
  },
  async drop(name: string) { await deleteStores({ name, IdbStore }); return null },
}
;(globalThis as unknown as { T: typeof steps }).T = steps
