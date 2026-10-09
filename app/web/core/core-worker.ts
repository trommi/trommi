// core-worker.ts: the client core in a dedicated Web Worker, so the page's thread never verifies, decrypts, reduces or
// reads storage. The page talks to it through remote.ts (RemoteClient); the protocol is worker-protocol.ts.
//
// The worker opens the stored room as a page without a worker does (tabs.ts: one writing tab per device, the others follow;
// Web Locks and BroadcastChannel work in workers), runs it, and after every change posts the records the change names
// (mirror.ts patchOf). Calls come in by name and run on the client; what they return goes back (structured clone). Nothing here knows the app's views.
//
// The account screens run here too (account.ts, room.ts joinRoom): the slow key derivation and the crypto of founding
// or joining a room never hold the page up, and the room they make is this worker's from the start.
//
//   new Worker('/gen/vendor/core-worker.mjs', { type: 'module' })   (the app's build names the bundled one)
import { openRoomInTabs, adoptInTabs } from './tabs.ts'
import { joinRoom } from './room.ts'
// (account.ts, with the key derivation and the word list, is loaded only when an account screen asks: a stored room
// never needs it)
const accountModule = () => import('./account.ts')
import type { Client } from './client.ts'
import { idbStorage } from './storage-idb.ts'
import { patchOf, snapshotOf } from './mirror.ts'
import type { Change } from './types.ts'
import type { ToWorker, FromWorker, WireError } from './worker-protocol.ts'
import { CALLS, ACCOUNT_CALLS, ACCOUNT_OPENS } from './worker-protocol.ts'

type AnyClient = Record<string, any> & { model: any; on(event: string, fn: (x: any) => void): () => void }

const port = globalThis as unknown as { postMessage(m: FromWorker, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent<ToWorker>) => void) | null }
const post = (m: FromWorker, transfer: Transferable[] = []) => port.postMessage(m, transfer)

let client: AnyClient | null = null
let storageOpts: { name: string; prefix: string } = { name: 'trommi', prefix: 'room/' }
let clientName: string | null = null

/** An error as it travels: its message and every own field (code, status, …), so the page throws the same. */
function wireError(e: unknown): WireError {
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
    // the hub, for the account's routes (account.ts takes a client and asks client.hub)
    case 'hub.request': return c['hub'].request(...args)
    case 'hub.pushKey': return c['hub'].pushKey()
    // development and measuring hooks (e2e, perf tools)
    case 'refreshMembers': return c['serial'](() => c['_refreshMembers']())
    case 'revisions': return c['_revisions']
    case 'storage.close': { await c['storage']?.close?.(); return null }
    // the account's routes that take the signed-in client (account.ts: a new kit, a new password, …): the slow key
    // derivation (Argon2id) runs here, not in the page
    case 'account': {
      const name = args[0] as string
      if (!ACCOUNT_CALLS.includes(name)) throw Object.assign(new Error(`not an account call: ${name}`), { code: 'bad-argument' })
      return ((await accountModule()) as unknown as Record<string, (c: unknown, a: unknown) => unknown>)[name]!(c, args[1])
    }
    // the app's name for the hub (Trommi-Client), for a room core-start.ts opened before the app knew it
    case 'configure': { clientName = (args[0] as { client?: string } | undefined)?.client ?? null; if (c['hub']) c['hub'].client_name = clientName; return null }
  }
  if (!CALLS.includes(method)) throw Object.assign(new Error(`not a client call: ${method}`), { code: 'bad-argument' })
  const fn = c[method]
  if (typeof fn !== 'function') throw Object.assign(new Error(`this client has no ${method}`), { code: 'bad-argument' })
  return fn.apply(c, args)
}

/** A client made here (an account created, a login, a device joined): this tab writes its room (tabs.ts), the page gets the model. */
async function adopt(made: Client, id: number, value: unknown): Promise<void> {
  const c = await adoptInTabs(made, { makeStorage: () => idbStorage(storageOpts), client: clientName }) as unknown as AnyClient
  client = c
  attach(c)
  post({ t: 'opened', id, model: snapshotOf(c.model), extra: extra(), value })
}
let joining: { cancel(): void } | null = null

port.onmessage = async ({ data: m }) => {
  // The account screens: creating an account, logging in, a new password from the kit, joining with a link. The room
  // they make is opened here and stays here.
  if (m.t === 'account' || m.t === 'join') {
    try {
      storageOpts = m.storage
      clientName = m.client
      const opts = { ...m.args, storage: idbStorage(storageOpts), client: m.client }
      if (m.t === 'join') {
        const j = joinRoom(opts as Parameters<typeof joinRoom>[0])
        joining = j
        j.check_code.then(code => post({ t: 'event', event: 'join-code', data: code }), () => {})
        const made = await j.client
        joining = null
        await adopt(made, m.id, null)
      } else {
        if (!ACCOUNT_OPENS.includes(m.fn)) throw Object.assign(new Error(`not an account call: ${m.fn}`), { code: 'bad-argument' })
        const r = await ((await accountModule()) as unknown as Record<string, (o: unknown) => Promise<{ client: Client; kit?: unknown }>>)[m.fn]!(opts)
        await adopt(r.client, m.id, 'kit' in r ? { kit: r.kit ?? null } : null)
      }
    } catch (e) { joining = null; post({ t: 'opened', id: m.id, model: null, error: wireError(e), extra: extra() }) }
    return
  }
  if (m.t === 'call' && m.method === 'join.cancel') { joining?.cancel(); post({ t: 'result', id: m.id, ok: true, value: null }); return }
  if (m.t === 'open') {
    try {
      storageOpts = m.storage
      clientName = m.client
      const storage = idbStorage(storageOpts)
      const c = await openRoomInTabs({ storage, makeStorage: () => idbStorage(storageOpts), client: m.client }) as AnyClient | null
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
