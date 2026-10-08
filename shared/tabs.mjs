// tabs.mjs: one room in several tabs of one browser. A device seals with one chain, so exactly one tab writes: the
// leader, elected with a Web Lock (held for the tab's life; a closed or crashed tab frees it and the next tab in line
// gets it). Every other tab is a follower and stays fully usable: it reads the room itself (its own stream, everything
// verified, its state in memory over a consistent picture of the stored room) and forwards each write action to the
// leader over a BroadcastChannel (request/response by id, retried until answered). When the leader goes, a follower is
// granted the lock, opens the room from storage as the writer (the outbox and the own chain head are on disk before
// any post, so nothing is lost and nothing is sealed twice), and runs the calls still waiting, its own and the other
// tabs'. A forwarded call carries a random id that goes into the outbox with what it sealed: a retry after the leader
// changed finds it there (or in the acked list) and is answered without sealing again (exactly once).
//
//   const client = await openRoomInTabs({ storage: idbStorage({ name: 'trommi', prefix: 'room/' }), makeStorage, client: 'web' })
//   client.tabRole   // 'leader' | 'follower'; the rest is the Client's interface (shared/README.md)
//
// Without Web Locks or BroadcastChannel (Node, old browsers) it is openRoom: one client, its own lock.
import { openRoom } from './room.mjs'
import { rangeOf } from './storage-memory.mjs'
import * as M from './model.ts'
import * as z from './crypto/zcrypto.mjs'

const { ZError, hex } = z

/** The Client's write actions: in a follower they run in the leader tab. */
export const FORWARDED = ['sendMessage', 'answer', 'trust', 'markRead', 'shred', 'decideAgain', 'verdict', 'setRegisters', 'setDraft', 'snooze',
  'duck', 'setCrown', 'setDesk', 'saveNote', 'deleteNote', 'sendStrokes', 'createInvite',
  'confirmInvite', 'removeDevices', 'createSession', 'assignSession', 'leaveRoom', 'writeSnapshot']

const RETRY_MS = 2500           // a forwarded call not answered by then is sent again (same id)
const GIVE_UP_MS = 120_000      // ... until it is given up
const LIVE = ['tl/']            // timeline records are read from storage as they are (immutable, many): not in the picture

/**
 * Storage for a follower: reads come from one consistent snapshot of the stored room (timeline records live from the
 * base), writes stay in memory. The leader alone writes the stored room.
 */
export async function overlayStorage(base, { live = LIVE } = {}) {
  const snap = base.snapshot ? await base.snapshot({ skip: live }) : new Map((await base.range('')).filter(([k]) => !live.some(p => k.startsWith(p))))
  const over = new Map()
  const GONE = Symbol('gone')
  const isLive = k => live.some(p => k.startsWith(p))
  const clone = v => (v === undefined || v === GONE ? undefined : structuredClone(v))
  const merged = async (p, opts) => {
    const all = new Map()
    for (const [k, v] of rangeOf(snap, p, opts)) all.set(k, v)
    for (const l of live) {
      if (!(l.startsWith(p) || p.startsWith(l))) continue
      const lp = p.startsWith(l) ? p : l
      const extra = [...over.keys()].filter(k => k.startsWith(lp)).length
      const limit = opts.limit === undefined || opts.limit === Infinity ? Infinity : opts.limit + extra
      for (const [k, v] of await base.range(lp, { ...opts, limit })) all.set(k, v)
    }
    for (const [k, v] of over) if (k.startsWith(p)) all.set(k, v)
    for (const [k, v] of all) if (v === GONE) all.delete(k)
    return all
  }
  return {
    extractable_keys: base.extractable_keys,
    overlay: true,
    async get(k) { if (over.has(k)) return clone(over.get(k)); return isLive(k) ? base.get(k) : clone(snap.get(k)) },
    async set(k, v) { over.set(k, structuredClone(v)) },
    async delete(k) { over.set(k, GONE) },
    async setMany(entries) { for (const [k, v] of entries) over.set(k, v === undefined ? GONE : structuredClone(v)) },
    async keys(p = '') { return [...(await merged(p, {})).keys()].sort() },
    async range(p, opts = {}) { return rangeOf(await merged(p, opts), p, opts).map(([k, v]) => [k, clone(v)]) },
    async saveDevice() { throw new ZError('follower', 'a follower tab does not store a device') },
    loadDevice: () => base.loadDevice(),
    async close() {},
  }
}

const plain = v => { try { return structuredClone(v) } catch { return JSON.parse(JSON.stringify(v ?? null)) } }
const errorOf = e => ({ code: e?.code ?? 'error', message: e?.message ?? String(e), status: e?.status })
const randomId = () => hex(globalThis.crypto.getRandomValues(new Uint8Array(12)))

/**
 * Open the stored room for this tab. storage: the room's storage (the leader's). makeStorage(): a second handle on the
 * same stored room for a follower's reads (default: storage itself). Returns the Client's interface (a proxy that
 * follows the swap when this tab becomes the leader), or null when no room is stored.
 */
export async function openRoomInTabs({ storage, makeStorage = () => storage, client: client_name = null, fetch = null, locks = globalThis.navigator?.locks, Channel = globalThis.BroadcastChannel }) {
  if (!locks || !Channel) return openRoom({ storage, client: client_name, fetch })
  const record = await storage.get('room')
  if (!record) return null
  return tabs({ storage, makeStorage, client_name, fetch, locks, Channel, room_id: record.room_id, device_id: record.my_device_id })
}

/**
 * A client made in this tab just now (an account created, a device joined or logged in, not yet started): this tab
 * leads its room from here on (a new device: no other tab has it yet), and later tabs follow it.
 */
export async function adoptInTabs(client, { storage = client.storage, makeStorage = () => storage, client: client_name = null, fetch = null, locks = globalThis.navigator?.locks, Channel = globalThis.BroadcastChannel } = {}) {
  if (!locks || !Channel || client.tabRole) return client
  return tabs({ storage, makeStorage, client_name, fetch, locks, Channel, room_id: client.model.room.room_id, device_id: client.my_device_id, made: client })
}

async function tabs({ storage, makeStorage, client_name, fetch, locks, Channel, room_id, device_id, made = null }) {
  const name = `trommi-room-${room_id}-${device_id}`
  const tabId = randomId()
  const channel = new Channel(name)

  let cur = null                       // the Client in use
  let role = null                      // 'leader' | 'follower'
  let started = null                   // the start() options once the app started it
  const listeners = new Map()          // event -> Set(fn), kept across the swap
  const offs = []
  const pending = new Map()            // this tab's forwarded calls: id -> { method, args, resolve, reject, at, timer }
  const inflight = new Map()           // leader: call id -> Promise (a retry of a running call waits for the same one)

  const attach = c => {
    offs.splice(0).forEach(off => off())
    for (const [event, set] of listeners) for (const fn of set) offs.push(c.on(event, fn))
    if (role === 'leader') offs.push(c.on('change', ch => { if (ch.invites?.size) channel.postMessage({ t: 'invites', invites: plain([...ch.invites].map(id => [id, c.model.invites.get(id) ?? null])) }) }))
  }

  // ---- leader: run a call (own or forwarded) exactly once ----
  const execute = (id, method, args) => {
    if (inflight.has(id)) return inflight.get(id)
    const done = cur.fwdResult?.(id)
    if (done) return Promise.resolve(method === 'saveNote' ? done.object_id : done)
    let p
    cur._fwdId = id                    // _send takes it synchronously (every forwarded action calls it before its first await)
    try { p = Promise.resolve(cur[method](...args)) } catch (e) { p = Promise.reject(e) } finally { cur._fwdId = null }
    inflight.set(id, p)
    while (inflight.size > 1000) inflight.delete(inflight.keys().next().value)
    p.catch(() => inflight.delete(id))   // a refused call may be asked again
    return p
  }

  // ---- follower: forward a call and wait ----
  const send = (id, call) => channel.postMessage({ t: 'call', id, from: tabId, method: call.method, args: call.args })
  const forward = (method, args) => new Promise((resolve, reject) => {
    const id = randomId()
    const call = { method, args: plain(args), resolve, reject, at: Date.now(), timer: null }
    pending.set(id, call)
    const tick = () => {
      if (!pending.has(id)) return
      if (Date.now() - call.at > GIVE_UP_MS) { pending.delete(id); reject(new ZError('timeout', 'the writer tab did not answer')); return }
      if (role === 'leader') return runLocal(id, call)
      send(id, call)
      call.timer = setTimeout(tick, RETRY_MS)
    }
    tick()
  })
  const runLocal = (id, call) => {
    clearTimeout(call.timer)
    execute(id, call.method, call.args).then(v => { pending.delete(id); call.resolve(v) }, e => { pending.delete(id); call.reject(e) })
  }

  channel.onmessage = ({ data: m }) => {
    if (!m || typeof m !== 'object') return
    if (m.t === 'call' && role === 'leader' && cur) {
      execute(m.id, m.method, m.args).then(
        v => channel.postMessage({ t: 'result', id: m.id, to: m.from, ok: true, value: plain(v) }),
        e => channel.postMessage({ t: 'result', id: m.id, to: m.from, ok: false, error: errorOf(e) }))
    } else if (m.t === 'result' && m.to === tabId) {
      const call = pending.get(m.id)
      if (!call) return
      pending.delete(m.id); clearTimeout(call.timer)
      if (m.ok) call.resolve(m.value); else call.reject(new ZError(m.error.code, m.error.message, { status: m.error.status }))
    } else if (m.t === 'leader' && m.tab !== tabId && role === 'follower') {
      for (const [id, call] of pending) send(id, call)   // a new leader: ask it at once
    } else if (m.t === 'invites' && role === 'follower' && cur) {
      // Invites live in the leader (its private invite keys); the follower shows their state as the leader sees it.
      const ch = M.emptyChange()
      for (const [id, pub] of m.invites) { if (pub) cur.model.invites.set(id, pub); else cur.model.invites.delete(id); ch.invites.add(id) }
      cur._emitChange(ch)
    }
  }

  const openLeader = async () => {
    if (made) { const c = made; made = null; if (!c._lockRelease) c.externalLock = true; return c }   // (holding its own lock already: kept)
    const c = await openRoom({ storage, client: client_name, fetch })
    c.externalLock = true
    return c
  }
  const openFollower = async () => {
    const base = makeStorage()
    const st = await overlayStorage(base)
    return openRoom({ storage: st, client: client_name, fetch, follower: true })
  }

  // The lock: at once if free (this tab leads), else wait in line (this tab follows until granted).
  let becameLeader
  const granted = new Promise(r => { becameLeader = r })
  let firstAnswer
  const first = new Promise(r => { firstAnswer = r })
  if (made?._lockRelease) firstAnswer(true)   // a client of this tab that took the lock itself: it leads
  else locks.request(name, { ifAvailable: true }, lock => {
    if (!lock) { firstAnswer(false); return }
    firstAnswer(true); becameLeader()
    return new Promise(() => {})        // held for the tab's life
  }).catch(() => firstAnswer(false))
  const leading = await first
  if (leading) { role = 'leader'; cur = await openLeader() }
  else {
    role = 'follower'
    cur = await openFollower()
    locks.request(name, () => { becameLeader(); return new Promise(() => {}) }).catch(() => {})
  }

  const promote = async () => {
    // Granted the lock: the old leader is gone (closed, crashed, or its tab navigated away). Open the stored room as
    // the writer, swap it in, start it if the app had started the follower, run every call still waiting.
    const old = cur
    const next = await openLeader()
    role = 'leader'
    await old.stop().catch(() => {})
    cur = next
    attach(cur)
    for (const fn of listeners.get('reset') ?? []) { try { fn() } catch (e) { console.error('[tabs] reset', e) } }
    if (started) await cur.start(started[0]).catch(e => { for (const fn of listeners.get('error') ?? []) fn(e) })
    channel.postMessage({ t: 'leader', tab: tabId })
    for (const [id, call] of pending) runLocal(id, call)
  }
  if (role === 'follower') granted.then(() => promote()).catch(e => console.error('[tabs] promote', e))
  else channel.postMessage({ t: 'leader', tab: tabId })

  const own = {
    get tabRole() { return role },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(fn)
      if (event !== 'reset') offs.push(cur.on(event, fn))
      return () => own.off(event, fn)
    },
    off(event, fn) { listeners.get(event)?.delete(fn); cur.off(event, fn) },
    async start(...a) { started = a; return cur.start(...a) },
    async stop() { started = null; return cur.stop() },
  }
  for (const m of FORWARDED) own[m] = (...args) => (role === 'leader' ? execute(randomId(), m, args) : forward(m, args))
  return new Proxy(own, {
    get(target, k) {
      if (k in target) return Reflect.get(target, k)
      const v = cur[k]
      return typeof v === 'function' ? v.bind(cur) : v
    },
    set(target, k, v) { cur[k] = v; return true },
    has(target, k) { return k in target || k in cur },
  })
}
