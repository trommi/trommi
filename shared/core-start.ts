// core-start.ts: start the core worker as early as the page can. index.html loads this tiny module before the app's
// entry (both are module scripts, run in document order; this one does not wait for the entry's graph), so the worker's
// file is fetched and the stored room read from IndexedDB while the page still loads its own modules. What the worker
// says meanwhile is kept until the page takes it over (remote.ts openRemote({ early })): a Worker drops messages
// nobody listens to.
//
// Not for the demo (?mock=…, or the tab's demo switch), a share page (/a/<id>) or ?core=page (the room in the page).
// The worker's address: __TROMMI_CORE_WORKER__ (the deployed bundle, dev/build.mjs), else the dev server's.
declare const __TROMMI_CORE_WORKER__: string | undefined

/** The worker started here and what it said so far. */
export interface EarlyCore { worker: Worker; messages: MessageEvent[]; error: ErrorEvent | null }

const g = globalThis as typeof globalThis & { __trommiCore?: EarlyCore | null }

function wanted(): boolean {
  if (typeof Worker !== 'function' || typeof location === 'undefined') return false
  try {
    const q = new URLSearchParams(location.search)
    if (q.has('mock') ? q.get('mock') !== '0' : sessionStorage.getItem('trommi-mock')) return false
    if ((q.get('core') ?? sessionStorage.getItem('trommi-core')) === 'page') return false
  } catch {}
  return !/^\/a\/[0-9a-f]{32}$/.test(location.pathname)
}

if (g.__trommiCore === undefined) {
  g.__trommiCore = null
  if (wanted()) {
    const url = typeof __TROMMI_CORE_WORKER__ === 'string' ? __TROMMI_CORE_WORKER__ : '/gen/vendor/core-worker.mjs'
    const worker = new Worker(url, { type: 'module', name: 'trommi-core' })
    const early: EarlyCore = { worker, messages: [], error: null }
    worker.onmessage = e => { early.messages.push(e) }
    worker.onerror = e => { early.error = e }
    // The room is opened at once; the app's name for the hub (Trommi-Client) follows with remote.ts.
    worker.postMessage({ t: 'open', id: 0, storage: { name: 'trommi', prefix: 'room/' }, client: null })
    g.__trommiCore = early
  }
}
export {}
