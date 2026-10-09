// tabs.ts: one device in several tabs of one browser profile. A device's stored state has exactly one owner
// (core/src/store.rs "One owner"; two owners would sign two different items under one number), so exactly one tab
// runs the real client: the OWNER ('leader'). There is ONE mechanism for that, and it is not here: the device
// store's own Web Lock (the binding's IdbStore takes it in `load()` and holds it until `close()`). This module only
// asks the store: `load()` without waiting either gives the state, and this tab owns it, or throws StoreConflict,
// and this tab follows. So nothing is ever read before the lock is held.
//
// A FOLLOWER holds no device. It keeps an exact copy of the owner's model (mirror.ts, the same way a page copies its
// worker's model: one snapshot, then the patch of every change, here over a BroadcastChannel) and emits the same
// `change` events from it. Every call it is asked to make is forwarded to the owner by name and answered from there.
// Meanwhile it waits for the store's lock (`load()` with `wait`). When the owner goes (tab closed or crashed: the
// browser frees the lock), the next follower's `load()` returns: it opens the client from what is stored, becomes the
// owner, announces itself, and runs the calls still waiting: its own at once, the others' as they send them again.
//
// A call is run at most once. A forwarded call carries an id and is sent again until it is answered.
// - Under one owner: it keeps the outcome of every forwarded call until the caller acknowledged it, so a call sent
//   again is answered again, never run again.
// - Across an owner change that memory is gone. What the old owner's Device stored stays (a sealed item is in its
//   outbox and the new owner sends it), but whether a call ran is not in the Device's state, and this module cannot
//   put it there: the binding writes its own transaction. So the owner keeps a RECEIPT per forwarded call in the
//   cache (`cache`): 'started' before the call runs, its outcome after. A new owner that is sent the call again
//   answers the stored outcome; where it finds only 'started', it does NOT run the call a second time and answers
//   the refusal `outcome-unknown`: the old owner went between starting and answering, and the model (rebuilt from
//   what is stored and from the hub) shows whether the call took effect. At most once, never twice; the price is
//   that refusal for the one call that was in flight when its owner died. Receipts go when acknowledged, and after
//   a day; a call id older than a day is refused (`expired`) instead of run.
// - Without `cache` there are no receipts, and a call in flight at an owner change runs again in the new owner.
//
// An owner's Device can close itself: a write failed, or another owner wrote (the lock can be taken from an owner
// with `steal`, by other code of the origin or the browser's tools; the binding's store does not notice, but its
// revision check refuses the old owner's next write). The client then emits 'device-closed', and this tab drops the
// client and stands in line for the lock like a follower: it leads again from what is stored if nobody else took
// over, and follows the new owner otherwise. One path for both cases, and the lock decides.
//
// What is missing without the browser's parts: without Web Locks the store refuses to load (one owner cannot be
// ensured), so nothing opens. Without BroadcastChannel the first tab owns and works; a second tab cannot follow and
// is refused with `owned-elsewhere`.
//
//   const tab = await openRoomInTabs({ name, store: wait => openDeviceStore({ name, wait, IdbStore }), open, cache })
//   tab.tabRole            // 'leader' | 'follower'
//   tab.model              // the client's model, or the follower's copy of it
//   tab.on('change', fn)   // also 'reset' (tab.model is a new object: take all of it again), 'alert', 'error'
//   await tab.call('sendMessage', [draft])
import { applyPatch, mirrorOf, patchOf, snapshotOf } from './mirror.ts'
import type { ModelPatch, ModelSnapshot } from './mirror.ts'
import type { StoredState } from './core-api.ts'
import type { Cache, DeviceStore } from './store-idb.ts'
import type { Change, Model } from './types.ts'
import type { WireError } from './worker-protocol.ts'

type Listener = (data: any) => void
/** The BroadcastChannel constructor (a parameter, so a test can hand in its own, or null for a browser without). */
type ChannelCtor = new (name: string) => BroadcastChannel

/** How a call ended, as it travels and as its receipt keeps it. */
export type CallOutcome = { ok: true; value: unknown } | { ok: false; error: WireError }
/** What the cache holds per forwarded call under `callKey(id)`: without `outcome`, the call was started and no more is known. */
export interface CallReceipt { started: number; outcome?: CallOutcome }

/** The client the owner runs, as far as this module needs it. `stop()` closes its Device, and with it the store. */
export interface ClientLike {
  model: Model
  /** Events: 'change' (a Change of `model`), 'device-closed' (its Device closed itself: this client is over), others. */
  on(event: string, fn: Listener): () => void
  start?(...args: any[]): unknown
  stop?(): unknown
  [method: string]: unknown
}

export interface TabsOptions {
  /** The device store's name; the channel is named after it. */
  name: string
  /** A new store object on `name` (`openDeviceStore`); with `wait`, one whose `load()` waits for the owner lock. */
  store(wait: boolean): DeviceStore
  /** The client over a store that is loaded, so with the owner lock held (`Device.open(store)` reads the same state
   *  again); null when nothing is stored. Called at the start and when a follower takes over. If it does not return
   *  a client, the store is closed here. */
  open(store: DeviceStore, stored: StoredState): Promise<ClientLike | null>
  /** Where the receipts of forwarded calls are kept (see above). */
  cache?: Cache
  /** The only names `call` runs; without it, every function of the client. */
  calls?: readonly string[]
  /** The client's events passed on to followers beside 'change'. */
  events?: readonly string[]
  Channel?: ChannelCtor | null
}

/** What a tab gets: the same in both roles. */
export interface TabClient {
  readonly tabRole: 'leader' | 'follower'
  /** The owner's model, or the follower's copy. A new object after 'reset'. */
  readonly model: Model
  /** The real client while this tab is the owner, else null. */
  readonly client: ClientLike | null
  /** 'change' (a Change of `model`), 'reset' (`model` was replaced: the owner changed), and the client's events. */
  on(event: string, fn: Listener): () => void
  /** Runs `method` on the owner's client, here or in the owner's tab; arguments and result are structured-clone
   *  data. 'start' and 'stop' are this tab's own and never forwarded: `start` runs on the client while this tab is
   *  the owner, and its arguments are kept and used again when this tab becomes the owner; `stop` is `close()` (a
   *  stopped client has closed its Device and freed the lock, so this tab cannot stay the owner). */
  call(method: string, args?: unknown[]): Promise<unknown>
  /** Leaves: stops the client (which frees the lock: the next tab takes over), rejects the calls still waiting. */
  close(): Promise<void>
}

const RETRY_MS = 2500      // a forwarded call not answered by then is sent again, under the same id
const HELLO_MS = 700       // a follower without a model asks again
const REOPEN_MS = 1000     // a tab whose takeover failed waits this long before it stands in line again
const DAY_MS = 86_400_000  // how long a call id is good for, and a receipt kept
const HOUR_MS = 3_600_000  // how often an owner looks for answers and receipts that are too old

const CALL_PREFIX = 'call/'
/** Where a call's receipt is in the cache. Call ids start with their time, so the keys sort by age. */
export const callKey = (id: string): string => CALL_PREFIX + id
const stamp = (ms: number): string => Math.max(0, ms).toString(36).padStart(9, '0')
const timeOf = (id: string): number => parseInt(id.slice(0, 9), 36)
const newId = (): string => `${stamp(Date.now())}-${[...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, '0')).join('')}`
/** Deletes the receipts older than a day: their calls are refused as expired from then on, so nothing needs them. */
export async function forgetCalls(cache: Cache): Promise<void> {
  const old = await cache.range(CALL_PREFIX, { before: CALL_PREFIX + stamp(Date.now() - DAY_MS) })
  if (old.length) await cache.setMany(old.map(([key]): [string, undefined] => [key, undefined]))
}

type Message =
  | { t: 'owner'; owner: string }                                                                 // an owner is ready
  | { t: 'hello'; from: string; ask: string }                                                     // a follower asks for the model
  | { t: 'snapshot'; to: string; ask: string; owner: string; seq: number; model: ModelSnapshot }  // the model after patch `seq`
  | { t: 'patch'; owner: string; seq: number; patch: ModelPatch }
  | { t: 'event'; owner: string; event: string; data: unknown }
  | { t: 'call'; id: string; from: string; method: string; args: unknown[] }
  | { t: 'result'; id: string; to: string; outcome: CallOutcome }
  | { t: 'ack'; id: string }                                                                      // the caller has its answer
/** A forwarded call in its owner: its outcome (null while it runs), and when it came. */
interface Answer { outcome: CallOutcome | null; at: number }
/** A forwarded call waiting for its answer. */
interface Waiting { method: string; args: unknown[]; resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> | null }

const refusal = (code: string, message: string): Error => Object.assign(new Error(message), { code })
/** An error as it travels: its name, its message and every own field that can be cloned (code, status, …). */
function wireError(e: unknown): WireError {
  const err = (e ?? {}) as Record<string, unknown>
  const out: WireError = { name: String(err['name'] ?? 'Error'), message: String(err['message'] ?? e) }
  for (const [k, v] of Object.entries(err)) { try { out[k] = structuredClone(v) } catch { /* a field that cannot travel stays behind */ } }
  return out
}
const thrown = (w: WireError): Error => Object.assign(new Error(w.message), w)
/** Another tab or worker has the state open: the binding's StoreConflict, as the store throws it or as the cause of
 *  a Device's `storage` refusal (by its name: this module does not load the binding). */
const isConflict = (e: unknown): boolean => {
  const err = e as { name?: string; code?: string; cause?: { name?: string } } | null
  return err?.name === 'StoreConflict' || (err?.code === 'storage' && err.cause?.name === 'StoreConflict')
}

/**
 * The stored device for this tab: its owner if no other tab is, else a follower of the owner. Resolves with null
 * when nothing is stored (the lock is free again then).
 */
export function openRoomInTabs(opts: TabsOptions): Promise<TabClient | null> {
  return tabs(opts, false)
}

/**
 * A device this tab is about to make (an account created, a device joined or signed in): `make` gets the loaded
 * store, so the owner lock is held before anything is created (`Device.create(store)`), and this tab owns the device
 * from then on. Refused with code 'owned-elsewhere' when another tab is the owner (then `openRoomInTabs` follows it).
 */
export async function adoptInTabs(opts: Omit<TabsOptions, 'open'> & { make(store: DeviceStore, stored: StoredState): Promise<ClientLike> }): Promise<TabClient> {
  const { make, ...rest } = opts
  return (await tabs({ ...rest, open: make }, true))!
}

async function tabs({ name, store, open, cache, calls, events = ['alert', 'error'], Channel = globalThis.BroadcastChannel }: TabsOptions, adopting: boolean): Promise<TabClient | null> {
  const me = newId()
  const channel = Channel ? new Channel(`trommi-tabs:${name}`) : null
  const post = (m: Message) => { try { channel?.postMessage(m) } catch (e) { emit('error', e) } }

  let role: 'leader' | 'follower' = 'follower'
  let client: ClientLike | null = null       // the owner's client
  let copy: Model | null = null              // the follower's copy of the owner's model
  let closed = false
  let started: unknown[] | null = null       // the arguments of this tab's start(), for when it becomes the owner
  let inLine: DeviceStore | null = null      // the store whose load() waits for the lock
  let opening: DeviceStore | null = null     // the loaded store the client is being opened over
  const listeners = new Map<string, Set<Listener>>()
  const offs: (() => void)[] = []            // the owner's subscriptions on its client

  // owner
  let seq = 0                                // patches sent
  let heard = false                          // a follower said hello: from then on changes are sent
  // Forwarded calls not yet acknowledged: id -> outcome, null while it runs. An entry goes with its acknowledgement;
  // what followers that died left behind goes after a day (`prune`).
  const answers = new Map<string, Answer>()
  // follower
  let following: string | null = null        // the owner whose model this tab holds
  let last = 0                               // the last patch of it applied
  let ask = ''                               // the question that is out (`resync`): only its snapshot is taken
  let helloTimer: ReturnType<typeof setTimeout> | null = null
  const pending = new Map<string, Waiting>() // this tab's forwarded calls

  function emit(event: string, data: unknown): void {
    for (const fn of [...(listeners.get(event) ?? [])]) { try { fn(data) } catch (e) { console.error(`[tabs] a listener of '${event}' threw`, (e as Error)?.name) } }
  }

  // ---- the owner: run a call -----------------------------------------------------------------------------------
  const invoke = async (c: ClientLike, method: string, args: unknown[]): Promise<unknown> => {
    if (calls && !calls.includes(method)) throw refusal('bad-argument', `not a client call: ${method}`)
    const fn = c[method]
    if (typeof fn !== 'function') throw refusal('bad-argument', `this client has no ${method}`)
    return fn.apply(c, args)
  }
  /**
   * A forwarded call (or one of this tab's own from before it took over), at most once: what its receipt says, else
   * it runs now, between two writes of its receipt. Never rejects. Null: this tab stopped being the owner before the
   * call ran; whoever owns now is sent it again.
   */
  const run = async (id: string, method: string, args: unknown[]): Promise<CallOutcome | null> => {
    const c = client
    if (!c) return null
    const receipt: CallReceipt = { started: Date.now() }
    try {
      if (!(Date.now() - timeOf(id) < DAY_MS)) throw refusal('expired', 'this call waited too long to be run')
      if (cache) {
        const had = await cache.get(callKey(id)) as CallReceipt | undefined
        if (had) return had.outcome ?? { ok: false, error: wireError(refusal('outcome-unknown', 'the tab that ran this call went before it answered: it may or may not have taken effect')) }
        if (client !== c) return null
        // (on disk before the call runs: what the call writes is durable, so the note that it started must be too)
        await cache.set(callKey(id), receipt, { durable: true })
        // (no owner any more, and the call did not run: the note goes, so the next owner runs it)
        if (client !== c) { await cache.delete(callKey(id)); return null }
      }
      if (client !== c) return null
    } catch (e) { return { ok: false, error: wireError(e) } }
    let outcome: CallOutcome
    try { outcome = { ok: true, value: structuredClone(await invoke(c, method, args)) } } catch (e) { outcome = { ok: false, error: wireError(e) } }
    // Only while this client is still the owner's: after that the receipt is the next owner's to answer and to
    // delete. If the write fails the receipt stays 'started': outcome-unknown for a new owner, never a second run.
    if (cache && client === c) await cache.set(callKey(id), { ...receipt, outcome }).catch(e => emit('error', e))
    return outcome
  }
  /** One run per call id at a time in this tab, whoever asks: the channel, or this tab's own waiting call. */
  const running = new Map<string, Promise<CallOutcome | null>>()
  const execute = (id: string, method: string, args: unknown[]): Promise<CallOutcome | null> => {
    let job = running.get(id)
    if (!job) { job = run(id, method, args).finally(() => running.delete(id)); running.set(id, job) }
    return job
  }
  /** Now and then: answers nobody acknowledged for a day (their callers are gone), and receipts as old. */
  let pruned = Date.now()
  const prune = () => {
    if (Date.now() - pruned < HOUR_MS) return
    pruned = Date.now()
    for (const [id, entry] of answers) if (entry.outcome && pruned - entry.at > DAY_MS) answers.delete(id)
    if (cache) forgetCalls(cache).catch(e => emit('error', e))
  }
  const onCall = (m: Extract<Message, { t: 'call' }>) => {
    const had = answers.get(m.id)
    if (had) { if (had.outcome) post({ t: 'result', id: m.id, to: m.from, outcome: had.outcome }); return }   // (still running: its answer follows)
    const entry: Answer = { outcome: null, at: Date.now() }
    answers.set(m.id, entry)
    prune()
    void execute(m.id, m.method, m.args).then(outcome => {
      if (!outcome) { if (answers.get(m.id) === entry) answers.delete(m.id); return }
      entry.outcome = outcome
      post({ t: 'result', id: m.id, to: m.from, outcome })
    })
  }
  const onAck = (id: string) => {
    if (!answers.delete(id)) return
    cache?.delete(callKey(id)).catch(e => emit('error', e))
  }

  // ---- the follower: forward a call and wait ---------------------------------------------------------------------
  const settle = (id: string, outcome: CallOutcome) => {
    const call = pending.get(id)
    if (!call) return
    pending.delete(id)
    if (call.timer) clearTimeout(call.timer)
    if (outcome.ok) call.resolve(outcome.value); else call.reject(thrown(outcome.error))
  }
  const send = (id: string) => {
    const call = pending.get(id)
    if (!call) return
    if (call.timer) clearTimeout(call.timer)
    call.timer = null
    if (client) {
      void execute(id, call.method, call.args).then(outcome => {
        if (!outcome) { send(id); return }   // (no owner any more: to the next one)
        settle(id, outcome)
        cache?.delete(callKey(id)).catch(e => emit('error', e))
      })
      return
    }
    post({ t: 'call', id, from: me, method: call.method, args: call.args })
    call.timer = setTimeout(() => send(id), RETRY_MS)
  }
  const forward = (method: string, args: unknown[]) => new Promise<unknown>((resolve, reject) => {
    let own: unknown[]
    try { own = structuredClone(args) } catch { reject(refusal('bad-argument', `the arguments of ${method} cannot be sent to the owner tab`)); return }
    const id = newId()
    pending.set(id, { method, args: own, resolve, reject, timer: null })
    send(id)
  })
  const rejectPending = (error: Error) => {
    for (const [id, call] of [...pending]) { pending.delete(id); if (call.timer) clearTimeout(call.timer); call.reject(error) }
  }
  const stopHello = () => { if (helloTimer) clearTimeout(helloTimer); helloTimer = null }
  /** Asks the owner for its whole model, again and again (the same question) until its snapshot came. */
  const hello = () => {
    stopHello()
    if (closed || client || following) return
    post({ t: 'hello', from: me, ask })
    helloTimer = setTimeout(hello, HELLO_MS)
  }
  /** A new question: the copy is not the owner's model any more (a new owner, a missed patch), or there is none yet. */
  const resync = () => { following = null; ask = newId(); hello() }

  // A follower is open once it has a model, or learnt that there is none to have.
  let waitingToOpen = true
  let opened: (has: boolean) => void = () => {}
  let openFailed: (error: unknown) => void = () => {}
  const ready = new Promise<boolean>((resolve, reject) => { opened = resolve; openFailed = reject }).finally(() => { waitingToOpen = false })

  if (channel) channel.onmessage = ({ data: m }: MessageEvent<Message>) => {
    if (closed || !m || typeof m !== 'object') return
    if (client) {
      if (m.t === 'hello') { heard = true; post({ t: 'snapshot', to: m.from, ask: m.ask, owner: me, seq, model: snapshotOf(client.model) }) }
      else if (m.t === 'call') onCall(m)
      else if (m.t === 'ack') onAck(m.id)
      return
    }
    switch (m.t) {
      case 'owner':   // a new owner: its model replaces the copy, and it is asked for the calls still waiting
        resync()
        for (const id of [...pending.keys()]) send(id)
        break
      case 'snapshot': {
        if (m.to !== me || m.ask !== ask || following) break   // (only the answer to the question that is out)
        const first = copy === null
        copy = mirrorOf(m.model); following = m.owner; last = m.seq
        stopHello()
        if (first) opened(true); else emit('reset', undefined)
        break
      }
      case 'patch':
        if (m.owner !== following || !copy || m.seq <= last) break
        if (m.seq !== last + 1) { resync(); break }   // one was missed: take the whole model again
        last = m.seq
        emit('change', applyPatch(copy, m.patch))
        break
      case 'event':
        if (m.owner === following) emit(m.event, m.data)
        break
      case 'result':
        if (m.to !== me || !pending.has(m.id)) break
        post({ t: 'ack', id: m.id })
        settle(m.id, m.outcome)
        break
    }
  }

  // ---- owning ---------------------------------------------------------------------------------------------------------
  /** Over a loaded store (the lock is held): open the client and lead. False when nothing is stored. */
  const lead = async (s: DeviceStore, stored: StoredState): Promise<boolean> => {
    let c: ClientLike | null
    opening = s
    try { c = await open(s, stored) } catch (e) { await s.close(); throw e } finally { opening = null }
    if (!c) { await s.close(); return false }
    if (closed) { await c.stop?.(); await s.close(); return false }
    const takeover = copy !== null
    client = c; copy = null; role = 'leader'; following = null; seq = 0; heard = false
    stopHello()
    offs.push(c.on('change', (change: Change) => {
      // (the patch is serialised inside postMessage, before the client changes its model again)
      if (heard) post({ t: 'patch', owner: me, seq: ++seq, patch: patchOf(c.model, change) })
      emit('change', change)
    }))
    for (const event of events) offs.push(c.on(event, (data: unknown) => {
      if (heard) post({ t: 'event', owner: me, event, data: data instanceof Error ? wireError(data) : data })
      emit(event, data)
    }))
    offs.push(c.on('device-closed', () => { if (client === c) void demote() }))
    if (takeover) emit('reset', undefined)
    post({ t: 'owner', owner: me })
    if (cache) forgetCalls(cache).catch(e => emit('error', e))
    for (const id of [...pending.keys()]) send(id)
    // (not awaited: a start that waits for the network must not keep the other tabs without an owner)
    const args = started
    if (args) void (async () => c.start?.(...args))().catch(e => emit('error', e))
    return true
  }
  const dropClient = async () => {
    const c = client
    if (c) copy = c.model   // (shown until a new owner's snapshot comes)
    client = null
    role = 'follower'
    for (const off of offs.splice(0)) off()
    answers.clear()
    try { await c?.stop?.() } catch (e) { emit('error', e) }
  }
  /** The client's Device closed itself: this tab is no owner any more, and stands in line again. */
  const demote = async () => {
    await dropClient()
    if (!closed) follow()
  }
  /** Stands in line for the store's lock; when it comes, this tab takes over. */
  const follow = () => {
    role = 'follower'
    resync()
    const s = inLine = store(true)
    void (async () => {
      try {
        const stored = await s.load()
        inLine = null
        if (closed) { await s.close(); return }
        if (await lead(s, stored)) { if (waitingToOpen) opened(true); return }
        if (closed) return
        // Nothing is stored any more (the owner signed out and deleted the store): there is nothing to lead.
        const gone = refusal('no-room', 'the device is no longer stored')
        if (waitingToOpen) opened(false)
        else { closed = true; stopHello(); rejectPending(gone); channel?.close(); emit('error', gone) }
      } catch (e) {
        // The takeover failed (the store or the client did not open): the lock is free again, this tab stands in
        // line once more.
        inLine = null
        await s.close()
        if (closed) return
        if (waitingToOpen) { openFailed(e); return }
        emit('error', e)
        setTimeout(() => { if (!closed && !client) follow() }, REOPEN_MS)
      }
    })()
  }

  const leave = async () => {
    if (closed) return
    closed = true
    stopHello()
    rejectPending(refusal('closed', 'this tab left the device'))
    const waiting = inLine, half = opening
    inLine = null
    // (a store in line gives its place up; a client still being opened must not keep the lock)
    await Promise.all([waiting?.close(), half?.close(), dropClient()])
    channel?.close()
  }

  const first = store(false)
  let stored: StoredState | null = null
  try { stored = await first.load() } catch (e) {
    await first.close()
    if (!isConflict(e)) { channel?.close(); throw e }
  }
  if (stored) {
    let has: boolean
    try { has = await lead(first, stored) } catch (e) { channel?.close(); throw e }
    if (!has) { channel?.close(); return null }
  } else {
    if (adopting || !channel) { channel?.close(); throw refusal('owned-elsewhere', 'another tab owns the device store') }
    follow()
    let has: boolean
    try { has = await ready } catch (e) { await leave(); throw e }
    if (!has) { await leave(); return null }
  }

  return {
    get tabRole() { return role },
    get model() { return client ? client.model : copy! },
    get client() { return client },
    on(event: string, fn: Listener): () => void {
      let set = listeners.get(event)
      if (!set) listeners.set(event, set = new Set())
      set.add(fn)
      return () => { set.delete(fn) }
    },
    async call(method: string, args: unknown[] = []): Promise<unknown> {
      if (closed) throw refusal('closed', 'this tab left the device')
      if (method === 'start') { started = args; return client?.start?.(...args) }
      if (method === 'stop') return leave()
      return client ? invoke(client, method, args) : forward(method, args)
    },
    close: leave,
  }
}
