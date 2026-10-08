// core-worker.ts: the client core in a dedicated Web Worker, so the page's thread never verifies, decrypts, reduces or
// reads storage. The page talks to it through remote.ts (RemoteClient); the protocol is worker-protocol.ts.
//
// The worker opens the stored room as the page did before (tabs.ts: one writing tab per device, the others follow;
// Web Locks and BroadcastChannel work in workers), runs it, and after every change posts the records the change names
// (mirror.ts patchOf). Calls come in by name and run on the client; what they return goes back (structured clone). Nothing here knows the app's views.
//
//   new Worker('/gen/vendor/core-worker.mjs', { type: 'module' })   (the app's build names the bundled one)
import { openRoomInTabs } from './tabs.ts'
import { idbStorage } from './storage-idb.ts'
import { patchOf, snapshotOf } from './mirror.ts'
import type { Change } from './types.ts'
import type { ToWorker, FromWorker, WireError } from './worker-protocol.ts'
import { CALLS } from './worker-protocol.ts'

type AnyClient = Record<string, any> & { model: any; on(event: string, fn: (x: any) => void): () => void }

const port = globalThis as unknown as { postMessage(m: FromWorker, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent<ToWorker>) => void) | null }
const post = (m: FromWorker, transfer: Transferable[] = []) => port.postMessage(m, transfer)

let client: AnyClient | null = null
let storageOpts: { name: string; prefix: string } = { name: 'trommi', prefix: 'room/' }
let clientName: string | null = null

/** An error as it travels: its message and every own field (code, status, …), so the page throws the same. */
export function wireError(e: unknown): WireError {
  const err = (e ?? {}) as Record<string, unknown> & { message?: string; name?: string }
  const out: WireError = { name: String(err.name ?? 'Error'), message: String(err.message ?? e) }
  for (const [k, v] of Object.entries(err)) { try { structuredClone(v); out[k] = v } catch {} }
  return out
}

const extra = () => ({ stats: client?.['stats'] ?? null, tabRole: client?.['tabRole'] ?? null })

function attach(c: AnyClient): void {
  c.on('change', (change: Change) => post({ t: 'change', patch: patchOf(c.model, change, extra()) }))
  c.on('alert', (a: unknown) => post({ t: 'event', event: 'alert', data: a }))
  c.on('error', (e: unknown) => post({ t: 'event', event: 'error', data: wireError(e) }))
  // A new client behind the proxy (this tab became the writer): the page takes the whole model again.
  c.on('reset', () => { if (clientName && c['hub'] && !c['hub'].client_name) c['hub'].client_name = clientName; post({ t: 'snapshot', model: snapshotOf(c.model), extra: extra() }); post({ t: 'event', event: 'reset', data: null }) })
}

async function call(method: string, args: unknown[]): Promise<unknown> {
  const c = client
  if (!c) throw Object.assign(new Error('no room is open in the worker'), { code: 'no-room' })
  switch (method) {
    // the hub, for the account's routes (account.mjs takes a client and asks client.hub)
    case 'hub.request': return c['hub'].request(...args)
    case 'hub.pushKey': return c['hub'].pushKey()
    // development and measuring hooks (e2e, perf tools)
    case 'refreshMembers': return c['serial'](() => c['_refreshMembers']())
    case 'revisions': return c['_revisions']
    case 'storage.close': { await c['storage']?.close?.(); return null }
    // the app's name for the hub (Trommi-Client), for a room core-start.ts opened before the app knew it
    case 'configure': { clientName = (args[0] as { client?: string } | undefined)?.client ?? null; if (c['hub']) c['hub'].client_name = clientName; return null }
  }
  if (!CALLS.includes(method)) throw Object.assign(new Error(`not a client call: ${method}`), { code: 'bad-argument' })
  const fn = c[method]
  if (typeof fn !== 'function') throw Object.assign(new Error(`this client has no ${method}`), { code: 'bad-argument' })
  return fn.apply(c, args)
}

port.onmessage = async ({ data: m }) => {
  if (m.t === 'open') {
    try {
      storageOpts = m.storage
      clientName = m.client
      const storage = idbStorage(storageOpts)
      const open = openRoomInTabs as unknown as (o: Record<string, unknown>) => Promise<AnyClient | null>   // (tabs.ts: not typed yet)
      const c = await open({ storage, makeStorage: () => idbStorage(storageOpts), client: m.client })
      client = c
      if (c) attach(c)
      post({ t: 'opened', id: m.id, model: c ? snapshotOf(c.model) : null, extra: extra() })
    } catch (e) { post({ t: 'opened', id: m.id, model: null, error: wireError(e), extra: extra() }) }
    return
  }
  if (m.t === 'call') {
    try {
      const value = await call(m.method, m.args)
      post({ t: 'result', id: m.id, ok: true, value })   // (bytes are copied: the client may keep them, e.g. its attachment cache)
    } catch (e) { post({ t: 'result', id: m.id, ok: false, error: wireError(e) }) }
  }
}
post({ t: 'ready' })
