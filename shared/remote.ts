// remote.ts: the page's side of the client core in a Web Worker (core-worker.ts). openRemote() starts the worker,
// which opens the stored room; it returns a RemoteClient with the Client's interface (shared/README.md): `model` (an
// exact copy, mirror.ts, updated before each `change` event), `on`/`off`, and every action as a call into the worker
// (they return Promises already). The page's thread thus never verifies, decrypts, reduces or reads the room's storage.
//
//   const client = await openRemote({ url, storage: { name: 'trommi', prefix: 'room/' }, client: 'app/0.2.0' })   // null: no room stored
//   client.model.cards ... ; client.on('change', change => ...) ; await client.answer({ ... })
//
// The few synchronous parts the app reads are local: model, my_device_id, is_human, stats, tabRole, hub.hub_url and
// hub.roomPath(); _setRoom(fields) sets fields of model.room for the page alone (the account's state), as before.
import { applyPatch, mirrorOf } from './mirror.ts'
import type { Change, Model } from './types.ts'
import type { Extra, FromWorker, ToWorker, WireError } from './worker-protocol.ts'
import { CALLS } from './worker-protocol.ts'
import { emptyChange } from './model-shape.ts'
import type { EarlyCore } from './core-start.ts'

type Listener = (data: any) => void
type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void }

/** An error from the worker, thrown here as the core threw it there (message, code, status, …). */
function errorOf(w: WireError | undefined): Error {
  const e = new Error(w?.message ?? 'the core worker failed') as Error & Record<string, unknown>
  for (const [k, v] of Object.entries(w ?? {})) if (k !== 'message' && k !== 'stack') e[k] = v
  return e
}

export interface RemoteOptions {
  /** The worker's module address. */
  url: string | URL
  /** The room's IndexedDB storage (storage-idb.ts). */
  storage?: { name: string; prefix: string }
  /** Trommi-Client of every request (app/<version>). */
  client?: string | null
  /** No answer from the worker by then: openRemote fails (the caller may open the room in the page instead). */
  timeout_ms?: number
  /** The worker core-start.ts started before the app (it opened the room already). */
  early?: EarlyCore | null
}

export class RemoteClient {
  model: Model
  stats: Record<string, number> | null = null
  tabRole: string | null = null
  readonly worker: Worker
  private listeners = new Map<string, Set<Listener>>()
  private pending = new Map<number, Pending>()
  private seq = 0
  /** The hub as far as the page needs it: its address, room paths, and requests signed in the worker (account.mjs). */
  readonly hub: { hub_url: string | null; room_id: string | null; roomPath(path?: string): string; request(method: string, path: string, opts?: unknown): Promise<any>; pushKey(): Promise<any> }
  /** Closing the storage closes the worker's (log out deletes the database next). */
  readonly storage = { close: async () => { await this.call('storage.close').catch(() => {}); this.worker.terminate() } }

  constructor(worker: Worker, model: Model, extra: Extra) {
    this.worker = worker
    this.model = model
    this.setExtra(extra)
    const self = this
    this.hub = {
      get hub_url() { return self.model.room.hub_url },
      get room_id() { return self.model.room.room_id },
      roomPath(path = '') { const id = self.model.room.room_id; if (!id || !/^[0-9a-f]{64}$/.test(id)) throw Object.assign(new Error('room_id must be 64 lowercase hex characters'), { code: 'bad-argument' }); return `/rooms/${id}${path}` },
      request: (method, path, opts) => this.call('hub.request', method, path, opts),
      pushKey: () => this.call('hub.pushKey'),
    }
    for (const m of CALLS) (this as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => this.call(m, ...args)
  }

  private setExtra(x: Extra | undefined): void { if (!x) return; if (x.stats !== undefined) this.stats = x.stats ?? null; if (x.tabRole !== undefined) this.tabRole = x.tabRole ?? null }

  /** Messages from the worker (the open's answer is taken by openRemote first). */
  receive(m: FromWorker): void {
    switch (m.t) {
      case 'change': {
        this.setExtra(m.patch.extra as Extra | undefined)
        const change = applyPatch(this.model, m.patch)
        this.emit('change', change)
        return
      }
      case 'snapshot': {
        // A new client behind the worker (this tab took over writing): the copy starts again, same object.
        const fresh = mirrorOf(m.model)
        for (const k of Object.keys(this.model)) if (!(k in fresh) && k !== 'room') delete (this.model as unknown as Record<string, unknown>)[k]
        const local = Object.fromEntries(Object.entries(this.model.room).filter(([k]) => !(k in fresh.room)))
        Object.assign(this.model, fresh, { room: Object.assign(fresh.room, local) })
        this.setExtra(m.extra)
        return
      }
      case 'event': this.emit(m.event, m.event === 'error' ? errorOf(m.data as WireError) : m.data); return
      case 'result': {
        const p = this.pending.get(m.id)
        if (!p) return
        this.pending.delete(m.id)
        if (m.ok) p.resolve(m.value); else p.reject(errorOf(m.error))
        return
      }
    }
  }
  /** The worker died (a crash, an error loading it): every call still waiting fails, and 'error' says so. */
  fail(e: unknown): void {
    for (const p of this.pending.values()) p.reject(e)
    this.pending.clear()
    this.emit('error', e)
  }

  call(method: string, ...args: unknown[]): Promise<any> {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try { this.worker.postMessage({ t: 'call', id, method, args } satisfies ToWorker) }
      catch (e) { this.pending.delete(id); reject(e) }
    })
  }

  // ---- the Client's interface, local ----
  get my_device_id(): string | null { return this.model.room.my_device_id }
  get is_human(): boolean { return this.model.room.my_role === 'human' }
  on(event: string, fn: Listener): () => void { if (!this.listeners.has(event)) this.listeners.set(event, new Set()); this.listeners.get(event)!.add(fn); return () => this.off(event, fn) }
  off(event: string, fn: Listener): void { this.listeners.get(event)?.delete(fn) }
  emit(event: string, data: unknown): void { for (const fn of this.listeners.get(event) ?? []) { try { fn(data) } catch (e) { console.error('[core] listener', e) } } }
  _emitChange(change: Change): void { this.emit('change', change) }
  /** Fields of model.room the page keeps for itself (the account's state on the Settings page): a change, here only. */
  _setRoom(fields: Record<string, unknown>): void { Object.assign(this.model.room, fields); const ch = emptyChange(); ch.room = true; this._emitChange(ch) }
  /** Development hooks (app/web/dev/e2e.mjs, dev/load): run in the worker. */
  serial<T>(fn: () => T): T { return fn() }
  _refreshMembers(): Promise<unknown> { return this.call('refreshMembers') }
  get _revisions(): Promise<unknown> { return this.call('revisions') }
}
export interface RemoteClient {
  start(opts?: unknown): Promise<void>; stop(): Promise<void>; flush(): Promise<void>; settle(opts?: unknown): Promise<void>
  [method: string]: any
}

/** Start the worker and open the stored room in it. null: no room is stored. Throws when the worker does not come up. */
export function openRemote({ url, storage = { name: 'trommi', prefix: 'room/' }, client = null, timeout_ms = 20_000, early = null }: RemoteOptions): Promise<RemoteClient | null> {
  // A worker core-start.ts started already (it sent the open): take it over with what it said so far.
  const worker = early?.worker ?? new Worker(url, { type: 'module', name: 'trommi-core' })
  return new Promise((resolve, reject) => {
    let remote: RemoteClient | null = null
    let settled = false
    const timer = setTimeout(() => { if (!settled) { settled = true; worker.terminate(); reject(Object.assign(new Error('the core worker did not answer'), { code: 'worker-timeout' })) } }, timeout_ms)
    const failed = (e: { message?: string } | null) => {
      const err = Object.assign(new Error(`the core worker failed: ${e?.message || 'not loaded'}`), { code: 'worker-failed' })
      if (!settled) { settled = true; clearTimeout(timer); worker.terminate(); reject(err) } else remote?.fail(err)
    }
    const onMessage = ({ data: m }: MessageEvent<FromWorker>) => {
      if (remote) return remote.receive(m)
      if (m.t !== 'opened' || settled) return
      settled = true
      clearTimeout(timer)
      if (m.error) { worker.terminate(); return reject(errorOf(m.error)) }
      if (!m.model) { worker.terminate(); return resolve(null) }
      remote = new RemoteClient(worker, mirrorOf(m.model), m.extra)
      // (opened early, without the app's name for the hub: it goes now, before any call)
      if (early && client) remote.call('configure', { client }).catch(() => {})
      resolve(remote)
    }
    worker.onerror = e => failed(e)
    worker.onmessage = onMessage
    if (early) {
      if (early.error) return failed(early.error)
      for (const e of early.messages.splice(0)) onMessage(e as MessageEvent<FromWorker>)
    } else worker.postMessage({ t: 'open', id: 0, storage, client } satisfies ToWorker)
  })
}
