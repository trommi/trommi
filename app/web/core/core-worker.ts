// core-worker.ts: the client core in a dedicated Web Worker, so the page's thread never verifies, decrypts, reduces
// or reads storage. The page talks to it through remote.ts (RemoteClient); the protocol is worker-protocol.ts.
//
// The worker opens the stored device through tabs.ts: one tab's worker owns the device (the store's Web Lock), the
// others follow its model and forward their calls. After every change it posts the records the change names
// (mirror.ts patchOf). Calls come in by name and run on the owner's client; what they return goes back (structured
// clone). Nothing here knows the app's views.
//
// The account screens run here too (account.ts, room.ts joinRoom): the slow key derivation and the making of a room
// never hold the page up, and the room they make is this worker's from the start (tabs.ts adoptInTabs: the store's
// lock is held before the device is made).
//
// The core is loaded through core-wasm.ts only. A device that closed itself (a failed write, another owner) is
// tabs.ts's to open again: the client says `device-closed`, this tab stands in line for the lock.
//
//   new Worker('/gen/vendor/core-worker.mjs', { type: 'module' })   (the app's build names the bundled one)
import { closeAllStreams } from './hub.ts'
import type { Client } from './client.ts'
import { IdbStore } from './core-wasm.ts'
import type { Store } from './core-api.ts'
import { b64u } from './ids.ts'
import { patchOf, snapshotOf } from './mirror.ts'
import { joinRoom, openRoomOver } from './room.ts'
import { openCache, openDeviceStore } from './store-idb.ts'
import type { Cache } from './store-idb.ts'
import { adoptInTabs, openRoomInTabs } from './tabs.ts'
import type { ClientLike, TabClient } from './tabs.ts'
import type { Change } from './types.ts'
import type { FromWorker, StorageName, ToWorker, WireError } from './worker-protocol.ts'
import { ACCOUNT_CALLS, ACCOUNT_OPENS, CALLS, HOST_CALLS } from './worker-protocol.ts'

// (account.ts, with the key derivation and the word list, is loaded only when an account screen asks: a stored room
// never needs it)
const accountModule = () => import('./account.ts')

const port = globalThis as unknown as { postMessage(m: FromWorker): void; onmessage: ((e: MessageEvent<ToWorker>) => void) | null }
const post = (m: FromWorker): void => port.postMessage(m)

let tab: TabClient | null = null
let clientName: string | null = null
let joining: { cancel(): void } | null = null
const ASK_MS = 30_000
let asks = 0
const asked = new Map<number, (ok: boolean) => void>()

/** An error as it travels: its message and every own field (code, status, …), so the page throws the same. */
function wireError(e: unknown): WireError {
  const err = (e ?? {}) as Record<string, unknown> & { message?: string; name?: string }
  const out: WireError = { name: String(err.name ?? 'Error'), message: String(err.message ?? e) }
  for (const [k, v] of Object.entries(err)) { try { structuredClone(v); out[k] = v } catch { /* a field that does not travel */ } }
  return out
}
const extra = () => ({ stats: null, tabRole: tab?.tabRole ?? null })

/** Says an event to the page and waits until the page took it: rejects when its handler failed or it did not
 *  answer in time. For the one moment where the worker must not go on before the page has shown something. */
function ask(event: 'recovery-code', data: unknown): Promise<void> {
  const ack = ++asks
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { asked.delete(ack); reject(Object.assign(new Error('the page did not take the event'), { code: 'worker-timeout' })) }, ASK_MS)
    asked.set(ack, ok => { clearTimeout(timer); asked.delete(ack); if (ok) resolve(); else reject(Object.assign(new Error('the page could not take the event'), { code: 'worker-failed' })) })
    post({ t: 'event', event, data, ack })
  })
}

/** The client as tabs.ts runs it: its own methods the page may call, and what the worker adds for the page. */
function host(client: Client): ClientLike {
  const methods = client as unknown as Record<string, (...args: unknown[]) => unknown>
  const out: Record<string, unknown> = {
    on: (event: string, fn: (data: unknown) => void) => client.on(event, fn),
    // the account's routes of a signed-in device (a new kit, a new password, …): the slow key derivation runs here
    account: async (name: string, args: unknown) => {
      if (!ACCOUNT_CALLS.includes(name)) throw Object.assign(new Error(`not an account call: ${name}`), { code: 'bad-argument' })
      return ((await accountModule()) as unknown as Record<string, (c: Client, a: unknown) => unknown>)[name]!(client, args)
    },
    pushKey: async () => ({ vapid_public_key: b64u((await client.hub.pushState()).vapid_public_key) }),
    // the app's name for the hub (Trommi-Client), for a room core-start.ts opened before the app knew it
    configure: ({ client: name }: { client?: string | null } = {}) => { client.hub.client_name = name ?? null; return null },
  }
  for (const name of CALLS) out[name] = (...args: unknown[]) => methods[name]!.apply(client, args)
  Object.defineProperty(out, 'model', { get: () => client.model, enumerable: true })
  return out as unknown as ClientLike
}
const store = (storage: StorageName) => (wait: boolean) => openDeviceStore({ name: storage.name, wait, IdbStore })
const calls = [...CALLS, ...HOST_CALLS]

function attach(t: TabClient): void {
  tab = t
  t.on('change', (change: Change) => post({ t: 'change', patch: patchOf(t.model, change, extra()) }))
  t.on('alert', (a: unknown) => post({ t: 'event', event: 'alert', data: a }))
  t.on('error', (e: unknown) => post({ t: 'event', event: 'error', data: wireError(e) }))
  // the owner changed (this tab took over, or follows a new one): the page takes the whole model again
  t.on('reset', () => {
    if (clientName && t.client) void t.call('configure', [{ client: clientName }]).catch(() => {})
    post({ t: 'snapshot', model: snapshotOf(t.model), extra: extra() })
    post({ t: 'event', event: 'reset', data: null })
  })
}

/** A room made here (an account created, a login, a device joined): this tab owns its device from the first byte. */
async function make(m: Extract<ToWorker, { t: 'account' | 'join' }>, cache: Cache): Promise<unknown> {
  let value: unknown = null
  const made = await adoptInTabs({
    name: m.storage.name, store: store(m.storage), cache, calls,
    make: async (held: Store) => {
      const opts = { ...m.args, storage: m.storage, store: held, client: m.client }
      if (m.t === 'join') {
        const j = joinRoom(opts as unknown as Parameters<typeof joinRoom>[0])
        joining = j
        j.check_code.then(code => post({ t: 'event', event: 'join-code', data: code }), () => {})
        try { return host(await j.client) } finally { joining = null }
      }
      if (!ACCOUNT_OPENS.includes(m.fn)) throw Object.assign(new Error(`not an account call: ${m.fn}`), { code: 'bad-argument' })
      // a new recovery code is said to the page, and the step goes on only once the page has it on screen
      const step = { ...opts, on_recovery_code: (code: string) => ask('recovery-code', code) }
      const { client, ...rest } = await ((await accountModule()) as unknown as Record<string, (o: unknown) => Promise<{ client: Client } & Record<string, unknown>>>)[m.fn]!(step)
      value = rest
      return host(client)
    },
  })
  attach(made)
  return value
}

port.onmessage = async ({ data: m }) => {
  if (m.t === 'ack') { asked.get(m.ack)?.(m.ok); return }
  if (m.t === 'pagehide') { closeAllStreams(); return }
  if (m.t === 'call' && m.method === 'join.cancel') { joining?.cancel(); post({ t: 'result', id: m.id, ok: true, value: null }); return }
  if (m.t === 'open' || m.t === 'account' || m.t === 'join') {
    try {
      clientName = m.client
      const cache = await openCache(m.storage.name)
      let value: unknown
      if (m.t === 'open') {
        const opened = await openRoomInTabs({ name: m.storage.name, store: store(m.storage), cache, calls, open: async held => { const c = await openRoomOver({ storage: m.storage, client: m.client }, held); return c ? host(c) : null } })
        if (opened) attach(opened); else cache.close()
      } else value = await make(m, cache)
      post({ t: 'opened', id: m.id, model: tab ? snapshotOf(tab.model) : null, extra: extra(), ...(value !== undefined ? { value } : {}) })
    } catch (e) { post({ t: 'opened', id: m.id, model: null, error: wireError(e), extra: extra() }) }
    return
  }
  if (m.t === 'call') {
    try {
      if (!tab) throw Object.assign(new Error('no room is open in the worker'), { code: 'no-room' })
      // closing the storage (log out deletes the database next) and stopping are the same here: the tab leaves
      const value = m.method === 'stop' || m.method === 'storage.close' ? (await tab.close(), null) : await tab.call(m.method, m.args)
      post({ t: 'result', id: m.id, ok: true, value })
    } catch (e) { post({ t: 'result', id: m.id, ok: false, error: wireError(e) }) }
  }
}
// nothing a promise rejects with may end the worker without a word
addEventListener('unhandledrejection', event => { event.preventDefault(); post({ t: 'event', event: 'error', data: wireError(event.reason) }) })
post({ t: 'ready' })
