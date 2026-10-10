// The test page: the binding in the page itself and in module workers, under the web app's Content-Security-Policy.
// tests/bindings/browser.mjs loads it in headless Chromium and calls run(what).
import * as core from '/core/wasm/pkg/trommi-core.js'
import { StoreConflict } from '/core/wasm/pkg/trommi-core.js'
import { IdbStore } from '/core/wasm/pkg/idb-store.js'
import { runScenario } from '/tests/bindings/scenario.mjs'
import { accountVectors } from '/tests/bindings/vectors.mjs'

const violations = []
addEventListener('securitypolicyviolation', event => violations.push(`${event.violatedDirective} ${event.blockedURI}`))

/** A worker and a way to ask it. */
function worker() {
  const thread = new Worker('/tests/bindings/web/worker.mjs', { type: 'module' })
  const waiting = new Map()
  let next = 0
  thread.onmessage = ({ data: { id, result, error } }) => {
    const { resolve, reject } = waiting.get(id)
    waiting.delete(id)
    if (error) reject(Object.assign(new Error(error.message), { code: error.code }))
    else resolve(result)
  }
  thread.onerror = event => { for (const { reject } of waiting.values()) reject(new Error(event.message || 'the worker failed to start')) }
  return {
    ask: (ask, rest = {}) => new Promise((resolve, reject) => { waiting.set(++next, { resolve, reject }); thread.postMessage({ id: next, ask, ...rest }) }),
    stop: () => thread.terminate(),
  }
}

/** A device in a worker of its own, stored in IndexedDB under a name of this run. */
async function deviceInWorker(run, name, how, wait = false) {
  const own = worker()
  try {
    await own.ask('start', { name: `${run}-${name}`, how, wait })
  } catch (error) {
    own.stop()
    throw error
  }
  return {
    call: (method, ...args) => own.ask('call', { method, args }),
    close: async () => { await own.ask('close'); violations.push(...await own.ask('violations')); own.stop() },
    failNextWrite: () => own.ask('failNextWrite'),
    kill: () => own.stop(),
  }
}

const cases = {
  /** The self-test in the page, and the account's known answers. */
  async page() {
    accountVectors(core, await (await fetch('/spec/vectors/account.json')).json())
    const report = core.selfTest(Date.now())
    return { ok: report.ok, steps: report.steps, versions: report.versions }
  },

  /** The self-test in a module worker. */
  async worker() {
    const own = worker()
    try {
      const report = await own.ask('selfTest')
      violations.push(...await own.ask('violations'))
      return { ok: report.ok, steps: report.steps, versions: report.versions }
    } finally {
      own.stop()
    }
  },

  /** The scenario, every device in a worker of its own, with IndexedDB as the store. */
  async scenario() {
    const run = `scenario-${Date.now()}`
    const scenario = await (await fetch('/tests/bindings/scenario.json')).json()
    const ran = await runScenario(scenario, { core, device: (name, how) => deviceInWorker(run, name, how) })
    return { ok: ran === scenario.steps.length, ran }
  },

  /** A worker is killed between a write and its sending: the next one finds the same request in the outbox. And a
   *  second worker cannot open a state the first holds. */
  async kill() {
    const run = `kill-${Date.now()}`
    const first = await deviceInWorker(run, 'A', 'create')
    await first.call('foundRoom', core.generateRecoveryCode(), Date.now())
    const before = await first.call('outbox')
    let second = null
    try { await deviceInWorker(run, 'A', 'open') } catch (error) { second = error.code }
    first.kill()
    // The lock of a worker that was stopped is released by the browser; the next owner waits for it.
    const again = await deviceInWorker(run, 'A', 'open', true)
    const after = await again.call('outbox')
    await again.close()
    const sameBytes = (a, b) => a.length === b.length && a.every((byte, at) => byte === b[at])
    const same = before.length === 1 && after.length === 1 && after[0].id === before[0].id
      && after[0].parts.every((part, at) => sameBytes(part, before[0].parts[at]))
    return { ok: same && second === 'storage', same, second }
  },

  /** The IndexedDB store's own edge: close and open again at once, a wait given up, a load that fails with the
   *  lock in hand, another owner told apart from other failures, a lock taken away. */
  async store() {
    const name = `store-${Date.now()}`
    const held = async () => (await navigator.locks.query()).held.some(lock => lock.name === `trommi-core:${name}`)
    const outcome = async promise => { try { await promise; return 'resolved' } catch (error) { return error } }
    const found = {}

    // Closed, then opened again without waiting, many times: the lock is free when close() has resolved.
    found.reopen = true
    for (let round = 0; round < 25; round++) {
      const store = new IdbStore(name)
      if (await outcome(store.load()) !== 'resolved') found.reopen = false
      await store.close()
    }

    // Two closes at once both resolve only when the lock is free.
    const twice = new IdbStore(name)
    await twice.load()
    await Promise.all([twice.close(), twice.close()])
    found.closedTwice = !(await held())

    // A load that waits for the lock is given up by close(), and never takes the lock.
    const first = new IdbStore(name)
    await first.load()
    const waiting = new IdbStore(name, { wait: true })
    const pending = outcome(waiting.load())
    await waiting.close()
    found.givenUp = await pending !== 'resolved'
    await first.close()
    found.neverTaken = !(await held())

    // Another owner is a StoreConflict of its own, also through a device.
    const owner = new IdbStore(name)
    await owner.load()
    found.conflict = await outcome(new IdbStore(name).load()) instanceof StoreConflict
    const refused = await outcome(core.Device.open(new IdbStore(name)))
    found.cause = refused instanceof core.TrommiError && refused.code === 'storage' && refused.cause instanceof StoreConflict

    // A lock that is taken away: the next write is a conflict, and nothing is written.
    let giveBack
    const taken = new Promise(granted => {
      navigator.locks.request(`trommi-core:${name}`, { steal: true }, () => { granted(); return new Promise(free => { giveBack = free }) })
    })
    await taken
    // The browser tells the first holder after the thief's grant, in a task of its own: the mark is waited for, seen
    // through a write that names a revision no store has (it writes nothing either way), not by counting steps.
    // The message tells the mark from the revision check, which would refuse nothing in the write after it.
    const marked = async () => /took this state over/.test((await outcome(owner.apply({ expectedRevision: -1, put: [], delete: [] })))?.message ?? '')
    const deadline = Date.now() + 5000
    while (!(await marked()) && Date.now() < deadline) await new Promise(turn => setTimeout(turn, 0))
    const late = await outcome(owner.apply({ expectedRevision: 0, put: [], delete: [] }))
    found.stolen = late instanceof StoreConflict && /took this state over/.test(late.message)
    giveBack()
    await owner.close()

    // A write under way when the lock is taken away: refused with the mark and nothing of it stored, or committed
    // whole before the browser told the holder (it no longer takes a committing transaction back). Which of the two
    // happens is the browser's timing; that it is one of them is the check.
    const inflightName = `${name}-inflight`
    const writer = new IdbStore(inflightName)
    await writer.load()
    const key = new TextEncoder().encode('k')
    const put = Array.from({ length: 200 }, (_, at) => ({ key: new Uint8Array([at, at >> 8]), value: new Uint8Array(4096) }))
    const underWay = outcome(writer.applyAll([{ expectedRevision: 0, put, delete: [] }, { expectedRevision: 1, put: [{ key, value: key }], delete: [] }]))
    let freeThief
    await new Promise(granted => {
      navigator.locks.request(`trommi-core:${inflightName}`, { steal: true }, () => { granted(); return new Promise(free => { freeThief = free }) })
    })
    const inflight = await underWay
    freeThief()
    await writer.close()
    const reread = new IdbStore(inflightName)
    const stored = await reread.load()
    await reread.close()
    const inflightRefused = inflight instanceof StoreConflict && /took this state over/.test(inflight.message)
    found.inflight = inflightRefused ? stored.revision === 0 && stored.entries.length === 0
      : inflight === 'resolved' && stored.revision === 2 && stored.entries.length === 201

    // A load that fails after it took the lock gives the lock back: here the database is of a newer layout.
    const other = `${name}-newer`
    await new Promise((resolve, reject) => {
      const open = indexedDB.open(other, 2)
      open.onsuccess = () => { open.result.close(); resolve() }
      open.onerror = () => reject(open.error)
    })
    const failing = await outcome(new IdbStore(other).load())
    found.loadFailed = failing !== 'resolved' && !(failing instanceof StoreConflict)
    found.lockFreed = !(await navigator.locks.query()).held.some(lock => lock.name === `trommi-core:${other}`)

    return { ok: Object.values(found).every(Boolean), ...found, inflightRefused }
  },

  /**
   * Catching up on `count` stored envelopes, on IndexedDB: one by one (a durable transaction each), and through
   * `feed` in calls of 250 (a durable transaction per call). Both must leave the same device. The envelopes are a
   * device's own board items, sealed over a store in memory and then read by that device from two copies of its
   * stored state.
   */
  async catchup(count) {
    const name = `catchup-${Date.now()}`
    // A store in memory that can be copied: the writer's state before it read any of its envelopes.
    const memory = { revision: 0, entries: new Map() }
    const key = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
    const store = {
      load: async () => ({ revision: memory.revision, entries: [...memory.entries.values()] }),
      apply: async write => {
        for (const gone of write.delete) memory.entries.delete(key(gone))
        for (const entry of write.put) memory.entries.set(key(entry.key), { key: entry.key.slice(), value: entry.value.slice() })
        memory.revision += 1
      },
    }
    const writer = await core.Device.create(store)
    const room = await writer.foundRoom(core.generateRecoveryCode(), Date.now())
    for (const entry of await writer.outbox()) await writer.outboxAccepted(entry.id, 1)
    const board = Uint8Array.from([...new TextEncoder().encode('all-desks'), 0, 0, 0, 0, 0, 0, 9])
    const payload = new TextEncoder().encode(`{"content_type":"erase","shape_ids":["${core.base64urlEncode(await writer.id())}/1/0"]}`)
    const served = []
    for (let at = 0; at < count; at++) {
      const sealed = await writer.seal({ kind: 'boardItem', board, payload }, null, [], Date.now())
      const entry = (await writer.outbox()).find(entry => entry.id === sealed.outboxId)
      served.push({ bytes: entry.parts[0], change: at + 2, voidCode: null })
      await writer.outboxAccepted(entry.id, at + 2)
    }
    await writer.close()
    const copy = async to => {
      const target = new IdbStore(to)
      await target.load()
      await target.applyAll([{ expectedRevision: 0, put: [...memory.entries.values()], delete: [] }])
      await target.close()
    }
    await copy(`${name}-one`)
    await copy(`${name}-fed`)

    const one = await core.Device.open(new IdbStore(`${name}-one`))
    let start = performance.now()
    for (const envelope of served) {
      const received = await one.receiveEnvelope(envelope.bytes, envelope.change, true, null, Date.now())
      if (received.outcome !== 'applied') throw new Error(`one by one: ${received.outcome} ${received.code}`)
    }
    const oneByOne = Math.round(performance.now() - start)
    const headOne = await one.chainHead(core.roomGroupId(room), await one.id())
    await one.close()

    // Through feed: all but the last two in calls of 250, then [the next one, an item that is refused, the last].
    if (count < 3) throw new Error('catching up needs at least three envelopes')
    const group = core.roomGroupId(room)
    let fed = await core.Device.open(new IdbStore(`${name}-fed`))
    start = performance.now()
    const bulk = served.slice(0, -2)
    for (let at = 0; at < bulk.length; at += 250) {
      const answer = await fed.feed(bulk.slice(at, at + 250).map(envelope => ({ envelope })), Date.now())
      if (answer.refusedAt !== null || answer.outcomes.some(outcome => outcome.envelope?.outcome !== 'applied')) throw new Error(`feed: refused at ${answer.refusedAt} ${answer.code}`)
    }
    const inCalls = Math.round(performance.now() - start)
    // A feed stops at the first refusal: what came before it is applied and stored, what comes after is not touched.
    const malformed = { envelope: served.at(-1), entry: { change: 1, group: room, kind: 'commit', bytes: new Uint8Array(1) } }
    const stop = await fed.feed([{ envelope: served.at(-2) }, malformed, { envelope: served.at(-1) }], Date.now())
    const stopped = stop.refusedAt === 1 && stop.code === 'bad-format' && stop.outcomes.length === 1 && stop.outcomes[0].envelope?.outcome === 'applied'
    await fed.close()
    // Stored before the call answered: a device opened again holds the first, and not the third.
    fed = await core.Device.open(new IdbStore(`${name}-fed`))
    const prefix = (await fed.chainHead(group, await fed.id())).seq === count - 1
    const last = await fed.feed([{ envelope: served.at(-1) }], Date.now())
    const rest = last.refusedAt === null && last.outcomes[0]?.envelope?.outcome === 'applied'
    const headFed = await fed.chainHead(group, await fed.id())
    // What was read is handed again: a replay, and the head stays.
    const again = await fed.feed([{ envelope: served[0] }], Date.now())
    const replay = (again.refusedAt === null ? again.outcomes[0]?.envelope?.code : again.code) === 'replay'
      && (await fed.chainHead(group, await fed.id())).seq === count
    await fed.close()
    const same = headOne.seq === count && headFed.seq === count && headOne.hash.every((byte, at) => byte === headFed.hash[at])
    const ok = same && stopped && prefix && rest && replay
    return { ok, same, stopped, prefix, rest, replay, count, oneByOneMs: oneByOne, feedMs: inCalls, perItemOneMs: Math.round(oneByOne / count * 100) / 100, perItemFeedMs: Math.round(inCalls / bulk.length * 100) / 100 }
  },

  /** Times of the heavy calls, for the size and speed report. */
  async times() {
    const time = work => { const start = performance.now(); work(); return Math.round((performance.now() - start) * 10) / 10 }
    const megabyte = new Uint8Array(1 << 20)
    let end, stored
    const encrypt = time(() => { const encryptor = new core.FileEncryptor(); stored = [encryptor.update(megabyte)]; end = encryptor.finish(); stored.push(end.stored) })
    const decrypt = time(() => { const decryptor = new core.FileDecryptor(end.file); for (const piece of stored) decryptor.update(piece); decryptor.finish() })
    return { ok: true, encryptMiB: encrypt, decryptMiB: decrypt }
  },
}

globalThis.run = async (what, argument) => {
  // The .wasm is fetched here so that its type and the time to load it are seen.
  const start = performance.now()
  const response = await fetch('/core/wasm/pkg/trommi_core_wasm_bg.wasm')
  const contentType = response.headers.get('content-type')
  await core.init(response)
  const load = Math.round((performance.now() - start) * 10) / 10
  const result = await cases[what](argument)
  return { ...result, contentType, load, violations: [...violations] }
}
// So that a test can clean up what it stored.
globalThis.destroy = name => IdbStore.destroy(name)
