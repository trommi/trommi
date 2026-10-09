// The round trip of core/tests/round_trip.rs in a browser, from a plain ES module: two devices in one page (or one
// worker). Returns what was measured; throws on the first thing that is not as it must be. The first part keeps
// state in memory (it proves the binding and the cryptography and times them alone); `stored()` then does the same
// with every operation's changes written to IndexedDB before its bytes are used, and the devices loaded from there.
import init, { Device, seal, open } from '/pkg/trommi_core_wasm.js'

const text = s => new TextEncoder().encode(s)
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
const must = (ok, what) => { if (!ok) throw new Error(`round trip: ${what}`) }
const refused = (fn, name) => { try { fn() } catch (e) { return e.name === name } return false }

/** A page's store: what takeChanges() hands over, kept as IndexedDB would keep it (here: a Map). */
function persist(map, device) {
  const changes = device.takeChanges()
  for (const key of changes.remove) map.delete(key.join())
  for (let i = 0; i < changes.put.length; i += 2) map.set(changes.put[i].join(), [changes.put[i], changes.put[i + 1]])
}

/** One device's IndexedDB: an object store of key → value, both bytes. */
function openDb(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1)
    req.onupgradeneeded = () => req.result.createObjectStore('state')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
/** Write what the device changed in ONE transaction; resolves when it is durable. */
function commit(db, device) {
  const changes = device.takeChanges()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('state', 'readwrite', { durability: 'strict' })
    const state = tx.objectStore('state')
    for (const key of changes.remove) state.delete(key)
    for (let i = 0; i < changes.put.length; i += 2) state.put(changes.put[i + 1], changes.put[i])
    tx.oncomplete = () => resolve()
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('the transaction was aborted'))
  })
}
/** Everything a database holds, as Device.load wants it: [key, value, key, value, ...]. */
function readAll(db) {
  return new Promise((resolve, reject) => {
    const state = db.transaction('state', 'readonly').objectStore('state')
    const keys = state.getAllKeys(), values = state.getAll()
    values.onsuccess = () => resolve(keys.result.flatMap((k, i) => [new Uint8Array(k), values.result[i]]))
    values.onerror = () => reject(values.error)
  })
}

/** The round trip with IndexedDB as the store: each operation is durable before its result is used. */
async function stored() {
  const GROUP = text('room-idb'), LABEL = 'trommi body key', NONE = new Uint8Array()
  const names = [`trommi-core-a-${crypto.randomUUID()}`, `trommi-core-b-${crypto.randomUUID()}`]
  let dbA = await openDb(names[0]), dbB = await openDb(names[1])
  const t = performance.now()
  let a = Device.create(text('device-a')); await commit(dbA, a)
  let b = Device.create(text('device-b')); await commit(dbB, b)
  a.foundGroup(GROUP); await commit(dbA, a)
  const keyPackage = b.keyPackage(); await commit(dbB, b)
  // Both "tabs" close and open again: the devices come from IndexedDB, B still holds its key package's secret.
  dbA.close(); dbB.close(); dbA = await openDb(names[0]); dbB = await openDb(names[1])
  a = Device.load(await readAll(dbA)); b = Device.load(await readAll(dbB))
  const added = a.addMember(GROUP, keyPackage); await commit(dbA, a)
  b.join(added.welcome); await commit(dbB, b)
  a = Device.load(await readAll(dbA)); b = Device.load(await readAll(dbB))
  const key = a.exportKey(GROUP, LABEL, NONE)
  must(same(key, b.exportKey(GROUP, LABEL, NONE)) && a.epoch(GROUP) === 1n, 'the same key from IndexedDB')
  const removal = a.removeMember(GROUP, b.signatureKey()); await commit(dbA, a)
  must(b.processCommit(GROUP, removal).removed, 'B removed'); await commit(dbB, b)
  b = Device.load(await readAll(dbB))
  must(refused(() => b.exportKey(GROUP, LABEL, NONE), 'Evicted'), 'removed, also after a reload')
  const ms = performance.now() - t
  const entries = (await readAll(dbA)).length / 2
  dbA.close(); dbB.close()
  for (const name of names) indexedDB.deleteDatabase(name)
  return { ms, entries }
}

export async function roundTrip() {
  // The three steps of loading, apart: the bytes, the compilation, the instance. (init(url) alone would stream.)
  const url = new URL('/pkg/trommi_core_wasm_bg.wasm', import.meta.url)
  const t0 = performance.now()
  const response = await fetch(url)
  const bytes = await response.arrayBuffer()
  const tFetch = performance.now()
  const module = await WebAssembly.compile(bytes)
  const tCompile = performance.now()
  await init({ module_or_path: module })
  const instantiate = performance.now() - t0
  const load = { fetch: tFetch - t0, compile: tCompile - tFetch, instance: performance.now() - tCompile, type: response.headers.get('content-type') }

  const GROUP = text('room-1'), LABEL = 'trommi body key', NONE = new Uint8Array()
  const t1 = performance.now()
  const a = Device.create(text('device-a'))
  const b = Device.create(text('device-b'))
  const identities = performance.now() - t1

  const t2 = performance.now()
  a.foundGroup(GROUP)
  const added = a.addMember(GROUP, b.keyPackage())
  must(same(b.join(added.welcome), GROUP), 'B joined the group')
  const keyA = a.exportKey(GROUP, LABEL, NONE), keyB = b.exportKey(GROUP, LABEL, NONE)
  const foundAddJoinExport = performance.now() - t2
  must(keyA.length === 32 && same(keyA, keyB), 'both export the same key')
  must(a.epoch(GROUP) === 1n && b.epoch(GROUP) === 1n, 'epoch 1')
  must(a.members(GROUP).length === 2 && same(a.members(GROUP)[1], b.signatureKey()), 'two members')

  const t3 = performance.now()
  const sealed = seal(keyA, text('header'), text('hello from A'))
  const opened = open(keyB, text('header'), sealed)
  const sealOpen = performance.now() - t3
  must(new TextDecoder().decode(opened) === 'hello from A', 'B opens what A sealed')
  must(refused(() => open(keyB, text('other'), sealed), 'Unsealed'), 'other associated data is refused')

  // The state survives: both devices again from what a page would have stored.
  const storeA = new Map(), storeB = new Map()
  persist(storeA, a); persist(storeB, b)
  const a2 = Device.load([...storeA.values()].flat()), b2 = Device.load([...storeB.values()].flat())
  must(same(a2.exportKey(GROUP, LABEL, NONE), keyA) && same(b2.exportKey(GROUP, LABEL, NONE), keyA), 'the key after a reload')

  const storedEntries = storeA.size, storedBytes = [...storeA.values()].reduce((n, [k, v]) => n + k.length + v.length, 0)

  // A removes B: a new epoch; B has no key any more.
  const t4 = performance.now()
  const commit = a2.removeMember(GROUP, b2.signatureKey())
  const keyA2 = a2.exportKey(GROUP, LABEL, NONE)
  const processed = b2.processCommit(GROUP, commit)
  const removeProcess = performance.now() - t4
  must(!same(keyA2, keyA) && a2.epoch(GROUP) === 2n, 'a new key in epoch 2')
  must(processed.removed === true, 'B knows it was removed')
  must(refused(() => b2.exportKey(GROUP, LABEL, NONE), 'Evicted'), 'B derives no key after its removal')
  must(refused(() => open(keyB, text('header'), seal(keyA2, text('header'), text('later'))), 'Unsealed'), 'the old key opens nothing new')

  // A megabyte sealed and opened: what a body of that size costs with AES in software.
  const big = new Uint8Array(1 << 20)
  const t5 = performance.now()
  const bigSealed = seal(keyA2, NONE, big)
  const megabyteSeal = performance.now() - t5
  const t6 = performance.now()
  open(keyA2, NONE, bigSealed)
  const megabyteOpen = performance.now() - t6

  // A room of sixteen devices, built one add at a time; every member follows each commit.
  const ROOM = text('room-16'), t7 = performance.now()
  const founder = Device.create(text('device-0'))
  founder.foundGroup(ROOM)
  const members = []
  for (let i = 1; i < 16; i++) {
    const next = Device.create(text(`device-${i}`))
    const step = founder.addMember(ROOM, next.keyPackage())
    for (const m of members) m.processCommit(ROOM, step.commit)
    next.join(step.welcome)
    members.push(next)
  }
  const sixteen = performance.now() - t7
  const roomKey = founder.exportKey(ROOM, LABEL, NONE)
  must(founder.epoch(ROOM) === 15n && members.every(m => same(m.exportKey(ROOM, LABEL, NONE), roomKey)), 'sixteen devices, one key')
  const t8 = performance.now()
  const last = founder.removeMember(ROOM, members[14].signatureKey())
  members[0].processCommit(ROOM, last)
  const sixteenRemove = performance.now() - t8
  must(same(members[0].exportKey(ROOM, LABEL, NONE), founder.exportKey(ROOM, LABEL, NONE)), 'the room after a removal')
  persist(storeA, founder)

  const idb = await stored()

  const r = x => Math.round(x * 10) / 10
  return {
    ok: true, instantiate: r(instantiate), fetch: r(load.fetch), compile: r(load.compile), instance: r(load.instance), contentType: load.type,
    indexedDb: r(idb.ms), indexedDbEntries: idb.entries, identities: r(identities), foundAddJoinExport: r(foundAddJoinExport),
    sealOpen: r(sealOpen), removeProcess: r(removeProcess), megabyteSeal: r(megabyteSeal), megabyteOpen: r(megabyteOpen), sixteen: r(sixteen), sixteenRemove: r(sixteenRemove),
    storedEntries, storedBytes, sixteenStoredBytes: [...storeA.values()].reduce((n, [k, v]) => n + k.length + v.length, 0) - storedBytes,
  }
}
