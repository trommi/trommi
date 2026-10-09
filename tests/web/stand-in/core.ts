// core.ts: a STAND-IN for the Rust core as the web app sees it (app/web/core/core-api.ts `Core`). TEST ONLY: it lives
// under tests/, is never shipped, and the product has no switch that loads it (a test hands it to the engine, or
// bundles a worker with this file's `loadCore` in the place of core-wasm.ts).
//
// It is a HYBRID, to be as real as a test can be today:
//
// REAL (the WASM binding, core/wasm/pkg, unchanged): the device and its key, every MLS group, Commits, Welcomes,
// `processLogEntry`, the key handover, the work trail, KeyPackages, the hub sign-in, the binding's outbox and
// cursor, recovery and signing in with the code, files, share links, the account's functions. Their bytes are the real ones.
//
// STAND-IN (this file, NO cryptography), for what core-api.ts calls PROVISIONAL:
// - Stored content: `seal`, `receiveEnvelope`, `headsDue`, `cutOf`. An "envelope" is plain UTF-8 JSON in the shape
//   the fake hub's default reader takes (tests/web/stand-in/hub.mjs), nothing is encrypted or signed. Its hash is
//   the SHA-256 of its bytes. What is kept honestly: one chain per sender and group (seq, prev; replay, gap,
//   equivocation, chain-break), the object state of spec/v2.md 9.2.1 replayed from headers, who may write what
//   (9.2) by the roles the REAL groups give, the register rule of 9.3.2, Cuts from the real Commits (9.0.10), and
//   "no key, no body": a body is handed out only if the real device holds the content key of that group and epoch
//   (so a key handover is what makes history readable, as in the product). Not kept: signatures, freshness
//   (9.0.5 check 8), the lamport wrap of 9.3.2, the leaves of past epochs: a sender counts as a member if this
//   device ever saw it as a leaf, or holds the key of the envelope's epoch; a sender it never saw is a human
//   device in the room group, and in a session group its role is not judged.
//   READING BACK, as this stand-in defines it and the engine relies on it: `receiveEnvelope(…, ordered = false)` of
//   an envelope the chain already holds answers `applied` (or what it was) with the object state stored for it, and
//   with its body if the key is there now.
// - Stroke pieces: `sendStrokePiece` and `receiveRelay` are stand-ins too (plain JSON). The binding seals a piece,
//   but it can take a relayed message only through `processLogEntry`, which wants a change number above its cursor
//   and moves the cursor to it; a relayed message has none.
// - Joining by link: `inviteOpen`, `inviteAccept`, `inviteConfirm`, `joinRequest`, `joinReveal` make JSON Offer,
//   Request and Reveal with made-up "signatures" and a MAC that is a hash. The check code is derived from Offer,
//   Request, MAC and nonce, so both sides show the same six numbers. What follows is REAL: `addHumanDevice` or
//   `changeAgents` with the Request's real KeyPackage, and the newcomer's real `joinWelcome`.
// - Recovery is NOT stood in for: it is the binding's own (spec 8). This file only cuts its trailers (below) off
//   what the fake hub serves before the binding sees it.
// - `inviteLinkParse`, `checkEmoji`, `hubAddress`, `boardReduce` (scribble.ts `reduceBoard`).
//
// For the fake hub, which reads a GroupInfo and a Commit as JSON: this stand-in appends a TRAILER of facts to the
// real bytes of a Commit and of a founding GroupInfo when it hands out the outbox ({ added, removed, agents } and
// { group, epoch, leaves, session, recovery_signature_key }), and cuts it off again before the binding sees the
// bytes. `hubReaders` reads the trailer, and the real HubAuth. The facts are what this device asked the binding
// for, not what the Commit proves: the fake hub checks no cryptography anyway.
//
// The stand-in's own state (chains, objects, registers, invites, its outbox, the facts) lives in a SECOND store,
// given by the test. Each call writes the binding's state first (the binding does), then one atomic write of the
// stand-in's. THE GAP versus the real core: these are two transactions, not one. A crash between them leaves the
// binding ahead (a Commit in the outbox without its facts: the fake hub then takes it as "no change of members").
// A failed write of the stand-in's store closes the real device too, as the binding does on its own failure.
import type * as BindingModule from '../../../core/wasm/js/trommi-core.js'
import type {
  Bind, Core, Cut, Device, Draft, EnvelopeHeader, EnvelopeKind, ErrorCode, GroupSummary, InviteLinkParts, InviteRole, LogEntry, ObjectState, ObjectType,
  GroupCut, OutboxEntry, Processed, ReceivedEnvelope, ReceivedMessage, RoomRoles, Sealed, ServedGroup, ServedRoom, Store, Urgency,
} from '../../../app/web/core/core-api.ts'
import { CHECK_EMOJI } from '../../../app/web/core/check-emoji.ts'
import { hubAddress } from '../../../app/web/core/hub.ts'
import { reduceBoard } from '../../../app/web/core/scribble.ts'
import type { BoardItem, BoardState } from '../../../app/web/core/scribble.ts'

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
}

// ---- the stand-in's own stored state -------------------------------------------------------------------------------

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
  keys(prefix: string): string[] { return [...this.map.keys()].filter(k => k.startsWith(prefix)) }
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

// ---- envelopes as the stand-in writes them --------------------------------------------------------------------------

/** The JSON of a stand-in envelope. Ids and hashes are base64url; the names the fake hub reads are its own. */
interface Wire {
  v: 2; group: string; session_id: string | null; epoch: number; sender: string; seq: number; prev: string; recipient: string | null; time: number
  kind: EnvelopeKind; push: boolean
  timeline?: { kind: 'chat' | 'board'; scope: 'card' | 'session' | 'desk'; ref: string }
  register_id?: string
  object?: { object_id: string; object_type: ObjectType; object_state: ObjectState; urgency: Urgency; answered_at: number; object_ref: string }
  file_ids: string[]
  bind: WireBind | null
  /** The body's payload, base64url of its JSON. */
  payload: string
}
type WireBind =
  | { kind: 'answer'; object_id: string; version_hash: string; choices: string[] }
  | { kind: 'request'; request_id: string; expires_at: number }
  | { kind: 'verdict'; request_id: string; request_hash: string; expires_at: number; allow: boolean }
  | { kind: 'takeBack'; object_id: string; previous_hash: string; version_hash: string }

function headerOf(w: Wire, change: number, hash: Uint8Array): EnvelopeHeader {
  const o = w.object
  return {
    change, envelopeHash: hash, group: unb64(w.group), sessionId: w.session_id ? unb64(w.session_id) : null, epoch: w.epoch, sender: unb64(w.sender), seq: w.seq,
    recipient: w.recipient ? unb64(w.recipient) : null, time: w.time, kind: w.kind, push: w.push,
    timeline: w.timeline ? { kind: w.timeline.kind, scope: w.timeline.scope, ref: unb64(w.timeline.ref) } as EnvelopeHeader['timeline'] : null,
    registerId: w.register_id ? unb64(w.register_id) : null,
    object: o ? { objectId: unb64(o.object_id), objectType: o.object_type, objectState: o.object_state, urgency: o.urgency, answeredAt: o.answered_at, objectRef: o.object_ref === ZERO32 ? null : unb64(o.object_ref) } : null,
    fileIds: w.file_ids.map(unb64),
  }
}
function bindOf(b: WireBind | null): Bind | null {
  if (!b) return null
  switch (b.kind) {
    case 'answer': return { kind: 'answer', objectId: unb64(b.object_id), versionHash: unb64(b.version_hash), choices: b.choices }
    case 'request': return { kind: 'request', requestId: unb64(b.request_id), expiresAt: b.expires_at }
    case 'verdict': return { kind: 'verdict', requestId: unb64(b.request_id), requestHash: unb64(b.request_hash), expiresAt: b.expires_at, allow: b.allow }
    case 'takeBack': return { kind: 'takeBack', objectId: unb64(b.object_id), previousHash: unb64(b.previous_hash), versionHash: unb64(b.version_hash) }
  }
}
/** `object_id` of an object's first version: derived from group, sender and number, as section 9 derives it. */
const objectIdOf = (group: string, sender: string, seq: number): string => b64(hashOf('Trommi Object', unb64(group), unb64(sender), utf8.encode(String(seq))).subarray(0, 16))

/** What the stand-in keeps per object (9.2.1). */
interface Obj { group: string; type: ObjectType; owner: string; state: ObjectState; current: string; urgency: Urgency; answer: string | null; expires_at: number; rank?: [number, string, number] }
/** What it keeps per accepted envelope, for reading back. */
interface Seen { g: string; s: string; q: number; code: ErrorCode | null; after: { owner: string; state: ObjectState; current: string; object_id: string } | null; reg: string | null }
interface Chain { seq: number; hash: string }
interface OwnEntry { id: number; after: number; kind: 'envelope' | 'relayMessage'; group: string; epoch: number; bytes: string }
interface Invite {
  secret: string; nonce: string; role: InviteRole; session_id: string | null; offer: string; expires_at: number; hub: string
  used: { device: string; key_package: string; request_hash: string; code: number[] } | null; burned: boolean
}
interface Joining { invite_id: string; secret: string; offer: string; request: string; mac: string; inviter: string }

/** What an agent or helper device writes; the web app's `Draft` (core-api.ts) has only a human's items. For the
 *  agent stand-in (tests/web/stand-in/agent.ts). */
export type AgentDraft =
  | { kind: 'objectFirst'; session: Uint8Array; objectType: 'card' | 'request' | 'artifact'; urgency: Urgency; push: boolean; expiresAt?: number; payload: Uint8Array }
  | { kind: 'objectVersion'; session: Uint8Array; objectId: Uint8Array; closed: boolean; urgency: Urgency; push: boolean; payload: Uint8Array }

/** What the stand-in's device has beside core-api.ts's `Device`. The first three are what the engine needs of the
 *  real core and core-api.ts does not name yet (see the engine's header); `sealAgent` is for the agent stand-in. */
export interface StandInExtras {
  /** A relayed application message (a stroke piece, 7.2): not in the log, no change number. Null: not readable. */
  receiveRelay(group: Uint8Array, epoch: number, sender: Uint8Array, message: Uint8Array, nowMs: number): Promise<ReceivedMessage | null>
  sealAgent(draft: AgentDraft, fileIds: Uint8Array[], nowMs: number): Promise<Sealed>
}
export type StandInDevice = Device & StandInExtras

const OWN_IDS = 2 ** 40
const INVITE_MS = 600_000

class CoreMissing extends Error {
  readonly code = 'core-missing'
  constructor(call: string) { super(`core-missing: the stand-in core does not build ${call} (see its header)`); this.name = 'CoreMissing' }
}

function makeDevice(binding: Binding, raw: BindingModule.Device, state: State): StandInDevice {
  const refuse = (code: ErrorCode, what: string): never => { throw new binding.TrommiError(code, `${code}: ${what}`) }
  let tail: Promise<unknown> = Promise.resolve()
  let closed = false
  /** One call after another; what the stand-in changed is written before the result is handed out. A failed write
   *  closes the real device as well: its state is then ahead of the stand-in's. */
  function run<T>(work: () => Promise<T>): Promise<T> {
    const job = tail.then(async () => {
      if (closed) refuse('internal', 'the device is closed')
      let result: T | undefined, failure: unknown = null, failed = false
      try { result = await work() } catch (e) { failure = e; failed = true }
      try { await state.flush() } catch (e) {
        closed = true
        await raw.close().catch(() => {})
        await state.close().catch(() => {})
        throw new binding.TrommiError('storage', `storage: ${e instanceof Error ? e.message : 'the stand-in\'s store failed'}`)
      }
      if (failed) throw failure
      return result as T
    })
    tail = job.catch(() => {})
    return job
  }

  // what the real groups say, kept until a call may have changed it
  let known: { groups: Map<string, GroupSummary>; roles: RoomRoles | null; me: string; room: string | null } | null = null
  const fresh = (): void => { known = null }
  async function facts(): Promise<NonNullable<typeof known>> {
    if (known) return known
    const [groups, roles, me, room] = await Promise.all([raw.groups(), raw.roomRoles(), raw.id(), raw.room()])
    known = { groups: new Map(groups.map(g => [b64(g.group), g])), roles, me: b64(me), room: room ? b64(room) : null }
    // every leaf and human device this device ever saw: a removed sender's old envelopes keep their standing
    const ever = new Set(state.get<string[]>('ever/humans') ?? [])
    const before = ever.size
    for (const h of roles?.humans ?? []) ever.add(b64(h))
    if (ever.size !== before) state.set('ever/humans', [...ever])
    for (const g of groups) {
      const key = `ever/leaves/${b64(g.group)}`, leaves = new Set(state.get<string[]>(key) ?? []), had = leaves.size
      for (const l of g.leaves) leaves.add(b64(l))
      if (leaves.size !== had) state.set(key, [...leaves])
    }
    return known
  }
  const isHuman = (device: string): boolean => (state.get<string[]>('ever/humans') ?? []).includes(device)
  const wasLeaf = (group: string, device: string): boolean => (state.get<string[]>(`ever/leaves/${group}`) ?? []).includes(device)
  const cursorOf = (): number => state.get<number>('cursor') ?? 0
  const reach = (change: number): void => { if (change > cursorOf()) state.set('cursor', change) }

  async function hasKey(group: string, epoch: number): Promise<boolean> {
    try { await raw.contentKey(unb64(group), epoch); return true } catch { return false }
  }

  // ---- the binding's outbox with facts, and the stand-in's own entries

  /** Remembers the facts of the outbox entry `id`: per part index, what the fake hub shall read there. */
  const note = (id: number, parts: Record<number, unknown>): void => state.set(`facts/${id}`, parts)
  async function newest(): Promise<number> { return (await raw.outbox()).reduce((m, e) => Math.max(m, e.id), state.get<number>('binding-id') ?? 0) }
  async function outbox(): Promise<OutboxEntry[]> {
    const real = (await raw.outbox()).map(e => {
      const f = state.get<Record<number, unknown>>(`facts/${e.id}`)
      // a Commit without facts (the gap between the two stores) still gets a trailer: "no change of members"
      const fallback: Record<number, unknown> = e.kind === 'commit' || e.kind === 'externalCommit' ? { 0: {} } : e.kind === 'groupFounding' ? { 2: {} } : {}
      const parts = e.parts.map((p, i) => { const fact = (f ?? fallback)[i]; return fact === undefined ? p : withFacts(p, fact) })
      return { ...e, parts }
    })
    const own = state.keys('out/').map(k => state.get<OwnEntry>(k)!).sort((a, b) => a.id - b.id)
    const out: OutboxEntry[] = []
    let at = 0
    for (const o of own) {
      while (at < real.length && real[at]!.id <= o.after) out.push(real[at++]!)
      out.push({ id: o.id, kind: o.kind, group: unb64(o.group), epoch: o.epoch, parts: [unb64(o.bytes)] })
    }
    return out.concat(real.slice(at))
  }
  async function queue(kind: OwnEntry['kind'], group: string, epoch: number, bytes: Uint8Array): Promise<number> {
    const n = (state.get<number>('own-id') ?? 0) + 1
    state.set('own-id', n)
    const after = await newest()
    state.set('binding-id', after)
    const entry: OwnEntry = { id: OWN_IDS + n, after, kind, group, epoch, bytes: b64(bytes) }
    state.set(`out/${entry.id}`, entry)
    return entry.id
  }

  // ---- sealing

  async function group(id: string): Promise<GroupSummary> {
    const g = (await facts()).groups.get(id)
    return g ?? refuse('not-found', 'this device is no member of that group')
  }
  const lamportOf = (g: string): number => state.get<number>(`lamport/${g}`) ?? 0
  function registerId(g: string, name: string): string {
    const key = `regid/${g}/${name}`
    let id = state.get<string>(key)
    if (!id) { id = b64(random(16)); state.set(key, id) }
    return id
  }
  async function sealWire(g: string, make: (seq: number, me: string) => Omit<Wire, 'v' | 'group' | 'session_id' | 'epoch' | 'sender' | 'seq' | 'prev' | 'time'>, nowMs: number): Promise<Sealed> {
    const k = await facts(), summary = await group(g)
    const own = state.get<Chain>(`own/${g}`) ?? { seq: 0, hash: ZERO32 }
    const seq = own.seq + 1
    const w: Wire = { v: 2, group: g, session_id: summary.session ? b64(summary.session.sessionId) : null, epoch: summary.epoch, sender: k.me, seq, prev: own.hash, time: nowMs, ...make(seq, k.me) }
    const bytes = utf8.encode(JSON.stringify(w)), hash = sha256(bytes)
    state.set(`own/${g}`, { seq, hash: b64(hash) })
    const outboxId = await queue('envelope', g, summary.epoch, bytes)
    return { outboxId, envelopeHash: hash, seq, group: unb64(g), objectId: w.object ? unb64(w.object.object_id) : null, time: nowMs }
  }
  const sessionGroup = async (session: Uint8Array): Promise<string> => b64(binding.sessionGroupId(unb64((await facts()).room ?? refuse('no-room', 'this device has no room')), session))
  const roomGroup = async (): Promise<string> => (await facts()).room ?? refuse('no-room', 'this device has no room')
  const obj = (id: string): Obj => state.get<Obj>(`obj/${id}`) ?? refuse('not-found', 'no such object')

  async function seal(draft: Draft, recipient: Uint8Array | null, fileIds: Uint8Array[], nowMs: number): Promise<Sealed> {
    const to = recipient ? b64(recipient) : null, file_ids = fileIds.map(b64), payload = (p: Uint8Array) => b64(p)
    switch (draft.kind) {
      case 'sessionChat': return sealWire(await sessionGroup(draft.session), () => ({ kind: 'item', push: false, recipient: to, timeline: { kind: 'chat', scope: 'session', ref: b64(draft.session) }, file_ids, bind: null, payload: payload(draft.payload) }), nowMs)
      case 'cardChat': return sealWire(await sessionGroup(draft.session), () => ({ kind: 'item', push: false, recipient: to, timeline: { kind: 'chat', scope: 'card', ref: b64(draft.card) }, file_ids, bind: null, payload: payload(draft.payload) }), nowMs)
      case 'boardItem': return sealWire(await roomGroup(), () => ({ kind: 'item', push: false, recipient: to, timeline: { kind: 'board', scope: 'desk', ref: b64(draft.board) }, file_ids, bind: null, payload: payload(draft.payload) }), nowMs)
      case 'register': {
        const g = b64(draft.group), lamport = lamportOf(g) + 1
        state.set(`lamport/${g}`, lamport)
        const body = { name: draft.name, value: draft.value ? JSON.parse(text.decode(draft.value)) : null, lamport }
        return sealWire(g, () => ({ kind: 'register', push: false, recipient: to, register_id: registerId(g, draft.name), file_ids, bind: null, payload: b64(utf8.encode(JSON.stringify(body))) }), nowMs)
      }
      case 'noteFirst': {
        const g = await roomGroup()
        return sealWire(g, (seq, me) => ({ kind: 'version', push: false, recipient: to, file_ids, bind: null, payload: payload(draft.payload),
          object: { object_id: objectIdOf(g, me, seq), object_type: 'note', object_state: 'open', urgency: 'normal', answered_at: 0, object_ref: ZERO32 } }), nowMs)
      }
      case 'noteVersion': {
        const id = b64(draft.objectId), o = obj(id)
        return sealWire(o.group, () => ({ kind: 'version', push: false, recipient: to, file_ids, bind: null, payload: payload(draft.payload),
          object: { object_id: id, object_type: 'note', object_state: draft.closed ? 'closed' : 'open', urgency: 'normal', answered_at: 0, object_ref: o.current } }), nowMs)
      }
      case 'answer': {
        const id = b64(draft.objectId), o = obj(id)
        return sealWire(o.group, () => ({ kind: 'answer', push: false, recipient: to, file_ids, payload: payload(draft.payload),
          bind: { kind: 'answer', object_id: id, version_hash: o.current, choices: draft.choices },
          object: { object_id: id, object_type: 'card', object_state: draft.closes ? 'closed' : 'answered', urgency: o.urgency, answered_at: nowMs, object_ref: o.current } }), nowMs)
      }
      case 'takeBack': {
        const id = b64(draft.objectId), o = obj(id)
        if (!o.answer) refuse('forbidden', 'no answer in force to take back')
        return sealWire(o.group, () => ({ kind: 'takeBack', push: false, recipient: to, file_ids, payload: payload(draft.payload),
          bind: { kind: 'takeBack', object_id: id, previous_hash: o.answer!, version_hash: o.current },
          object: { object_id: id, object_type: 'card', object_state: 'open', urgency: o.urgency, answered_at: 0, object_ref: o.current } }), nowMs)
      }
      case 'verdict': {
        const id = b64(draft.requestId), o = obj(id)
        return sealWire(o.group, () => ({ kind: 'verdict', push: false, recipient: to, file_ids, payload: payload(draft.payload),
          bind: { kind: 'verdict', request_id: id, request_hash: o.current, expires_at: o.expires_at, allow: draft.allow },
          object: { object_id: id, object_type: 'request', object_state: 'closed', urgency: o.urgency, answered_at: nowMs, object_ref: o.current } }), nowMs)
      }
    }
  }
  async function sealAgent(draft: AgentDraft, fileIds: Uint8Array[], nowMs: number): Promise<Sealed> {
    const g = await sessionGroup(draft.session), file_ids = fileIds.map(b64)
    if (draft.kind === 'objectFirst') {
      const request = draft.objectType === 'request'
      return sealWire(g, (seq, me) => {
        const object_id = objectIdOf(g, me, seq)
        return { kind: request ? 'request' : 'version', push: draft.push, recipient: null, file_ids, payload: b64(draft.payload),
          bind: request ? { kind: 'request', request_id: object_id, expires_at: draft.expiresAt ?? 0 } : null,
          object: { object_id, object_type: draft.objectType, object_state: 'open', urgency: draft.urgency, answered_at: 0, object_ref: ZERO32 } }
      }, nowMs)
    }
    const id = b64(draft.objectId), o = obj(id)
    return sealWire(g, () => ({ kind: 'version', push: draft.push, recipient: null, file_ids, bind: null, payload: b64(draft.payload),
      object: { object_id: id, object_type: o.type, object_state: draft.closed ? 'closed' : 'open', urgency: draft.urgency, answered_at: 0, object_ref: o.current } }), nowMs)
  }

  // ---- receiving

  /** Check 7 for what the sender's role alone decides, and the object's state (9.2.1). Returns the object after the
   *  envelope, null for an item or a register, or 'forbidden'. Changes the stored object. */
  function judge(w: Wire, hash: string, change: boolean): Seen['after'] | 'forbidden' {
    const room = w.session_id === null
    // The sender's role: by what this device saw of it. A sender it never saw as a member (it left before this
    // device came) wrote in the room group as a human device, since only those are its leaves; in a session group
    // its role is not known here and is not judged.
    const seen = wasLeaf(w.group, w.sender), asHuman = isHuman(w.sender)
    const human = asHuman || (!seen && room), agent = seen ? !asHuman : !room
    if (w.kind === 'item') return (w.timeline?.kind === 'board' ? room && human : !room) ? null : 'forbidden'
    if (w.kind === 'register') return room && !human ? 'forbidden' : null
    const o = w.object
    if (!o) return 'forbidden'
    const key = `obj/${o.object_id}`
    const held = state.get<Obj>(key)
    const put = (next: Obj): Seen['after'] => { if (change) state.set(key, next); return { owner: next.owner, state: next.state, current: next.current, object_id: o.object_id } }
    if (w.kind === 'version' || w.kind === 'request') {
      const note = o.object_type === 'note'
      if (note ? !(room && human) : room || !agent) return 'forbidden'
      if ((w.kind === 'request') !== (o.object_type === 'request')) return 'forbidden'
      let lamport = 0
      if (note) { try { lamport = Number(JSON.parse(text.decode(unb64(w.payload))).lamport) || 0 } catch { lamport = 0 } }
      const rank: [number, string, number] = [lamport, w.sender, w.seq]
      if (!held) {
        if (o.object_ref !== ZERO32 || o.object_id !== objectIdOf(w.group, w.sender, w.seq) || o.object_state !== 'open') return 'forbidden'
        return put({ group: w.group, type: o.object_type, owner: w.sender, state: 'open', current: hash, urgency: o.urgency, answer: null, expires_at: w.bind?.kind === 'request' ? w.bind.expires_at : 0, rank })
      }
      if (held.type !== o.object_type || held.group !== w.group || w.kind === 'request' || o.object_state === 'answered') return 'forbidden'
      if (note) {
        // any human device writes a version on any other; the current one is chosen as a register's (9.3.2)
        const wins = !held.rank || rank[0] > held.rank[0] || (rank[0] === held.rank[0] && (rank[1] > held.rank[1] || (rank[1] === held.rank[1] && rank[2] > held.rank[2])))
        return put(wins ? { ...held, state: o.object_state, current: hash, rank } : held)
      }
      // the owner; once it is no leaf of the group any more, another agent device of the session takes its objects
      const owner = held.owner === w.sender || !known?.groups.get(w.group)?.leaves.some(l => b64(l) === held.owner)
      if (!owner || o.object_ref !== held.current) return 'forbidden'
      return put({ ...held, owner: w.sender, state: o.object_state, current: hash, urgency: o.urgency, answer: o.object_state === 'open' ? null : held.answer })
    }
    if (!held || !human || o.object_ref !== held.current) return 'forbidden'
    if (w.kind === 'answer') return held.type === 'card' && held.state === 'open' && o.object_state !== 'open' ? put({ ...held, state: o.object_state, answer: hash }) : 'forbidden'
    if (w.kind === 'takeBack') return held.type === 'card' && held.state === 'answered' ? put({ ...held, state: 'open', answer: null }) : 'forbidden'
    if (w.kind === 'verdict') return held.type === 'request' && held.state === 'open' ? put({ ...held, state: 'closed' }) : 'forbidden'
    return 'forbidden'
  }
  /** Who may write a register's name (9.3.3): its role, and for `device/<id>` and `heads` only the device itself. */
  function registerAllowed(w: Wire, name: string): boolean {
    const human = isHuman(w.sender) || (w.session_id === null && !wasLeaf(w.group, w.sender))
    if (name === 'heads') return true
    if (name.startsWith('device/')) return name === `device/${w.sender}`
    if (w.session_id === null) return human
    return name === 'goals' ? human : !human
  }
  /** Whether this register value is now the current one of its name (9.3.2): the highest (lamport, sender, number). */
  function registerCurrent(w: Wire, name: string, lamport: number, keep: boolean): boolean {
    const key = `reg/${w.group}/${name}`
    const held = state.get<[number, string, number]>(key)
    const mine: [number, string, number] = [lamport, w.sender, w.seq]
    const current = !held || mine[0] > held[0] || (mine[0] === held[0] && (mine[1] > held[1] || (mine[1] === held[1] && mine[2] >= held[2])))
    if (current && keep) state.set(key, mine)
    return current
  }
  function registerBody(w: Wire): { name: string; lamport: number } | null {
    try {
      const body = JSON.parse(text.decode(unb64(w.payload)))
      return typeof body?.name === 'string' ? { name: body.name, lamport: Number(body.lamport) || 0 } : null
    } catch { return null }
  }

  async function receiveEnvelope(bytes: Uint8Array, change: number, ordered: boolean, voidCode: ErrorCode | null, _nowMs: number): Promise<ReceivedEnvelope> {
    if (ordered) reach(change)
    let w: Wire
    try { w = JSON.parse(text.decode(bytes)) as Wire } catch { return refuse('bad-format', 'an envelope the stand-in did not write') }
    if (w?.v !== 2 || typeof w.group !== 'string' || typeof w.sender !== 'string' || !Number.isSafeInteger(w.seq)) refuse('bad-format', 'an envelope the stand-in did not write')
    const hashBytes = sha256(bytes), hash = b64(hashBytes)
    const header = headerOf(w, change, hashBytes)
    const result = (outcome: ReceivedEnvelope['outcome'], code: ErrorCode | null, more: Partial<ReceivedEnvelope> = {}): ReceivedEnvelope =>
      ({ header, outcome, code, payload: null, bind: null, objectAfter: null, register: null, ...more })
    const afterOf = (a: Seen['after']): ReceivedEnvelope['objectAfter'] => a ? { objectId: unb64(a.object_id), owner: unb64(a.owner), objectState: a.state, currentVersion: unb64(a.current) } : null
    const k = await facts()
    if (k.room === null) return result('refused', 'no-room')
    const g = k.groups.get(w.group)
    if (!g || w.epoch > g.epoch) return result('refused', 'group-behind')
    // a sender this device never saw as a leaf: taken for one of an epoch whose key this device was handed
    if (!wasLeaf(w.group, w.sender) && !(await hasKey(w.group, w.epoch))) return result('refused', 'not-member')
    const cut = state.get<Chain>(`cut/${w.group}/${w.sender}`)
    if (cut && w.seq > cut.seq) return result('refused', 'removed-sender')
    const seenKey = `seen/${hash}`
    const seen = state.get<Seen>(seenKey)
    const key = await hasKey(w.group, w.epoch)
    const opened = (): Partial<ReceivedEnvelope> => (key ? { payload: unb64(w.payload), bind: bindOf(w.bind) } : {})
    const reg = w.kind === 'register' ? registerBody(w) : null

    if (!ordered) {
      if (seen) {
        // reading back an envelope the chain holds: what it was, with its body if the key is here now
        if (seen.code && seen.code !== 'no-key') return result(seen.code === 'forbidden' ? 'chained' : 'void', seen.code)
        const register = reg ? { name: reg.name, current: registerAllowed(w, reg.name) && registerCurrent(w, reg.name, reg.lamport, false) } : null
        return key ? result('applied', null, { ...opened(), objectAfter: afterOf(seen.after), register }) : result('chained', 'no-key', { objectAfter: afterOf(seen.after) })
      }
      if (voidCode) return result('void', voidCode)
      if (judge(w, hash, false) === 'forbidden' && (w.kind === 'item' || w.kind === 'register')) return result('refused', 'forbidden')
      if (!key) return result('refused', 'no-key')
      return result('provisional', null, { ...opened(), register: reg ? { name: reg.name, current: registerAllowed(w, reg.name) && registerCurrent(w, reg.name, reg.lamport, false) } : null })
    }

    const chainKey = `chain/${w.group}/${w.sender}`
    const head = state.get<Chain>(chainKey) ?? { seq: 0, hash: ZERO32 }
    if (w.seq <= head.seq) return result('refused', seen && seen.g === w.group && seen.s === w.sender && seen.q === w.seq ? 'replay' : 'equivocation')
    if (w.seq !== head.seq + 1) return result('refused', 'gap')
    if (w.prev !== head.hash) return result('refused', 'chain-break')
    // an own envelope comes back as it was sealed, or the hub changed it
    if (w.sender === k.me) { const own = state.get<Chain>(`own/${w.group}`); if (own && w.seq === own.seq && own.hash !== hash) return result('refused', 'equivocation') }
    state.set(chainKey, { seq: w.seq, hash })
    if (voidCode) { state.set(seenKey, { g: w.group, s: w.sender, q: w.seq, code: voidCode, after: null, reg: null } satisfies Seen); return result('void', voidCode) }
    const after = judge(w, hash, true)
    if (after === 'forbidden' || (reg === null && w.kind === 'register')) {
      state.set(seenKey, { g: w.group, s: w.sender, q: w.seq, code: 'forbidden', after: null, reg: null } satisfies Seen)
      return result('chained', 'forbidden')
    }
    let register: ReceivedEnvelope['register'] = null
    if (reg) {
      if (reg.lamport > lamportOf(w.group)) state.set(`lamport/${w.group}`, reg.lamport)
      register = { name: reg.name, current: registerAllowed(w, reg.name) && registerCurrent(w, reg.name, reg.lamport, true) }
    }
    state.set(seenKey, { g: w.group, s: w.sender, q: w.seq, code: key ? null : 'no-key', after, reg: reg?.name ?? null } satisfies Seen)
    return key ? result('applied', null, { ...opened(), objectAfter: afterOf(after), register }) : result('chained', 'no-key', { objectAfter: afterOf(after) })
  }

  function headsValue(g: string): string {
    const heads: Record<string, [number, string]> = {}
    for (const key of state.keys(`chain/${g}/`).sort()) { const c = state.get<Chain>(key)!; heads[key.slice(`chain/${g}/`.length)] = [c.seq, c.hash] }
    return JSON.stringify(heads)
  }

  // ---- joining by link (JSON, no signature that means anything)

  const inviteIdOf = (secret: Uint8Array, room: Uint8Array): Uint8Array => hashOf('trommi invite id', secret, room).subarray(0, 16)
  const macOf = (secret: Uint8Array, room: Uint8Array, request: Uint8Array): Uint8Array => hashOf('trommi invite mac', secret, room, request)
  const codeOf = (offer: Uint8Array, request: Uint8Array, mac: Uint8Array, nonce: Uint8Array): number[] => {
    const h = hashOf('Trommi Invite Code', offer, request, mac, nonce)
    let bits = 0n
    for (let i = 0; i < 5; i++) bits = (bits << 8n) | BigInt(h[i]!)
    return Array.from({ length: 6 }, (_, i) => Number((bits >> BigInt(34 - i * 6)) & 63n))
  }
  const fakeSignature = (label: string, bytes: Uint8Array): Uint8Array => concat(hashOf(label, bytes), hashOf(`${label} 2`, bytes))

  const device = {
    close: async (): Promise<void> => { await run(async () => {}).catch(() => {}); closed = true; await raw.close(); await state.close() },
    cursor: () => run(async () => Math.max(await raw.cursor(), cursorOf())),
    outbox: () => run(outbox),
    outboxAccepted: (id: number, change?: number | null) => run(async () => {
      fresh()
      if (id >= OWN_IDS) { if (!state.get(`out/${id}`)) refuse('not-found', 'no such outbox entry'); state.delete(`out/${id}`); return }
      await raw.outboxAccepted(id, change)
      state.delete(`facts/${id}`)
    }),
    outboxRefused: (id: number, code: ErrorCode) => run(async () => {
      fresh()
      // a refused envelope keeps its number: the device never signs another one under it (9.0.1)
      if (id >= OWN_IDS) { if (!state.get(`out/${id}`)) refuse('not-found', 'no such outbox entry'); state.delete(`out/${id}`); return }
      await raw.outboxRefused(id, code)
      state.delete(`facts/${id}`)
    }),
    keyPackagesToUpload: (unused: number, nowMs: number) => run(() => raw.keyPackagesToUpload(unused, nowMs)),

    foundRoom: (code: Uint8Array, nowMs: number) => run(async () => {
      const room = await raw.foundRoom(code, nowMs)
      fresh()
      const k = await facts(), entry = (await raw.outbox()).find(e => e.kind === 'roomFounding')
      if (entry) note(entry.id, { 0: { group: b64(room), epoch: 0, leaves: [k.me], recovery_signature_key: k.roles ? b64(k.roles.recoverySignatureKey) : null } })
      return room
    }),
    foundSession: (agent: Uint8Array, keyPackages: Uint8Array[], nowMs: number) => run(async () => {
      const session = await raw.foundSession(agent, keyPackages, nowMs)
      fresh()
      const k = await facts(), g = b64(binding.sessionGroupId(unb64(k.room!), session))
      const entry = (await raw.outbox()).find(e => e.kind === 'groupFounding' && e.group !== null && b64(e.group) === g)
      if (entry) note(entry.id, { 0: { group: g, epoch: 0, leaves: [k.me], session: { session_id: b64(session), parent: null } }, 2: { added: keyPackages.map(p => b64(binding.keyPackageInfo(p).device)) } })
      return session
    }),
    addHumanDevice: (d: Uint8Array, keyPackage: Uint8Array, nowMs: number) => run(async () => { const id = await raw.addHumanDevice(d, keyPackage, nowMs); fresh(); note(id, { 0: { added: [b64(d)] } }); return id }),
    addToSession: (g: Uint8Array, d: Uint8Array, keyPackage: Uint8Array, nowMs: number) => run(async () => { const id = await raw.addToSession(g, d, keyPackage, nowMs); fresh(); note(id, { 0: { added: [b64(d)] } }); return id }),
    changeAgents: (enrol: Uint8Array[], remove: Uint8Array[], nowMs: number) => run(async () => { const id = await raw.changeAgents(enrol, remove, nowMs); fresh(); note(id, { 0: { agents: enrol.map(b64), removed: remove.map(b64) } }); return id }),
    removeHumanDevices: (cuts: Cut[], nowMs: number) => run(async () => { const id = await raw.removeHumanDevices(cuts, nowMs); fresh(); note(id, { 0: { removed: cuts.map(c => b64(c.device)) } }); return id }),
    cleanSession: (g: Uint8Array, cuts: Cut[], replacement: { device: Uint8Array; keyPackage: Uint8Array } | null | undefined, nowMs: number) => run(async () => {
      const id = await raw.cleanSession(g, cuts, replacement, nowMs)
      fresh(); note(id, { 0: { removed: cuts.map(c => b64(c.device)), added: replacement ? [b64(replacement.device)] : [] } })
      return id
    }),
    update: (g: Uint8Array, forced: boolean, nowMs: number) => run(async () => { const id = await raw.update(g, forced, nowMs); fresh(); return id }),
    joinWelcome: (welcome: Uint8Array, room: Uint8Array, committer: Uint8Array | null | undefined, nowMs: number) => run(async () => { try { return await raw.joinWelcome(welcome, room, committer, nowMs) } finally { fresh() } }),
    observeRoom: (groupInfo: Uint8Array, expected?: Uint8Array | null) => run(async () => { try { await raw.observeRoom(splitFacts(groupInfo).bytes, expected) } finally { fresh() } }),
    observeSession: (groupInfo: Uint8Array) => run(async () => { try { await raw.observeSession(splitFacts(groupInfo).bytes) } finally { fresh() } }),
    processLogEntry: (entry: LogEntry) => run(async (): Promise<Processed> => {
      let done: Processed
      try { done = await raw.processLogEntry({ ...entry, bytes: splitFacts(entry.bytes).bytes }) }
      catch (e) { fresh(); if (binding.logFinding((e as { code: ErrorCode }).code) === 'duplicate') reach(entry.change); throw e }
      fresh()
      reach(entry.change)
      for (const c of done.commit?.cuts ?? []) state.set(`cut/${b64(entry.group)}/${b64(c.device)}`, { seq: c.seq, hash: b64(c.hash) } satisfies Chain)
      await facts()
      return done
    }),

    // recovery is the binding's own (spec 8): the stand-in only cuts its trailers off what the fake hub serves, and
    // notes for the fake hub who a join or a recovery brings in and takes out
    verifyFounding: (g: Uint8Array, served: ServedGroup) => run(() => raw.verifyFounding(g, bare(served))),
    joinRoomWithCode: (code: Uint8Array, served: ServedRoom, nowMs: number) => run(async () => {
      const done = await raw.joinRoomWithCode(code, bareRoom(served), nowMs)
      fresh()
      const me = b64(await raw.id())
      for (const id of done.outbox) note(id, { 0: { added: [me] } })
      return done
    }),
    joinSessionWithCode: (code: Uint8Array, served: ServedGroup, nowMs: number) => run(async () => {
      const id = await raw.joinSessionWithCode(code, bare(served), nowMs)
      fresh()
      note(id, { 0: { added: [b64(await raw.id())] } })
      return id
    }),
    prepareRecovery: (code: Uint8Array, served: ServedRoom) => run(() => raw.prepareRecovery(code, bareRoom(served))),
    recover: (code: Uint8Array, served: ServedRoom, cuts: GroupCut[], account: Uint8Array, nowMs: number) => run(async () => {
      const plan = await raw.prepareRecovery(code, bareRoom(served))
      const done = await raw.recover(code, bareRoom(served), cuts, account, nowMs)
      fresh()
      const me = b64(await raw.id()), entries = await raw.outbox()
      for (const id of done.outbox) {
        const entry = entries.find(e => e.id === id)
        if (entry?.kind !== 'recoveryCommit' || !entry.group) continue
        const gone = plan.removals.find(r => same(r.group, entry.group!))?.devices ?? []
        note(id, { 0: { added: [me], removed: gone.map(b64) } })
      }
      return done
    }),

    seal: (draft: Draft, recipient: Uint8Array | null, fileIds: Uint8Array[], nowMs: number) => run(() => seal(draft, recipient, fileIds, nowMs)),
    sealAgent: (draft: AgentDraft, fileIds: Uint8Array[], nowMs: number) => run(() => sealAgent(draft, fileIds, nowMs)),
    receiveEnvelope: (bytes: Uint8Array, change: number, ordered: boolean, voidCode: ErrorCode | null, nowMs: number) => run(() => receiveEnvelope(bytes, change, ordered, voidCode, nowMs)),
    headsDue: (g: Uint8Array, nowMs: number) => run(async () => {
      const id = b64(g), value = headsValue(id), last = state.get<{ value: string; at: number }>(`heads/${id}`)
      if (value === '{}' || last?.value === value || (last && nowMs - last.at < 600_000)) return null
      state.set(`heads/${id}`, { value, at: nowMs })
      return utf8.encode(value)
    }),
    cutOf: (g: Uint8Array, d: Uint8Array) => run(async (): Promise<Cut> => {
      const c = state.get<Chain>(`chain/${b64(g)}/${b64(d)}`)
      return { device: d, seq: c?.seq ?? 0, hash: c ? unb64(c.hash) : new Uint8Array(32) }
    }),

    sendStrokePiece: (board: Uint8Array, piece: Uint8Array) => run(async () => {
      const k = await facts(), g = await group(await roomGroup())
      return queue('relayMessage', b64(g.group), g.epoch, utf8.encode(JSON.stringify({ relay: 'stroke_piece', from: k.me, board: b64(board), piece: b64(piece) })))
    }),
    receiveRelay: (g: Uint8Array, epoch: number, sender: Uint8Array, message: Uint8Array, _nowMs: number) => run(async (): Promise<ReceivedMessage | null> => {
      const k = await facts(), held = k.groups.get(b64(g))
      if (!held || held.epoch !== epoch || !isHuman(b64(sender))) return null
      try {
        const m = JSON.parse(text.decode(message))
        if (m.relay !== 'stroke_piece' || m.from !== b64(sender)) return null
        return { kind: 'strokePiece', from: sender, keysTaken: 0, last: false, board: unb64(m.board), turn: null, number: 0, time: 0, payload: unb64(m.piece) }
      } catch { return null }
    }),

    inviteOpen: (role: InviteRole, sessionId: Uint8Array | null, app: string, hub: string, nowMs: number) => run(async () => {
      const k = await facts()
      if (!k.room || !k.roles || !isHuman(k.me)) refuse('forbidden', 'only a human device invites')
      const room = unb64(k.room!), secret = random(32), nonce = random(32), inviteId = inviteIdOf(secret, room), expiresAt = nowMs + INVITE_MS
      const offer = utf8.encode(JSON.stringify({ room_id: k.room, invite_id: b64(inviteId), role, session_id: sessionId ? b64(sessionId) : null, expires_at: expiresAt,
        commitment: b64(hashOf('Trommi Invite Commitment', inviteId, nonce)), inviter: k.me, room_epoch: k.roles!.epoch, room_state: b64(k.roles!.state) }))
      state.set(`invite/${b64(inviteId)}`, { secret: b64(secret), nonce: b64(nonce), role, session_id: sessionId ? b64(sessionId) : null, offer: b64(offer), expires_at: expiresAt, hub, used: null, burned: false } satisfies Invite)
      const link = `${app.replace(/\/+$/, '')}/join#v2.${b64(utf8.encode(hub))}.${k.room}.${b64(secret)}`
      return { inviteId, link, expiresAt, signedOffer: offer, offer, signature: fakeSignature('TrommiInviteOffer', offer) }
    }),
    inviteAccept: (inviteId: Uint8Array, signed: { request: Uint8Array; mac: Uint8Array; signature: Uint8Array }, nowMs: number) => run(async () => {
      const { request, mac } = signed
      const k = await facts(), key = `invite/${b64(inviteId)}`, inv = state.get<Invite>(key) ?? refuse('bad-invite', 'no such invite')
      if (inv.burned) refuse('invite-burned', 'this invite was burned')
      if (nowMs > inv.expires_at) refuse('invite-expired', 'this invite ran out')
      // the hash the fake hub knows a Request by: SHA-256 of Request and MAC
      const requestHash = sha256(concat(request, mac))
      if (inv.used && inv.used.request_hash !== b64(requestHash)) refuse('invite-used', 'another Request was accepted')
      if (!same(mac, macOf(unb64(inv.secret), unb64(k.room!), request))) refuse('bad-invite', 'the Request does not carry this invite\'s MAC')
      const r = JSON.parse(text.decode(request)) as { room_id: string; invite_id: string; hub: string; role: InviteRole; key_package: string; offer_hash: string; device: string }
      if (r.room_id !== k.room || r.invite_id !== b64(inviteId) || r.hub !== inv.hub || r.role !== inv.role || r.offer_hash !== b64(hashOf('Trommi Invite Offer', unb64(inv.offer)))) refuse('bad-invite', 'the Request is for another invite')
      const keyPackage = unb64(r.key_package), newDevice = binding.keyPackageInfo(keyPackage).device
      if (b64(newDevice) !== r.device) refuse('bad-signature', 'the Request is not by the KeyPackage\'s device')
      const checkCode = codeOf(unb64(inv.offer), request, mac, unb64(inv.nonce))
      state.set(key, { ...inv, used: { device: r.device, key_package: r.key_package, request_hash: b64(requestHash), code: checkCode } } satisfies Invite)
      const reveal = utf8.encode(JSON.stringify({ invite_id: b64(inviteId), nonce: inv.nonce, request_hash: b64(requestHash) }))
      return { newDevice, checkCode, signedReveal: reveal, reveal, signature: fakeSignature('TrommiInviteReveal', reveal), requestHash }
    }),
    inviteConfirm: (inviteId: Uint8Array, matches: boolean, nowMs: number) => run(async () => {
      const key = `invite/${b64(inviteId)}`, inv = state.get<Invite>(key) ?? refuse('bad-invite', 'no such invite')
      if (inv.burned) refuse('invite-burned', 'this invite was burned')
      if (!inv.used) refuse('code-not-confirmed', 'no Request was accepted')
      if (!matches) { state.set(key, { ...inv, burned: true } satisfies Invite); return null }
      const newDevice = unb64(inv.used!.device), keyPackage = unb64(inv.used!.key_package)
      // called again (its Commit lost the epoch), it commits again; a device that is in already is left alone
      const k = await facts(), inside = inv.role === 'human' ? k.roles?.humans : k.roles?.agents
      if (!inside?.some(d => same(d, newDevice))) {
        const id = inv.role === 'human' ? await raw.addHumanDevice(newDevice, keyPackage, nowMs) : await raw.changeAgents([newDevice], [], nowMs)
        fresh()
        note(id, { 0: inv.role === 'human' ? { added: [inv.used!.device] } : { agents: [inv.used!.device], removed: [] } })
      }
      return { newDevice, role: inv.role, sessionId: inv.session_id ? unb64(inv.session_id) : null, keyPackage }
    }),
    joinRequest: (link: string, signed: { offer: Uint8Array; signature: Uint8Array }, nowMs: number) => run(async () => {
      const offer = signed.offer
      const parts = linkParts(link), o = JSON.parse(text.decode(offer)) as { room_id: string; invite_id: string; role: InviteRole; session_id: string | null; expires_at: number; inviter: string; room_epoch: number; room_state: string }
      const room = unb64(parts.room)
      if (o.room_id !== parts.room || o.invite_id !== b64(inviteIdOf(unb64(parts.secret), room))) refuse('bad-invite', 'the Offer is not this link\'s')
      if (nowMs > o.expires_at) refuse('invite-expired', 'this invite ran out')
      const keyPackage = await raw.keyPackage(nowMs), me = b64(await raw.id())
      const request = utf8.encode(JSON.stringify({ room_id: o.room_id, invite_id: o.invite_id, hub: parts.hub, role: o.role, key_package: b64(keyPackage), offer_hash: b64(hashOf('Trommi Invite Offer', offer)), device: me }))
      const mac = macOf(unb64(parts.secret), room, request)
      state.set('joining', { invite_id: o.invite_id, secret: parts.secret, offer: b64(offer), request: b64(request), mac: b64(mac), inviter: o.inviter } satisfies Joining)
      return { signedRequest: request, request, mac, signature: fakeSignature('TrommiInviteRequest', concat(request, mac)), role: o.role, inviter: unb64(o.inviter), expiresAt: o.expires_at,
        sessionId: o.session_id ? unb64(o.session_id) : null, roomEpoch: o.room_epoch, roomState: unb64(o.room_state) }
    }),
    joinReveal: (signed: { reveal: Uint8Array; signature: Uint8Array }) => run(async () => {
      const reveal = signed.reveal
      const j = state.get<Joining>('joining') ?? refuse('bad-invite', 'this device asked to join nothing')
      const r = JSON.parse(text.decode(reveal)) as { invite_id: string; nonce: string; request_hash: string }
      const offer = JSON.parse(text.decode(unb64(j.offer))) as { commitment: string }
      const request = unb64(j.request), mac = unb64(j.mac)
      if (r.invite_id !== j.invite_id || r.request_hash !== b64(sha256(concat(request, mac)))) refuse('bad-invite', 'the Reveal is for another Request')
      if (offer.commitment !== b64(hashOf('Trommi Invite Commitment', unb64(j.invite_id), unb64(r.nonce)))) refuse('bad-invite', 'the Reveal does not open the Offer\'s commitment')
      return codeOf(unb64(j.offer), request, mac, unb64(r.nonce))
    }),

  } as Record<string, unknown>
  // every other call of the binding's device is passed through as it is; what it may have changed is read again
  const real = raw as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
  for (const name of Object.getOwnPropertyNames(binding.Device.prototype)) {
    if (name === 'constructor' || name in device || typeof real[name] !== 'function') continue
    device[name] = (...args: unknown[]) => run(async () => { try { return await real[name]!(...args) } finally { fresh() } })
  }
  return device as unknown as StandInDevice
}

const bare = (g: ServedGroup): ServedGroup => ({ founding: splitFacts(g.founding).bytes, current: splitFacts(g.current).bytes, commits: g.commits.map(c => ({ ...c, commit: splitFacts(c.commit).bytes })) })
const bareRoom = (r: ServedRoom): ServedRoom => ({ ...r, group: bare(r.group), anchor: splitFacts(r.anchor).bytes, sessions: r.sessions.map(bare) })

function linkParts(link: string): { app: string; hub: string; room: string; secret: string } {
  const bad = (): never => { throw Object.assign(new Error('bad-format: not an invite link'), { name: 'TrommiError', code: 'bad-format' }) }
  const m = /^(https?:\/\/[^/#]+)\/join#v(\d+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(link.trim())
  if (!m) return bad()
  if (Number(m[2]) > 2) throw Object.assign(new Error('newer-version: a link of a newer Trommi'), { name: 'TrommiError', code: 'newer-version' })
  if (m[2] !== '2') return bad()
  let hub: string
  try { hub = text.decode(unb64(m[3]!)) } catch { return bad() }
  return { app: m[1]!, hub, room: m[4]!, secret: m[5]! }
}

/**
 * The stand-in core over the loaded binding. `stateStore`: the stand-in's own store for the device kept in
 * `deviceStore` (a second store with the same contract; see the header for what two stores cost).
 */
export function standInCore(binding: Binding, opts: { stateStore(deviceStore: Store): Store }): Core {
  const { init: _init, Device: _Device, TrommiError: _TrommiError, StoreConflict: _StoreConflict, ...stateless } = binding
  const open = async (how: 'create' | 'open', store: Store): Promise<Device> => {
    const raw = await binding.Device[how](store)
    let state: State
    try { state = await State.load(opts.stateStore(store)) }
    catch (e) { await raw.close().catch(() => {}); throw new binding.TrommiError('storage', `storage: ${e instanceof Error ? e.message : 'the stand-in\'s store did not load'}`) }
    return makeDevice(binding, raw, state)
  }
  return {
    ...stateless,
    inviteLinkParse(link: string): InviteLinkParts {
      let p
      try { p = linkParts(link) } catch (e) { throw new binding.TrommiError((e as { code: ErrorCode }).code, (e as Error).message) }
      const roomId = unb64(p.room)
      return { app: p.app, hub: p.hub, roomId, inviteId: hashOf('trommi invite id', unb64(p.secret), roomId).subarray(0, 16) }
    },
    checkEmoji: () => CHECK_EMOJI.map(e => [e.emoji, e.word]),
    hubAddress: (address: string) => { try { return hubAddress(address) } catch { throw new binding.TrommiError('bad-format', 'bad-format: not a hub address') } },
    boardReduce(snapshot: Uint8Array | null, items: Uint8Array[]): Uint8Array {
      const state = reduceBoard(snapshot ? JSON.parse(text.decode(snapshot)) as BoardState : null, items.map(i => JSON.parse(text.decode(i)) as BoardItem))
      return utf8.encode(JSON.stringify(state))
    },
    createDevice: store => open('create', store),
    openDevice: store => open('open', store),
    errorCode: (error: unknown) => (error instanceof binding.TrommiError ? error.code : error instanceof CoreMissing ? error.code : null),
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
