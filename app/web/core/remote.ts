// remote.ts: the page's side of the client core in a Web Worker (core-worker.ts). openRemote() starts the worker,
// which opens the stored room; it returns a RemoteClient with the Client's interface (core/README.md): `model` (an
// exact copy, mirror.ts, updated before each `change` event), `on`/`off`, and every action as a call into the worker
// (they return Promises already). The page's thread thus never verifies, decrypts, reduces or reads the room's storage.
//
//   const client = await openRemote({ url, storage: { name: 'trommi' }, client: 'app/0.2.0' })   // null: no room stored
//   client.model.cards ... ; client.on('change', change => ...) ; await client.answer({ ... })
//
// The few synchronous parts the app reads are local: model, my_device_id, is_human, stats, tabRole and hub.hub_url;
// _setRoom(fields) sets fields of model.room for the page alone (the account's state).
import { applyPatch, mirrorOf } from './mirror.ts'
import type { Change, Model } from './types.ts'
import type { Extra, FromWorker, StorageName, ToWorker, WireError } from './worker-protocol.ts'
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
  /** The device's IndexedDB databases (store-idb.ts). */
  storage?: StorageName
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
  /** The hub as far as the page needs it: its address, the room, and its Web Push key (asked in the worker). */
  readonly hub: { hub_url: string | null; room_id: string | null; pushKey(): Promise<{ vapid_public_key: string }> }
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
      pushKey: () => this.call('pushKey'),
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
}
export interface RemoteClient {
  start(opts?: unknown): Promise<void>; stop(): Promise<void>; flush(): Promise<void>; settle(opts?: unknown): Promise<void>
  [method: string]: any
}

/** The core worker's address: the bundled one (dev/build.mjs defines it), else the dev server's. */
declare const __TROMMI_CORE_WORKER__: string | undefined
const CORE_WORKER_URL: string = typeof __TROMMI_CORE_WORKER__ === 'string' ? __TROMMI_CORE_WORKER__ : '/gen/vendor/core-worker.mjs'

interface Launch { url: string | URL; client: string | null; timeout_ms: number; early?: EarlyCore | null; worker?: Worker; first: ToWorker | null; onEvent?: ((event: string, data: unknown) => unknown) | undefined }

/**
 * A worker (started here, or core-start.ts's) up to its 'opened': the RemoteClient on the room it holds then (null: no
 * room) and what the step gave besides (a new account's Emergency Kit). The timeout is for a worker that does not come up
 * at all ('ready'); a step may take as long as it takes (a join waits for the other device).
 */
function launch({ url, client, timeout_ms, early = null, worker: given, first, onEvent }: Launch): Promise<{ remote: RemoteClient | null; value: unknown }> {
  const worker = early?.worker ?? given ?? new Worker(url, { type: 'module', name: 'trommi-core' })
  return new Promise((resolve, reject) => {
    let remote: RemoteClient | null = null
    let settled = false, up = false
    const timer = setTimeout(() => { if (!settled && !up) { settled = true; worker.terminate(); reject(Object.assign(new Error('the core worker did not answer'), { code: 'worker-timeout' })) } }, timeout_ms)
    const failed = (e: { message?: string } | null) => {
      const err = Object.assign(new Error(`the core worker failed: ${e?.message || 'not loaded'}`), { code: 'worker-failed' })
      if (!settled) { settled = true; clearTimeout(timer); worker.terminate(); reject(err) } else remote?.fail(err)
    }
    const onMessage = ({ data: m }: MessageEvent<FromWorker>) => {
      if (remote) return remote.receive(m)
      if (m.t === 'ready') { up = true; clearTimeout(timer); return }
      if (m.t === 'event') {
        // an event that asks for it is answered once the page's handler is through with it (or has failed)
        const { ack } = m
        const taken = (async () => onEvent?.(m.event, m.data))()
        if (ack !== undefined) taken.then(() => worker.postMessage({ t: 'ack', ack, ok: true } satisfies ToWorker), () => worker.postMessage({ t: 'ack', ack, ok: false } satisfies ToWorker))
        else taken.catch(() => {})
        return
      }
      if (m.t !== 'opened' || settled) return
      settled = true
      clearTimeout(timer)
      if (m.error) { worker.terminate(); return reject(errorOf(m.error)) }
      if (!m.model) { worker.terminate(); return resolve({ remote: null, value: m.value }) }
      remote = new RemoteClient(worker, mirrorOf(m.model), m.extra)
      // (opened early, without the app's name for the hub: it goes now, before any call)
      if (early && client) remote.call('configure', { client }).catch(() => {})
      resolve({ remote, value: m.value })
    }
    worker.onerror = e => failed(e)
    worker.onmessage = onMessage
    if (early) {
      if (early.error) return failed(early.error)
      for (const e of early.messages.splice(0)) onMessage(e as MessageEvent<FromWorker>)
    }
    if (first) worker.postMessage(first)
  })
}

/** Start the worker and open the stored room in it. null: no room is stored. Throws when the worker does not come up. */
export async function openRemote({ url, storage = { name: 'trommi' }, client = null, timeout_ms = 20_000, early = null }: RemoteOptions): Promise<RemoteClient | null> {
  // (a worker core-start.ts started already sent the open)
  const first: ToWorker | null = early ? null : { t: 'open', id: 0, storage, client }
  return (await launch({ url, client, timeout_ms, early, first })).remote
}

const STORAGE: StorageName = { name: 'trommi' }

/** An account screen's step that makes a room (account.ts createAccount, loginWithPassword, recoverWithCode, …), run
 *  in a new core worker that then holds the room: { client: RemoteClient } and everything else the step returned (a
 *  new account's kit, a new recovery code). args: the function's own, without storage. `onEvent`: what the worker
 *  says meanwhile; for an event the worker waits on ('recovery-code'), its returning is the page's "taken". */
export async function accountInWorker(fn: string, args: Record<string, unknown>, { url = CORE_WORKER_URL, client = null, timeout_ms = 20_000, onEvent }: { url?: string; client?: string | null; timeout_ms?: number; onEvent?: (event: string, data: unknown) => unknown } = {}): Promise<{ client: RemoteClient } & Record<string, unknown>> {
  const { storage: _storage, client: _client, ...rest } = args
  const { remote, value } = await launch({ url, client, timeout_ms, first: { t: 'account', id: 0, fn, args: rest, storage: STORAGE, client }, onEvent })
  if (!remote) throw Object.assign(new Error('the core worker made no room'), { code: 'worker-failed' })
  return { ...(value as Record<string, unknown> | null ?? {}), client: remote }
}
/** Join with an invite link in a new core worker (room.ts joinRoom's shape): { check_code, client, cancel() }. */
export function joinInWorker(args: Record<string, unknown>, { url = CORE_WORKER_URL, client = null, timeout_ms = 20_000 }: { url?: string; client?: string | null; timeout_ms?: number } = {}): { check_code: Promise<string>; client: Promise<RemoteClient>; cancel(): void } {
  const { storage: _storage, client: _client, ...rest } = args
  let codeResolve: (c: string) => void = () => {}, codeReject: (e: unknown) => void = () => {}
  const check_code = new Promise<string>((res, rej) => { codeResolve = res; codeReject = rej })
  check_code.catch(() => {})
  const worker = new Worker(url, { type: 'module', name: 'trommi-core' })
  const made = launch({ url, client, timeout_ms, worker, first: { t: 'join', id: 0, args: rest, storage: STORAGE, client }, onEvent: (event, data) => { if (event === 'join-code') codeResolve(data as string) } })
    .then(({ remote }) => { if (!remote) throw Object.assign(new Error('the core worker made no room'), { code: 'worker-failed' }); return remote })
  made.catch(e => codeReject(e))
  return {
    check_code,
    client: made,
    cancel() { worker.postMessage({ t: 'call', id: -1, method: 'join.cancel', args: [] } satisfies ToWorker) },
  }
}
