// core.ts: the core for the client tests: the REAL binding (core/wasm/pkg), with one thing added for the FAKE hub.
// TEST ONLY: it lives under tests/, is never shipped, and the product has no switch that loads it.
//
// Everything is the binding's own, unchanged: devices, MLS groups, Commits, Welcomes, stored content (`seal`,
// `receiveEnvelope`: real envelopes, encrypted and signed), joining by link, recovery, files. Nothing is stood in
// for.
//
// What this file adds: the fake hub (tests/web/stand-in/hub.mjs) checks no cryptography and cannot read MLS, so it
// cannot see who a Commit adds or removes, nor what a founding GroupInfo founds. For that, a TRAILER of facts is
// appended to the real bytes of a Commit and of a founding GroupInfo when the outbox is handed out ({ added,
// removed, agents } and { group, epoch, leaves, session, recovery_signature_key }), and cut off again before the
// binding sees bytes the hub served. The facts are what this device asked the binding for, not what the Commit
// proves. `hubReaders` reads the trailer and, by their layout in spec/v2.md, the real HubAuth (12.3), Offer and
// Reveal (12.1) and an envelope's header (9).
//
// The facts are kept in a SECOND store, given by the test: the binding's state is written first (the binding does
// that), then one atomic write of the facts. A crash between the two leaves a Commit in the outbox without its
// facts; the fake hub then takes it as "no change of members". A failed write of the facts closes the real device
// too, as the binding does on its own failure.
import type * as BindingModule from '../../../core/wasm/js/trommi-core.js'
import type {
  Core, Cut, Device, ErrorCode, InviteConfirmed, LogEntry, OutboxEntry, Processed, ServedCommit, ServedEnvelope, ServedGroup, ServedRoom, Store,
} from '../../../app/web/core/core-api.ts'

export type Binding = typeof BindingModule

// ---- bytes ---------------------------------------------------------------------------------------------------------

const utf8 = new TextEncoder(), text = new TextDecoder('utf-8', { fatal: true })
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
export function b64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[n >> 18]! + B64[(n >> 12) & 63]! + (i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '') + (i + 2 < bytes.length ? B64[n & 63]! : '')
  }
  return out
}
export function unb64(s: string): Uint8Array {
  const out = new Uint8Array(Math.floor((s.length * 3) / 4))
  let bits = 0, acc = 0, at = 0
  for (const c of s) {
    const v = B64.indexOf(c)
    if (v < 0) throw new Error('not base64url')
    acc = (acc << 6) | v; bits += 6
    if (bits >= 8) { bits -= 8; out[at++] = (acc >> bits) & 255 }
  }
  return out
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i])
const ZERO32 = b64(new Uint8Array(32))
const random = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n))

/** SHA-256, synchronous (WebCrypto's is not, and `inviteLinkParse` is). The stand-in's only "hash". */
const K = new Uint32Array(64)
{
  let n = 0
  for (let c = 2; n < 64; c++) { let prime = true; for (let d = 2; d * d <= c; d++) if (c % d === 0) { prime = false; break } if (prime) K[n++] = (Math.cbrt(c) % 1) * 2 ** 32 }
}
export function sha256(data: Uint8Array): Uint8Array {
  const h = Uint32Array.of(0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19)
  const len = data.length, padded = new Uint8Array(((len + 9 + 63) >> 6) << 6)
  padded.set(data); padded[len] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(len / 2 ** 29)); view.setUint32(padded.length - 4, (len << 3) >>> 0)
  const w = new Uint32Array(64), rot = (x: number, n: number) => (x >>> n) | (x << (32 - n))
  for (let at = 0; at < padded.length; at += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(at + i * 4)
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!, b = w[i - 2]!
      w[i] = (w[i - 16]! + (rot(a, 7) ^ rot(a, 18) ^ (a >>> 3)) + w[i - 7]! + (rot(b, 17) ^ rot(b, 19) ^ (b >>> 10))) >>> 0
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) >>> 0
      const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    h[0]! += a; h[1]! += b; h[2]! += c; h[3]! += d; h[4]! += e; h[5]! += f; h[6]! += g; h[7]! += hh
  }
  const out = new Uint8Array(32)
  h.forEach((v, i) => new DataView(out.buffer).setUint32(i * 4, v))
  return out
}
const hashOf = (label: string, ...parts: Uint8Array[]): Uint8Array => sha256(concat(utf8.encode(label), ...parts))

// ---- the trailer of facts on real MLS bytes -----------------------------------------------------------------------

const MAGIC = utf8.encode('TRMF')
function withFacts(bytes: Uint8Array, facts: unknown): Uint8Array {
  const json = utf8.encode(JSON.stringify(facts)), len = new Uint8Array(4)
  new DataView(len.buffer).setUint32(0, json.length)
  return concat(bytes, json, len, MAGIC)
}
/** The real bytes and the facts appended to them; bytes without a trailer are returned as they are. */
export function splitFacts(bytes: Uint8Array): { bytes: Uint8Array; facts: Record<string, unknown> | null } {
  const n = bytes.length
  if (n < 8 || !same(bytes.subarray(n - 4), MAGIC)) return { bytes, facts: null }
  const len = new DataView(bytes.buffer, bytes.byteOffset + n - 8, 4).getUint32(0)
  if (len > n - 8) return { bytes, facts: null }
  try { return { bytes: bytes.slice(0, n - 8 - len), facts: JSON.parse(text.decode(bytes.subarray(n - 8 - len, n - 8))) } } catch { return { bytes, facts: null } }
}

/**
 * Readers for the fake hub (`startFakeHub({ readers: hubReaders })`): the real HubAuth (spec/v2.md 12.3), and the
 * facts this stand-in appended to a Commit and to a founding GroupInfo. Envelopes, Offers and Reveals are the JSON
 * the fake hub reads by default.
 */
export const hubReaders = {
  hubAuth(bytes: Uint8Array): { room_id: string; hub: string; device: string; challenge: string } {
    // struct { opaque room_id[32]; opaque hub<V>; opaque device[32]; opaque challenge[32]; }, <V> a QUIC varint
    const first = bytes[32]!, wide = first >> 6
    const size = 1 << wide
    let len = first & 63
    for (let i = 1; i < size; i++) len = len * 256 + bytes[32 + i]!
    const at = 32 + size
    if (bytes.length !== at + len + 64) throw new Error('not a HubAuth')
    return { room_id: b64(bytes.subarray(0, 32)), hub: text.decode(bytes.subarray(at, at + len)), device: b64(bytes.subarray(at + len, at + len + 32)), challenge: b64(bytes.subarray(at + len + 32)) }
  },
  groupInfo(bytes: Uint8Array): Record<string, unknown> {
    const { facts } = splitFacts(bytes)
    if (!facts) throw new Error('a GroupInfo without the stand-in\'s facts')
    return facts
  },
  commit(bytes: Uint8Array): Record<string, unknown> { return splitFacts(bytes).facts ?? {} },
  envelope: (bytes: Uint8Array): Record<string, unknown> => envelopeHeader(bytes),
  // struct Offer (spec 12.1): room_id[32] invite_id[16] role session_id[16] expires_at(u64) …
  offer(bytes: Uint8Array): { room_id: string; invite_id: string; expires_at: number } {
    if (bytes.length !== 177) throw new Error('not an Offer')
    return { room_id: b64(bytes.subarray(0, 32)), invite_id: b64(bytes.subarray(32, 48)), expires_at: Number(new DataView(bytes.buffer, bytes.byteOffset + 65, 8).getBigUint64(0)) }
  },
  // struct Reveal: invite_id[16] nonce[32] request_hash[32]
  reveal(bytes: Uint8Array): { invite_id: string; request_hash: string } {
    if (bytes.length !== 80) throw new Error('not a Reveal')
    return { invite_id: b64(bytes.subarray(0, 16)), request_hash: b64(bytes.subarray(48, 80)) }
  },
  /** request_hash = RefHash("Trommi Invite Request", Request ‖ mac): SHA-256 over label<V> ‖ value<V> (RFC 9420 5.2). */
  requestHash(request: Uint8Array, mac: Uint8Array): string {
    const label = utf8.encode('Trommi Invite Request'), value = concat(request, mac)
    return b64(sha256(concat(varint(label.length), label, varint(value.length), value)))
  },
}
/** A length as a variable-length integer of RFC 9000 16, as TLS presentation `<V>` writes it. */
function varint(n: number): Uint8Array {
  if (n < 64) return Uint8Array.of(n)
  if (n < 16384) return Uint8Array.of(0x40 | (n >> 8), n & 255)
  return Uint8Array.of(0x80 | (n >>> 24), (n >> 16) & 255, (n >> 8) & 255, n & 255)
}

// ---- an envelope's header, for the fake hub ---------------------------------------------------------------------------

const KINDS = ['', 'item', 'version', 'answer', 'request', 'verdict', 'register', 'takeBack']
const TYPES = ['', 'card', 'note', 'request', 'artifact'], STATES = ['', 'open', 'answered', 'closed'], URGENCIES = ['low', 'normal', 'high', 'critical']
/**
 * The readable header of a real envelope (spec/v2.md 9: `Envelope { form, Header, … }`), in the words the fake hub
 * files by. Nothing is verified: no signature, no chain.
 */
function envelopeHeader(bytes: Uint8Array): Record<string, unknown> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 1                                                // form
  const u8 = (): number => view.getUint8(at++)
  const u64 = (): number => { const v = Number(view.getBigUint64(at)); at += 8; return v }
  const take = (n: number): Uint8Array => { if (at + n > bytes.length) throw new Error('not an envelope'); const out = bytes.subarray(at, at + n); at += n; return out }
  const vector = (): Uint8Array => { const first = view.getUint8(at), size = 1 << (first >> 6); let n = first & 63; for (let i = 1; i < size; i++) n = n * 256 + view.getUint8(at + i); at += size; return take(n) }
  if (u8() !== 2) throw new Error('not an envelope of version 2')
  const kind = KINDS[u8()] ?? 'reserved'
  u8()                                                      // flags
  const group = b64(vector())
  u64()                                                     // epoch
  const sender = b64(take(32)), seq = u64()
  take(32); take(32); u64()                                 // prev, recipient, time
  const out: Record<string, unknown> = { group, sender, seq, kind }
  if (kind === 'item') {
    const tkind = u8(), scope = u8()
    out['timeline'] = { kind: tkind === 2 ? 'board' : 'chat', scope: scope === 1 ? 'card' : scope === 2 ? 'session' : 'desk', ref: b64(take(16)) }
  } else if (kind === 'register') out['register_id'] = b64(take(16))
  else {
    const object_id = b64(take(16)), object_type = TYPES[u8()], object_state = STATES[u8()], urgency = URGENCIES[u8()], answered_at = u64()
    take(32)                                                // object_ref
    out['object'] = { object_id, object_type, object_state, urgency, answered_at }
  }
  const ids = vector(), file_ids: string[] = []
  for (let i = 0; i + 16 <= ids.length; i += 16) file_ids.push(b64(ids.subarray(i, i + 16)))
  out['file_ids'] = file_ids
  return out
}

// ---- the facts' store ------------------------------------------------------------------------------------------------

/** A small key-value state over a store with the core's contract: every flush is one atomic write. */
class State {
  private readonly map = new Map<string, unknown>()
  private readonly dirty = new Set<string>()
  private revision = 0
  private readonly store: Store
  private constructor(store: Store) { this.store = store }
  static async load(store: Store): Promise<State> {
    const s = new State(store)
    const stored = await store.load()
    s.revision = stored.revision
    for (const e of stored.entries) s.map.set(text.decode(e.key), JSON.parse(text.decode(e.value)))
    return s
  }
  get<T>(key: string): T | undefined { return this.map.get(key) as T | undefined }
  set(key: string, value: unknown): void { this.map.set(key, value); this.dirty.add(key) }
  delete(key: string): void { if (this.map.delete(key)) this.dirty.add(key) }
  async flush(): Promise<void> {
    if (!this.dirty.size) return
    const put = [], del = []
    for (const key of this.dirty) {
      if (this.map.has(key)) put.push({ key: utf8.encode(key), value: utf8.encode(JSON.stringify(this.map.get(key))) })
      else del.push(utf8.encode(key))
    }
    await this.store.apply({ expectedRevision: this.revision, put, delete: del })
    this.revision += 1
    this.dirty.clear()
  }
  async close(): Promise<void> { await this.store.close?.() }
}

/** What a confirmed invite's Commit does, for the fake hub: kept so that the Commit built again says the same. */
interface InviteFacts { added?: string[]; agents?: string[]; removed?: string[] }

const bare = (g: ServedGroup): ServedGroup => ({ founding: splitFacts(g.founding).bytes, current: splitFacts(g.current).bytes, commits: g.commits.map(c => ({ ...c, commit: splitFacts(c.commit).bytes })) })
const bareRoom = (r: ServedRoom): ServedRoom => ({ ...r, group: bare(r.group), anchor: splitFacts(r.anchor).bytes, sessions: r.sessions.map(bare) })

function makeDevice(binding: Binding, raw: BindingModule.Device, state: State): Device {
  const refuse = (code: ErrorCode, what: string): never => { throw new binding.TrommiError(code, `${code}: ${what}`) }
  let tail: Promise<unknown> = Promise.resolve()
  let closed = false
  /** One call after another; the facts it noted are written before the result is handed out. */
  function run<T>(work: () => Promise<T>): Promise<T> {
    const job = tail.then(async () => {
      if (closed) refuse('internal', 'the device is closed')
      let result: T | undefined, failure: unknown = null, failed = false
      try { result = await work() } catch (e) { failure = e; failed = true }
      try { await state.flush() } catch (e) {
        closed = true
        await raw.close().catch(() => {})
        await state.close().catch(() => {})
        throw new binding.TrommiError('storage', `storage: ${e instanceof Error ? e.message : 'the facts\' store failed'}`)
      }
      if (failed) throw failure
      return result as T
    })
    tail = job.catch(() => {})
    return job
  }
  /** Remembers the facts of the outbox entry `id`: per part index, what the fake hub shall read there. */
  const note = (id: number, parts: Record<number, unknown>): void => state.set(`facts/${id}`, parts)
  const me = async (): Promise<string> => b64(await raw.id())
  const forget = async (id: number): Promise<void> => { if (!(await raw.outbox()).some(e => e.id === id)) state.delete(`facts/${id}`) }

  let removals: { group: string; devices: string[] }[] = []

  const device = {
    close: async (): Promise<void> => { await run(async () => {}).catch(() => {}); closed = true; await raw.close(); await state.close() },
    outbox: () => run(async (): Promise<OutboxEntry[]> => (await raw.outbox()).map(e => {
      const f = state.get<Record<number, unknown>>(`facts/${e.id}`)
      // a Commit without facts (the gap between the two stores) still gets a trailer: "no change of members"
      const fallback: Record<number, unknown> = e.kind === 'commit' || e.kind === 'externalCommit' || e.kind === 'recoveryCommit' || e.kind === 'recoveryCode' ? { 0: {} } : e.kind === 'groupFounding' ? { 2: {} } : {}
      return { ...e, parts: e.parts.map((p, i) => { const fact = (f ?? fallback)[i]; return fact === undefined ? p : withFacts(p, fact) }) }
    })),
    outboxAccepted: (id: number, change?: number | null) => run(async () => { await raw.outboxAccepted(id, change); await forget(id) }),
    outboxRefused: (id: number, code: ErrorCode) => run(async () => { await raw.outboxRefused(id, code); await forget(id) }),

    foundRoom: (code: Uint8Array, nowMs: number) => run(async () => {
      const room = await raw.foundRoom(code, nowMs)
      const roles = await raw.roomRoles(), entry = (await raw.outbox()).find(e => e.kind === 'roomFounding')
      if (entry) note(entry.id, { 0: { group: b64(room), epoch: 0, leaves: [await me()], recovery_signature_key: roles ? b64(roles.recoverySignatureKey) : null } })
      return room
    }),
    foundSession: (agent: Uint8Array, keyPackages: Uint8Array[], nowMs: number) => run(async () => {
      const session = await raw.foundSession(agent, keyPackages, nowMs)
      const g = b64(binding.sessionGroupId((await raw.room())!, session))
      const entry = (await raw.outbox()).find(e => e.kind === 'groupFounding' && e.group !== null && b64(e.group) === g)
      if (entry) note(entry.id, { 0: { group: g, epoch: 0, leaves: [await me()], session: { session_id: b64(session), parent: null } }, 2: { added: keyPackages.map(p => b64(binding.keyPackageInfo(p).device)) } })
      return session
    }),
    foundHelper: (parent: Uint8Array, keyPackages: Uint8Array[], nowMs: number) => run(async () => {
      const session = await raw.foundHelper(parent, keyPackages, nowMs)
      const g = b64(binding.sessionGroupId((await raw.room())!, session))
      const entry = (await raw.outbox()).find(e => e.kind === 'groupFounding' && e.group !== null && b64(e.group) === g)
      if (entry) note(entry.id, { 0: { group: g, epoch: 0, leaves: [await me()], session: { session_id: b64(session), parent: b64(parent) } }, 2: { added: keyPackages.map(p => b64(binding.keyPackageInfo(p).device)) } })
      return session
    }),
    addToSession: (g: Uint8Array, d: Uint8Array, keyPackage: Uint8Array, nowMs: number) => run(async () => { const id = await raw.addToSession(g, d, keyPackage, nowMs); note(id, { 0: { added: [b64(d)] } }); return id }),
    removeAgents: (remove: Uint8Array[], nowMs: number) => run(async () => { const id = await raw.removeAgents(remove, nowMs); note(id, { 0: { removed: remove.map(b64) } }); return id }),
    removeHumanDevices: (cuts: Cut[], nowMs: number) => run(async () => { const id = await raw.removeHumanDevices(cuts, nowMs); note(id, { 0: { removed: cuts.map(c => b64(c.device)) } }); return id }),
    cleanSession: (g: Uint8Array, cuts: Cut[], replacement: { device: Uint8Array; keyPackage: Uint8Array } | null | undefined, nowMs: number) => run(async () => {
      const id = await raw.cleanSession(g, cuts, replacement, nowMs)
      note(id, { 0: { removed: cuts.map(c => b64(c.device)), added: replacement ? [b64(replacement.device)] : [] } })
      return id
    }),
    observeRoom: (groupInfo: Uint8Array, expected?: Uint8Array | null) => run(() => raw.observeRoom(splitFacts(groupInfo).bytes, expected)),
    observeSession: (groupInfo: Uint8Array) => run(() => raw.observeSession(splitFacts(groupInfo).bytes)),
    joinObserve: (groupInfo: Uint8Array) => run(() => raw.joinObserve(splitFacts(groupInfo).bytes)),
    processLogEntry: (entry: LogEntry, nowMs: number) => run((): Promise<Processed> => raw.processLogEntry({ ...entry, bytes: splitFacts(entry.bytes).bytes }, nowMs)),
    learnHistory: (g: Uint8Array, founding: Uint8Array, commits: ServedCommit[]) => run(() => raw.learnHistory(g, splitFacts(founding).bytes, commits.map(c => ({ ...c, commit: splitFacts(c.commit).bytes })))),
    verifyFounding: (g: Uint8Array, served: ServedGroup) => run(() => raw.verifyFounding(g, bare(served))),

    inviteConfirm: (inviteId: Uint8Array, code: Uint8Array, requestHash: Uint8Array, matches: boolean, nowMs: number) => run(async () => {
      // an agent that takes a session over: the Commit that enrols it takes the seat's agent out of `agents`
      const roles = await raw.roomRoles(), groups = await raw.groups()
      const confirmed: InviteConfirmed | null = await raw.inviteConfirm(inviteId, code, requestHash, matches, nowMs)
      if (!confirmed) return confirmed
      const newcomer = b64(confirmed.newDevice)
      let f: InviteFacts = { added: [newcomer] }
      if (confirmed.role === 'agent') {
        const seat = confirmed.sessionId ? groups.find(g => g.session && same(g.session.sessionId, confirmed.sessionId!)) : null
        f = { agents: [newcomer], removed: (seat?.leaves ?? []).filter(l => (roles?.agents ?? []).some(a => same(a, l))).map(b64) }
      }
      state.set(`invite/${b64(inviteId)}`, f)
      note(confirmed.outboxId, { 0: f })
      return confirmed
    }),
    inviteRecommit: (inviteId: Uint8Array, nowMs: number) => run(async () => {
      const id = await raw.inviteRecommit(inviteId, nowMs)
      note(id, { 0: state.get<InviteFacts>(`invite/${b64(inviteId)}`) ?? {} })
      return id
    }),

    // recovery: who a join or a recovery brings in and takes out
    joinRoomWithCode: (code: Uint8Array, served: ServedRoom, nowMs: number) => run(async () => {
      const done = await raw.joinRoomWithCode(code, bareRoom(served), nowMs)
      for (const id of done.outbox) note(id, { 0: { added: [await me()] } })
      return done
    }),
    joinSessionWithCode: (code: Uint8Array, served: ServedGroup, nowMs: number) => run(async () => {
      const id = await raw.joinSessionWithCode(code, bare(served), nowMs)
      note(id, { 0: { added: [await me()] } })
      return id
    }),
    // (the plan's removals are kept for the facts of `recover`: preparing again would make another new code)
    prepareRecovery: (code: Uint8Array, served: ServedRoom) => run(async () => {
      const plan = await raw.prepareRecovery(code, bareRoom(served))
      removals = plan.removals.map(r => ({ group: b64(r.group), devices: r.devices.map(b64) }))
      return plan
    }),
    recover: (code: Uint8Array, served: ServedRoom, chains: ServedEnvelope[], account: Uint8Array, nowMs: number) => run(async () => {
      const done = await raw.recover(code, bareRoom(served), chains, account, nowMs)
      const entries = await raw.outbox()
      for (const id of done.outbox) {
        const entry = entries.find(e => e.id === id)
        if (entry?.kind !== 'recoveryCommit' || !entry.group) continue
        note(id, { 0: { added: [await me()], removed: removals.find(r => r.group === b64(entry.group!))?.devices ?? [] } })
      }
      return done
    }),
  } as Record<string, unknown>
  // every other call of the binding's device is passed through as it is
  const real = raw as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
  for (const name of Object.getOwnPropertyNames(binding.Device.prototype)) {
    if (name === 'constructor' || name in device || typeof real[name] !== 'function') continue
    device[name] = (...args: unknown[]) => run(() => real[name]!(...args))
  }
  return device as unknown as Device
}

/**
 * The tests' core over the loaded binding. `stateStore`: the facts' own store for the device kept in `deviceStore`
 * (a second store with the same contract; see the header for what two stores cost).
 */
export function standInCore(binding: Binding, opts: { stateStore(deviceStore: Store): Store }): Core {
  const { init: _init, Device: _Device, TrommiError: _TrommiError, StoreConflict: _StoreConflict, ...stateless } = binding
  const open = async (how: 'create' | 'open', store: Store): Promise<Device> => {
    const raw = await binding.Device[how](store)
    let state: State
    try { state = await State.load(opts.stateStore(store)) }
    catch (e) { await raw.close().catch(() => {}); throw new binding.TrommiError('storage', `storage: ${e instanceof Error ? e.message : 'the facts\' store did not load'}`) }
    return makeDevice(binding, raw, state)
  }
  return {
    ...stateless,
    createDevice: store => open('create', store),
    openDevice: store => open('open', store),
    errorCode: (error: unknown) => (error instanceof binding.TrommiError ? error.code : null),
  }
}

/** The binding as Node loads it: the same module and .wasm a browser gets (core/wasm/pkg, built by core/wasm/build.sh). */
export async function loadBinding(): Promise<Binding> {
  const { pathToFileURL } = await import('node:url')
  // TROMMI_CORE_PKG: another build of the binding (a directory), for a core that is not merged into this tree yet
  const other = process.env['TROMMI_CORE_PKG']
  const pkg = other ? pathToFileURL(other.endsWith('/') ? other : `${other}/`) : new URL('../../../core/wasm/pkg/', import.meta.url)
  const [binding, fs] = await Promise.all([import(new URL('trommi-core.js', pkg).href) as Promise<Binding>, import('node:fs')])
  await binding.init(fs.readFileSync(new URL('trommi_core_wasm_bg.wasm', pkg)))
  return binding
}
