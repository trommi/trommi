// probe.mjs: what the ENGINE gives of the things Trommi's core and app stand on, asked in the page and in a module
// worker alike. Nothing of Trommi runs here; every answer is the engine's own. Each question answers with its
// result or with `{ error }`: one missing piece does not hide the rest.
const attempt = async work => { try { return await work() } catch (error) { return { error: `${error?.name ?? 'Error'}: ${error?.message ?? error}` } } }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const within = (promise, ms, what) => Promise.race([promise, sleep(ms).then(() => { throw new Error(`no answer within ${ms} ms: ${what}`) })])
const done = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })

/** The smallest WebAssembly module: compiling it is what the policy's 'wasm-unsafe-eval' allows. */
const EMPTY_WASM = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])

/** IndexedDB: what `transaction.durability` says for each hint, and that a strict write completes and is read back. */
async function idb() {
  const name = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const open = indexedDB.open(name, 1)
  open.onupgradeneeded = () => open.result.createObjectStore('s')
  const db = await within(done(open), 10000, 'indexedDB.open')
  const durability = {}
  for (const hint of ['none', 'default', 'relaxed', 'strict']) {
    durability[hint] = await attempt(async () => {
      const tx = hint === 'none' ? db.transaction('s', 'readwrite') : db.transaction('s', 'readwrite', { durability: hint })
      const said = tx.durability
      const start = performance.now()
      tx.objectStore('s').put(new Uint8Array(1024), hint)
      await within(new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error ?? new Error('aborted')) }), 10000, `the ${hint} transaction`)
      return { said: said === undefined ? 'undefined' : said, ms: Math.round((performance.now() - start) * 10) / 10 }
    })
  }
  // Ten strict writes one after another, each its own transaction, as a device writes: what a write costs here.
  const series = await attempt(async () => {
    const times = []
    for (let i = 0; i < 10; i++) {
      const start = performance.now()
      const tx = db.transaction('s', 'readwrite', { durability: 'strict' })
      tx.objectStore('s').put(new Uint8Array(1024), `series-${i}`)
      await within(new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error ?? new Error('aborted')) }), 20000, 'a strict write')
      times.push(Math.round((performance.now() - start) * 10) / 10)
    }
    return times
  })
  const back = await attempt(async () => (await within(done(db.transaction('s').objectStore('s').get('strict')), 5000, 'reading back'))?.byteLength ?? null)
  // (bytes as a key, as idb-store.js stores its entries)
  const bytesKey = await attempt(async () => {
    const tx = db.transaction('s', 'readwrite', { durability: 'strict' })
    tx.objectStore('s').put(new Uint8Array([9]), new Uint8Array([1, 2, 3]))
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error) })
    const cursor = db.transaction('s').objectStore('s').openCursor(new Uint8Array([1, 2, 3]))
    const at = await done(cursor)
    return at ? `${Object.prototype.toString.call(at.key)} ${new Uint8Array(at.key).join()}` : null
  })
  db.close()
  const listed = await attempt(async () => typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).some(d => d.name === name) : 'no indexedDB.databases')
  await attempt(() => within(done(indexedDB.deleteDatabase(name)), 5000, 'deleteDatabase'))
  return { durability, strictSeries: series, readBack: back, bytesKey, listed }
}

/** Web Locks, as idb-store.js uses them: exclusive, `ifAvailable`, a wait given up by a signal, `steal`, `query`. */
async function locks() {
  if (!globalThis.navigator?.locks) return { has: false }
  const name = `probe-lock-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const out = { has: true }
  let free
  const request = navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, held => held ? new Promise(resolve => { free = resolve }) : undefined)
  const ended = request.then(() => 'resolved', error => `rejected ${error?.name}`)
  // The first holder's mark that its lock is gone, set exactly as idb-store.js sets `#lost`: the request's rejection
  // settles a promise, and a `then` of that promise sets the mark.
  // `direct` is the same mark set in the rejection's own handler, one promise step earlier.
  let lost = false, direct = false, settle
  new Promise(resolve => { settle = resolve }).then(() => { lost = true })
  request.then(() => {}, () => { direct = true; settle() })
  await sleep(50)
  out.taken = typeof free === 'function'
  out.query = await attempt(async () => (await navigator.locks.query()).held.some(lock => lock.name === name))
  out.secondRefused = await attempt(() => within(navigator.locks.request(name, { ifAvailable: true }, held => held === null), 5000, 'ifAvailable'))
  out.waitGivenUp = await attempt(async () => {
    const stop = new AbortController()
    const waiting = navigator.locks.request(name, { signal: stop.signal }, () => 'granted').then(() => 'granted', error => error?.name)
    await sleep(50)
    stop.abort()
    return within(waiting, 5000, 'the aborted wait')
  })
  // steal: the new holder is granted at once, and the old holder's request REJECTS (AbortError) while its callback's
  // promise is still pending: that rejection is how idb-store.js notices.
  let giveBack
  out.steal = await attempt(async () => {
    const taken = new Promise((granted, refused) => {
      navigator.locks.request(name, { steal: true }, () => { granted(); return new Promise(resolve => { giveBack = resolve }) }).catch(refused)
    })
    await taken
    // Here tests/bindings/web/page.mjs `store` writes with the first holder's store and expects a StoreConflict:
    // that holds only if the mark is set by now.
    out.markedWhenGranted = lost
    out.directWhenGranted = direct
    let waited = 'at once'
    for (let i = 1; i <= 20 && !lost; i++) { await null; waited = `${i} microtasks later` }
    for (let i = 1; i <= 50 && !lost; i++) { await new Promise(resolve => setTimeout(resolve, 0)); waited = `${i} tasks later` }
    out.markedAfterGrant = lost ? waited : 'not within 50 tasks'
    return true
  })
  out.stolenFrom = await attempt(() => within(ended, 5000, "the first holder's request after the steal"))
  giveBack?.()
  free?.()
  await sleep(50)
  out.freeAfter = await attempt(() => within(navigator.locks.request(name, { ifAvailable: true }, held => held !== null), 5000, 'ifAvailable after release'))
  return out
}

/** A stream of events read with fetch as app/web/core/hub.ts reads the hub's (same request options): do the events
 *  arrive one by one, and does aborting end it? */
async function stream(url) {
  const outer = new AbortController(), own = new AbortController()
  const signal = AbortSignal.any([outer.signal, own.signal])
  const start = performance.now()
  const res = await within(fetch(url, { headers: { accept: 'text/event-stream', authorization: 'Bearer probe' }, redirect: 'manual', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal }), 10000, 'the stream opening')
  const reader = res.body.getReader(), decoder = new TextDecoder()
  const at = []
  let text = ''
  while (at.length < 4) {
    const step = await within(reader.read(), 5000, 'the next event')
    if (step.done) break
    text += decoder.decode(step.value, { stream: true })
    at.push(Math.round(performance.now() - start))
  }
  own.abort()
  const after = await reader.read().then(step => step.done ? 'done' : 'more data', error => error?.name)
  return { status: res.status, type: res.headers.get('content-type'), reads: at, events: text.split('\n\n').filter(Boolean).length, header: /"auth":"Bearer probe"/.test(text), afterAbort: after }
}
/** The same stream with EventSource (which Trommi does not use: it cannot send the bearer token). */
function eventSource(url) {
  if (typeof EventSource !== 'function') return { has: false }
  return within(new Promise((resolve, reject) => {
    const source = new EventSource(url), start = performance.now(), at = []
    source.addEventListener('tick', () => { at.push(Math.round(performance.now() - start)); if (at.length === 3) { source.close(); resolve({ has: true, events: at }) } })
    source.onerror = () => { source.close(); reject(new Error('EventSource error')) }
  }), 10000, 'three events')
}

export async function probe({ origin = globalThis.location.origin } = {}) {
  const out = { where: typeof document === 'undefined' ? 'worker' : 'page', secure: globalThis.isSecureContext }
  // (how long each question took, in milliseconds: a slow engine shows here)
  out.took = {}
  const timed = async (name, work) => { const start = performance.now(); out[name] = await attempt(work); out.took[name] = Math.round(performance.now() - start) }
  await timed('wasm', async () => { await WebAssembly.instantiate(EMPTY_WASM); return true })
  await timed('wasmSync', async () => { new WebAssembly.Module(EMPTY_WASM); return true })
  await timed('idb', idb)
  await timed('locks', locks)
  await timed('stream', () => stream(`${origin}/v1/stream`))
  await timed('eventSource', () => eventSource(`${origin}/v1/stream`))
  out.storage = await attempt(async () => ({ persisted: await navigator.storage?.persisted?.() ?? 'no navigator.storage.persisted', quota: (await navigator.storage?.estimate?.())?.quota ?? null }))
  out.has = {
    BroadcastChannel: typeof BroadcastChannel === 'function',
    serviceWorker: !!globalThis.navigator?.serviceWorker,
    'AbortSignal.any': typeof AbortSignal.any === 'function',
    DecompressionStream: typeof DecompressionStream === 'function',
    structuredClone: typeof structuredClone === 'function',
    requestIdleCallback: typeof requestIdleCallback === 'function',
    'crypto.subtle': !!globalThis.crypto?.subtle,
    PublicKeyCredential: typeof PublicKeyCredential === 'function',
    PushManager: typeof PushManager === 'function',
    Notification: typeof Notification === 'function',
  }
  return out
}
