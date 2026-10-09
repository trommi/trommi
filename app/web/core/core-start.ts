// core-start.ts: start the core worker as early as the page can. index.html loads this tiny module async, before its
// style sheets (an async module waits neither for the sheets nor for the entry's graph), so the worker's file is
// fetched beside the sheets and the entry, and the stored room read from IndexedDB while the page still loads. Run
// after the entry (it never is in practice, it is tiny), it starts nothing: the entry has taken the place
// (app.mjs sets globalThis.__trommiCore to null). What the worker
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
  // (a share page: `/a/<share id>`, base64url under protocol v2, hex in the links of before)
  return !/^\/a\/(?:[0-9a-f]{32}|[A-Za-z0-9_-]{22})$/.test(location.pathname)
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
    worker.postMessage({ t: 'open', id: 0, storage: { name: 'trommi' }, client: null })
    g.__trommiCore = early
  }
}
export {}
