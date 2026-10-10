// client.ts: the `Client` the core worker runs and the views call (through remote.ts): the model, the human actions
// by the names the views know, timelines, files, invites, sessions, push. Contract with the views: README.md "The
// model", "Human actions", "Change notifications", and worker-protocol.ts `CALLS`.
//
// The division of labour under protocol v2 (spec/v1.md):
//   the core (core-api.ts)   every rule and every key: groups, chains, object state, who may write what
//   engine.ts                owns the device: outbox pump, catch-up in the hub's order, the live stream, upkeep
//   model.ts                 turns what the core accepted into the model
//   this file                connects them: an action is an optimistic echo in the model, a draft sealed by the
//                            engine, and an outbox item until the hub answered; what the engine reports is applied
//                            to the model, projected, told to the views and written to the local cache
//
// Optimistic echoes: the model shows an own send before it is sealed (`pending: true`), the echo is replaced in
// place when the hub's copy comes back, and rolled back when sealing fails or the hub refuses the envelope for
// good (the outbox item is `failed` in that change, then gone). While the pump is halted on an envelope the item
// is `blocked` and `room.outbox_blocked` says why.
//
// The local cache (store-idb.ts `Cache`) holds the model's records, written shortly after each batch (one
// `setMany`) together with the cursor up to which the model holds everything the core took. It is NOT
// authoritative: the core's state is. At a start, a cache at the device's cursor is the model. One behind it (the
// page went away after the core took an item and before the cache was written) is shown, and everything after
// its cursor is read back from the hub through the core before it counts as whole again. One ahead of the device
// is dropped, and the model is built again from the device's groups, the hub's Desk and all of the room's changes.
//
// Nothing here logs. A file key, a share link's secret and a recovery code never go into an error's text.
import { attachmentRef, encodeBodyBytes, encodePiece, encodeRegister, fileIdsOf, fileRefOf, UPDATE_MESSAGE } from './codec.ts'
import type { Fields } from './codec.ts'
import type { Core, Device, Draft, FileRef, OutboxEntry, ReceivedEnvelope, Sealed } from './core-api.ts'
import { Engine } from './engine.ts'
import type { EngineEvents, EngineMeta } from './engine.ts'
import { accountCopiesBytes, HubError } from './hub.ts'
import type { AccountCopies, EnvelopeItem, Hub, StreamEvent } from './hub.ts'
import { b64u, hex, unb64u, unhex } from './ids.ts'
import * as M from './model.ts'
import type { Cache } from './store-idb.ts'
import type { Answer, AttachmentRef, Card, Change, Invite, Model, Note, OutboxItem, TimelineItem } from './types.ts'

export class ClientError extends Error {
  code: string
  constructor(code: string, message: string) { super(message); this.name = 'ClientError'; this.code = code }
}
const fail = (code: string, message: string): never => { throw new ClientError(code, message) }
type Listener = (data: any) => void
type Sent = { local_id: string; envelope_hash: string; seq: number }

/** How long the model's changes are gathered before one write to the cache. Short: a page that goes away meanwhile
 *  finds its cache behind the device and reads the difference back (see `open`). */
const FLUSH_MS = 40
const CHUNK = 65_536
const DAY = 86_400_000
const INVITE_CONFIRM_MS = 5 * 60_000
const MODEL_KEYS: readonly string[] = ['card/', 'session/', 'perm/', 'note/', 'pub/', 'tlmeta/', 'reg/', 'tl/', 'members', 'devregs', 'room', 'newer', 'alerts']
const randomHex = (bytes: number): string => hex(crypto.getRandomValues(new Uint8Array(bytes)))
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i])
const codeText = (numbers: readonly number[]): string => numbers.map(n => String(n).padStart(2, '0')).join('-')
/** The app's origin of an address the views name (`https://app.trommi.com/join`, `https://app.trommi.com`). */
const originOf = (app_url: string): string => { try { return new URL(app_url).origin } catch { return app_url.replace(/\/+$/, '') } }
/** A Note's own fields: everything of the model's note but what the model adds. */
function noteFields(n: Record<string, unknown>): Fields {
  const { object_id: _o, by_device_id: _b, object_version: _v, version_hash: _h, version_hashes: _hs, causal: _c, envelope_number: _n, object_state: _s, pending: _p, unsupported: _u, local_id: _l, _base, previous_version_hash: _pv, lamport: _lp, ...rest } = n
  return rest
}

// ---- files (spec 11): the core encrypts and decrypts piece by piece, the hub stores -------------------------------------

/** Encrypts `data` in pieces of 64 KiB and stores it at the hub. Returns what opens it again. `fileKey` is a secret. */
export async function putEncrypted(core: Core, hub: Hub, data: Uint8Array | Blob): Promise<{ file: FileRef; size: number }> {
  const encryptor = new core.FileEncryptor()
  const size = data instanceof Uint8Array ? data.length : data.size
  const stored: Uint8Array<ArrayBuffer>[] = []
  try {
    for (let at = 0; at < size; at += CHUNK) {
      const piece = data instanceof Uint8Array ? data.subarray(at, at + CHUNK) : new Uint8Array(await data.slice(at, at + CHUNK).arrayBuffer())
      stored.push(encryptor.update(piece) as Uint8Array<ArrayBuffer>)
    }
  } catch (e) { (encryptor as { close?: () => void }).close?.(); throw e }
  const end = encryptor.finish()
  stored.push(end.stored as Uint8Array<ArrayBuffer>)
  // the hub wants the length up front: the pieces are handed over as one Blob, not copied into one array
  await hub.putFile(end.file.fileId, new Blob(stored))
  return { file: end.file, size: end.plainLen }
}
/** Decrypts a stored file as the core says (11.2): what `update` handed out counts only once `finish` succeeded. */
function decrypt(core: Core, file: FileRef, stored: Uint8Array): Uint8Array {
  const decryptor = new core.FileDecryptor(file)
  const plain: Uint8Array[] = []
  let size = 0
  try {
    for (let at = 0; at < stored.length; at += CHUNK) { const p = decryptor.update(stored.subarray(at, at + CHUNK)); plain.push(p); size += p.length }
  } catch (e) { (decryptor as { close?: () => void }).close?.(); throw e }
  const last = decryptor.finish()
  plain.push(last); size += last.length
  const out = new Uint8Array(size)
  let at = 0
  for (const p of plain) { out.set(p, at); at += p.length }
  return out
}
export async function getDecrypted(core: Core, hub: Hub, file: FileRef): Promise<Uint8Array> {
  return decrypt(core, file, (await hub.getFile(file.fileId)).bytes)
}

// ---- Share links (11.5) ---------------------------------------------------------------------------------------------

const B64_16 = '[A-Za-z0-9_-]{22}', B64_32 = '[A-Za-z0-9_-]{43}'
const SHARE = new RegExp(`/a/(${B64_16})#(${B64_32})\\.(${B64_32})\\.(${B64_32})$`)
/** A Share link's parts by its form alone, for a page that has not loaded the core yet (the core checks it for
 *  real in `openShared`). Throws `bad-format`. `share_secret` and `file_key` are secrets. */
export function parseShareLink(link: unknown): { share_id: string; share_secret: string; file_key: string; sha256: string } {
  const m = SHARE.exec(String(link).trim())
  if (!m) return fail('bad-format', 'not a share link')
  return { share_id: hex(unb64u(m[1]!)), share_secret: m[2]!, file_key: m[3]!, sha256: m[4]! }
}
/** The shared file's bytes for whoever holds the link: no room, no sign-in. `core`: the loaded core. */
export async function openShared(core: Core, hub: Hub, link: string): Promise<Uint8Array> {
  const share = core.shareLinkParse(String(link).trim())
  const { bytes } = await hub.getShared(share.shareId, unb64u(share.secret))
  // a Share link names no file id: the core's decryptor reads it from the file's head and checks the hash
  return decrypt(core, { fileId: bytes.subarray(1, 17).slice(), fileKey: share.fileKey, sha256: share.sha256 }, bytes)
}

// ---- the client -----------------------------------------------------------------------------------------------------

export interface ClientOptions {
  core: Core
  hub: Hub
  engine: Engine
  cache: Cache
  /** This device's name and where it runs, written once as its register `device/<id>`. */
  device_name?: string
  device_info?: unknown
  now?: () => number
}
/** An invite as this device keeps it beside what the model shows. */
interface InviteKept { public: Invite; checked_at?: number; done?: boolean; code?: number[]; request_hash?: string; committed?: boolean }

export class Client {
  model: Model
  readonly core: Core
  readonly hub: Hub
  readonly engine: Engine
  readonly room_id: Uint8Array
  readonly my_device_id: string
  stats: Record<string, number> | null = null

  private readonly cache: Cache
  private readonly opts: ClientOptions
  private readonly now: () => number
  private readonly listeners = new Map<string, Set<Listener>>()
  private change: Change = M.emptyChange()
  private alertsSeen = new Set<string>()
  /** Outbox id of a sealed envelope -> its echo and its item in model.outbox. */
  private readonly sending = new Map<number, { local_id: string; item: OutboxItem }>()
  private readonly dirty = new Map<string, unknown>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private flushing: Promise<void> = Promise.resolve()
  private readonly attachmentCache = new Map<string, Uint8Array>()
  private readonly invites = new Map<string, InviteKept>()
  private inviteTimer: ReturnType<typeof setInterval> | null = null
  private readonly checking = new Set<string>()
  /** Who waits for an invite that was confirmed to be through. */
  private readonly finishing = new Map<string, { resolve(): void; reject(e: unknown): void }>()
  /** A note's newest version as THIS client sealed it (ahead of the model while versions are in flight). */
  /** Notes with a version on its way to the hub and back: its hash and outbox entry, and the edit that waits behind it. */
  private readonly noteBusy = new Map<string, { hash: string; outbox: number; next: { own: Fields; closed: boolean; local_id: string } | null }>()
  private lamport = 0
  private started = false
  private removed = false
  /** Not null: the model is not all the device holds; everything after this change is being read back. */
  private rebuild: number | null = null
  /** The cursor up to which everything the core took is in the model and handed to the cache; -1 while rebuilding. */
  private stamped = -1
  private rebuilding = false
  /** The cursor the cache was last written with. */
  private written = -2
  private goalsTimer: ReturnType<typeof setTimeout> | null = null
  private readonly offs: (() => void)[] = []

  constructor(opts: ClientOptions) {
    this.opts = opts
    this.core = opts.core
    this.hub = opts.hub
    this.engine = opts.engine
    this.cache = opts.cache
    this.now = opts.now ?? Date.now
    this.room_id = opts.engine.room_id ?? fail('no-room', 'this device has no room')
    this.my_device_id = hex(opts.engine.device_id)
    this.model = M.emptyModel()
    this.listen()
  }
  get is_human(): boolean { return this.engine.is_human }

  /** Fills the model before anything is fetched: from the cache if it was written at the device's cursor, else from
   *  the device's groups alone (the rest follows in `start`). Called once, by room.ts. */
  async open(): Promise<this> {
    const e = this.engine
    const kept = (await this.cache.get('client/at').catch(() => null)) as { cursor: number; device: string } | null
    // The cache belongs to the cursor it was written at. At the device's cursor: it is the model. Behind it (the
    // page went away between "the core took an item" and "the cache was written", or a rebuild was cut short,
    // which is written as -1): what it holds is still true, and everything after its cursor is read back from
    // the hub through the core before the cache counts as whole again. Ahead of the device, or another device's:
    // dropped.
    if (kept && kept.device === this.my_device_id && kept.cursor <= e.cursor) {
      this.model = M.modelFromCache(await this.cache.range(''))
      if (kept.cursor === e.cursor) this.stamped = this.written = kept.cursor
      else this.rebuild = Math.max(0, kept.cursor)
    } else {
      if (kept) await this.dropCache()
      if (e.cursor > 0) this.rebuild = 0
    }
    const room = this.model.room
    Object.assign(room, { room_id: hex(this.room_id), hub_url: this.hub.hub_url, my_device_id: this.my_device_id, my_role: e.is_human ? 'human' : 'agent', last_envelope_number: e.position, connection: 'offline', outbox_blocked: null })
    const ch = M.emptyChange()
    ch.room = true
    M.applyGroups(this.model, e.groups, e.roles, ch)
    for (const [key, value] of await this.cache.range('client/invite/')) { const k = value as InviteKept; this.invites.set(key.slice('client/invite/'.length), k); if (!k.done) this.model.invites.set(k.public.invite_id, k.public) }
    M.project(this.model, ch, this.now())
    this.record(ch)
    return this
  }
  private async dropCache(): Promise<void> {
    const gone: [string, undefined][] = []
    for (const prefix of MODEL_KEYS) for (const [key] of await this.cache.range(prefix)) gone.push([key, undefined])
    if (gone.length) await this.cache.setMany(gone)
  }

  // ---- events

  on(event: string, fn: Listener): () => void {
    let set = this.listeners.get(event)
    if (!set) this.listeners.set(event, set = new Set())
    set.add(fn)
    return () => this.off(event, fn)
  }
  off(event: string, fn: Listener): void { this.listeners.get(event)?.delete(fn) }
  private emit(event: string, data: unknown): void { for (const fn of [...this.listeners.get(event) ?? []]) { try { fn(data) } catch { /* a listener's fault is the listener's */ } } }

  /** Ends a batch: projects, tells the views what changed, hands the change's records to the cache. */
  private publish(): void {
    const ch = this.change
    if (this.model.room.last_envelope_number !== this.engine.position) { this.model.room.last_envelope_number = this.engine.position; ch.room = true }
    M.project(this.model, ch, this.now())
    // (the engine moves its cursor only after an item's effects were reported: at any publish the model holds
    // everything up to it, and this change carries what the cache lacks of it)
    if (this.rebuild === null) this.stamped = this.engine.cursor
    if (M.changeIsEmpty(ch)) { if (this.rebuild === null && this.written !== this.stamped) this.touched(); return }
    this.change = M.emptyChange()
    this.record(ch)
    this.emit('change', ch)
    if (ch.alerts) for (const a of this.model.alerts) if (!this.alertsSeen.has(a.alert_id)) { this.alertsSeen.add(a.alert_id); this.emit('alert', a) }
    if (this.alertsSeen.size > 1000) this.alertsSeen = new Set(this.model.alerts.map(a => a.alert_id))
    if (this.is_human && (ch.sessions.size || [...ch.registers].some(k => k.startsWith('desk/') || k.startsWith('session/')))) this.goalsSoon()
  }
  /** The cache's cursor is to be written although no record changed. */
  private touched(): void { if (this.flushTimer === null) this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flush().catch(() => {}) }, FLUSH_MS) }
  /** A change made outside the engine's batches (an action's echo): published at once. */
  private tell(make: (ch: Change) => void): void { make(this.change); this.publish() }
  private record(ch: Change): void {
    for (const [key, value] of M.cacheRecords(this.model, ch)) this.dirty.set(key, value)
    if (this.flushTimer === null) this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flush().catch(() => {}) }, FLUSH_MS)
  }
  /** Writes what changed to the cache now: one transaction, with the cursor it belongs to. */
  flush(): Promise<void> {
    if (this.flushTimer !== null) { clearTimeout(this.flushTimer); this.flushTimer = null }
    return this.flushing = this.flushing.catch(() => {}).then(async () => {
      if (!this.dirty.size && this.written === (this.rebuild === null ? this.stamped : -1)) return
      const taken = [...this.dirty], stamp = this.rebuild === null ? this.stamped : -1
      this.dirty.clear()
      const entries: [string, unknown | undefined][] = [...taken, ['client/at', { cursor: stamp, device: this.my_device_id }]]
      try { await this.cache.setMany(entries); this.written = stamp } catch (e) {
        // not written: the records stay due (a newer value of one wins), so a later write cannot stamp the cursor
        // over a cache that lacks them
        for (const [key, value] of taken) if (!this.dirty.has(key)) this.dirty.set(key, value)
        throw e
      }
    })
  }

  // ---- what the engine reports -> the model

  private listen(): void {
    const e = this.engine
    const on = <K extends keyof EngineEvents>(event: K, fn: (data: EngineEvents[K]) => void): void => { this.offs.push(e.on(event, fn)) }
    on('envelope', ({ received }) => {
      M.applyEnvelope(this.model, received, this.change, { now: this.now() })
      const o = received.header.object
      if (o?.objectType === 'note' && this.noteBusy.get(hex(o.objectId))?.hash === hex(received.envelopeHash)) this.noteBack(hex(o.objectId))
    })
    on('log', ({ item, done }) => {
      const room = item.group.length === 32
      if (done.commit) M.applyCommit(this.model, done.commit, this.change, { by_recovery: room && done.commit.external, removed_me: done.removed && room, now: this.now() })
      const m = done.message
      if (m?.kind === 'workTrail') { const s = e.groups.find(g => sameBytes(g.group, item.group))?.session; if (s) M.applyWorkTrail(this.model, hex(s.sessionId), m, item.change, this.change) }
      else if (m?.kind === 'recoveryAuthConflict') M.pushAlert(this.model, this.change, { code: 'equivocation', message: 'two different confirmations of the recovery key were sent: neither replaces the one this device holds', envelope_number: item.change, sender_device_id: m.from ? hex(m.from) : null, at: this.now() })
      else if (m?.kind === 'newerVersion') M.noteNewer(this.model, this.change, 'message type', { envelope_number: item.change })
    })
    on('relay', m => { if (m.kind === 'strokePiece') M.applyStrokePiece(this.model, m, this.change, { now: this.now() }) })
    on('groups', ({ groups, roles }) => {
      M.applyGroups(this.model, groups, roles, this.change)
      const role = e.is_human ? 'human' : 'agent'
      if (this.model.room.my_role !== role) { this.model.room.my_role = role; this.change.room = true }
    })
    on('accepted', ({ entry }) => this.outboxDone(entry, null))
    on('refused', ({ entry, code }) => this.outboxDone(entry, code))
    on('blocked', blocked => {
      const held = blocked ? this.sending.get(blocked.entry.id) : null
      for (const s of this.sending.values()) if (s.item.outbox_state === 'blocked') { s.item.outbox_state = 'sending'; s.item.error = null }
      if (held) { held.item.outbox_state = 'blocked'; held.item.error = blocked!.code }
      this.model.room.outbox_blocked = blocked ? { local_id: held?.local_id ?? '', code: blocked.code, message: blocked.message } : null
      if (blocked) M.pushAlert(this.model, this.change, { code: 'chain-halted', message: `the hub refused an envelope (${blocked.code}). Sending is halted; the same envelope is tried again.`, at: this.now() })
      this.change.outbox = this.change.room = true
    })
    // (a device that was removed stays `removed`: that is the last word on its connection)
    on('connection', connection => { if (this.removed) return; this.model.room.connection = connection; this.change.room = true })
    on('alert', a => { M.pushAlert(this.model, this.change, { code: a.code, message: a.message, envelope_number: a.change, at: this.now() }) })
    on('stream', event => this.onStream(event))
    on('invites', ({ open }) => this.invitesDone(open))
    on('rescanned', () => { if (this.rebuilding) { this.rebuilding = false; this.rebuild = null; this.touched() } })
    on('batch', () => this.publish())
    on('reopened', () => { void this.reconcile().catch(() => {}) })
    on('closed', ({ code }) => {
      if (code === 'removed') {
        this.removed = true
        ;(this.model.room as { connection: string }).connection = 'removed'
        this.change.room = true
        // said once, however this device processed the Commit that removed it (in the room's log, or served by the
        // hub's removal route after a `not-member`): never on the hub's word alone
        if (!this.model.alerts.some(x => x.code === 'removed')) M.pushAlert(this.model, this.change, { code: 'removed', message: 'this device was removed from the room', at: this.now() })
        this.publish()
      }
      // the hub no longer takes this device and the device did not confirm it: nothing is wiped, nothing more is
      // asked of the hub on this page; the app says so neutrally (a reload tries again)
      else if (code === 'unreachable') {
        ;(this.model.room as { connection: string }).connection = 'unreachable'
        this.change.room = true
        this.publish()
      }
      // tabs.ts drops this client and stands in line for the device's lock again
      else this.emit('device-closed', null)
    })
  }
  private onStream(event: StreamEvent): void {
    switch (event.event) {
      case 'presence':
        M.applyPresence(this.model, [{ device_id: hex(event.device), is_online: event.online, offline_since: event.online ? null : this.now(),
          link: event.hears === null ? null : { hears: event.hears ? 'live' : 'oncall', attached: true, working: event.working === true, last_call_at: event.last_call_at } }], this.change, this.now())
        if (event.lost) M.pushAlert(this.model, this.change, { code: 'agent-lost', message: 'An agent lost its connection.', sender_device_id: hex(event.device), at: this.now() })
        this.publish()
        return
      case 'invite_request': void this.checkInvite(hex(event.invite_id)).catch(() => {}); return
      case 'file_evicted': this.attachmentCache.delete(hex(event.file_id)); return
      case 'archived': void this.engine.archive(event.group).catch(() => {}); return
      default:
    }
  }
  /** The hub answered an outbox entry: its item leaves model.outbox; a refusal takes the echo back first. */
  private outboxDone(entry: OutboxEntry, refusal: string | null): void {
    const sent = this.sending.get(entry.id)
    if (!sent) return
    this.sending.delete(entry.id)
    const ch = this.change
    if (refusal) {
      // the views see the item `failed` in the change that takes the echo back
      sent.item.outbox_state = 'failed'; sent.item.error = refusal
      // a refused Note version: the edit that waited behind it is tried on what stands
      for (const [id, busy] of this.noteBusy) if (busy.outbox === entry.id) this.noteBack(id)
      M.rollbackEcho(this.model, sent.local_id, ch)
      M.pushAlert(this.model, ch, { code: refusal, message: `the hub refused an envelope (${refusal})`, at: this.now() })
      ch.outbox = true
      this.publish()
    }
    const at = this.model.outbox.indexOf(sent.item)
    if (at >= 0) this.model.outbox.splice(at, 1)
    this.change.outbox = true
  }
  /** After the device was opened again: an echo whose envelope is not in the stored outbox was never sealed. */
  private async reconcile(): Promise<void> {
    const stored = new Set((await this.engine.outbox()).map(e => e.id))
    this.tell(ch => {
      for (const [id, sent] of this.sending) {
        if (stored.has(id)) continue
        this.sending.delete(id)
        M.rollbackEcho(this.model, sent.local_id, ch)
        const at = this.model.outbox.indexOf(sent.item)
        if (at >= 0) this.model.outbox.splice(at, 1)
        ch.outbox = true
      }
    })
  }

  // ---- life

  /** Starts the engine: the outbox is sent, the hub's order taken, the stream opened (`stream: false`: none). */
  async start({ stream = true }: { stream?: boolean; process_instance?: string | null } = {}): Promise<void> {
    if (this.started) return
    this.started = true
    if (this.rebuild !== null) await this.fromDesk().catch(() => {})
    if (!this.started) return
    await this.engine.start({ stream })
    if (!this.started) return     // stopped meanwhile: no timer is left behind
    if (this.rebuild !== null) { this.rebuilding = true; await this.engine.wantRescan(this.rebuild) }
    this.inviteTimer = setInterval(() => this.watchInvites(), 1000)
    void this.nameDevice().catch(() => {})
  }
  /** Stops everything, writes the cache and closes the device (its store and lock with it). */
  async stop(): Promise<void> {
    this.started = false
    if (this.inviteTimer !== null) { clearInterval(this.inviteTimer); this.inviteTimer = null }
    if (this.goalsTimer !== null) { clearTimeout(this.goalsTimer); this.goalsTimer = null }
    await this.engine.stop()
    for (const off of this.offs.splice(0)) off()
    await this.flush().catch(() => {})
  }
  catchUp(): Promise<void> { return this.engine.catchUp() }
  /** Waits until the outbox is empty and the hub's copies came back. */
  async settle({ timeout_ms = 10_000 }: { timeout_ms?: number } = {}): Promise<void> { await this.engine.settle(timeout_ms) }

  /** A model without a usable cache: the open objects and the registers at once, from the hub's Desk, each read
   *  back through the core (it holds their chains already). The rest comes with the rescan. */
  private async fromDesk(): Promise<void> {
    const desk = await this.hub.desk()
    const items: EnvelopeItem[] = [...desk.registers]
    for (const list of [desk.cards, desk.notes, desk.permission_requests, desk.artifacts]) for (const o of list) if (o.version) items.push(o.version)
    items.sort((a, b) => a.change - b.change)
    const received = await this.engine.receivePage(items)
    this.tell(ch => { for (const r of received) if (r.outcome !== 'refused') M.applyEnvelope(this.model, r, ch, { now: this.now() }) })
  }
  private async nameDevice(): Promise<void> {
    const name = this.opts.device_name
    if (!name || !this.is_human) return
    const me = this.model.members.get(this.my_device_id)
    if (me?.device_name === name) return
    const info = (this.opts.device_info && typeof this.opts.device_info === 'object' ? this.opts.device_info : {}) as Fields
    await this.setRegisters({ [`device/${this.my_device_id}`]: { ...info, device_name: name } })
  }

  // ---- sending: echo, seal, outbox

  /** Seals drafts of one echo and puts their items into model.outbox. A failure takes the echo back. */
  private async send(local_id: string, drafts: { draft: Draft; recipient?: string | null; files?: Uint8Array[]; item?: Partial<OutboxItem> }[], after?: (sealed: Sealed) => void): Promise<Sent> {
    let last: Sealed | null = null
    try {
      for (const d of drafts) {
        const sealed = last = await this.engine.seal(d.draft, d.recipient ? unhex(d.recipient) : null, d.files ?? [])
        const item: OutboxItem = { local_id, envelope_kind: d.draft.kind, object_id: null, timeline_key: null, recipient_device_id: d.recipient ?? null, outbox_state: 'sending', error: null, ...d.item }
        this.sending.set(sealed.outboxId, { local_id, item })
        this.tell(ch => { this.model.outbox.push(item); ch.outbox = true; M.confirmEcho(this.model, local_id, sealed, ch); after?.(sealed) })
      }
    } catch (e) {
      // what was sealed stays sealed (its number is used); what the echo showed beyond that is taken back
      if (!last) this.tell(ch => M.rollbackEcho(this.model, local_id, ch))
      throw e
    }
    return { local_id, envelope_hash: hex(last!.envelopeHash), seq: last!.seq }
  }
  private needHuman(): void { if (!this.is_human) fail('forbidden', 'only a human device can do this') }
  private card(object_id: string): Card { return this.model.cards.get(object_id) ?? fail('not-found', `no card ${object_id}`) }
  private sessionGroup(session_id: string): Uint8Array { return this.core.sessionGroupId(this.room_id, unhex(session_id)) }
  /** The session an agent device speaks in. */
  sessionOfAgent(agent_device_id: string): string | null {
    for (const s of this.model.sessions.values()) if (s.is_active && s.agent_device_id === agent_device_id) return s.session_id
    for (const s of this.model.sessions.values()) if (s.agent_device_ids.includes(agent_device_id)) return s.session_id
    return null
  }

  // ---- human actions (README "Human actions")

  /** A Chat message to a session's agent, or on a card. */
  async sendMessage({ agent_device_id = null, object_id = null, session_id = null, ...fields }: { agent_device_id?: string | null; object_id?: string | null; session_id?: string | null; [field: string]: unknown }): Promise<Sent> {
    const card = object_id ? this.card(object_id) : null
    const sid = card?.session_id ?? session_id ?? (agent_device_id ? this.sessionOfAgent(agent_device_id) : null)
    if (!sid) return fail('bad-argument', 'a message names a session (with an agent) or a card')
    const recipient = this.is_human ? (card ? M.holderOf(this.model, card) : null) ?? M.recipientOf(this.model, sid) : null
    const content = { content_type: 'message', ...fields }
    const payload = encodeBodyBytes('message', content)
    const timeline_key = M.timelineKey('chat', object_id ? `card/${object_id}` : `session/${sid}`)
    const local_id = `local-${randomHex(8)}`
    this.tell(ch => M.echoTimelineItem(this.model, { local_id, timeline_key, content, recipient_device_id: recipient, object_id, now: this.now() }, ch))
    const draft: Draft = object_id ? { kind: 'cardChat', session: unhex(sid), card: unhex(object_id), payload } : { kind: 'sessionChat', session: unhex(sid), payload }
    return this.send(local_id, [{ draft, recipient, files: fileIdsOf('message', content), item: { timeline_key, object_id, content } }])
  }

  async answer({ object_id, choices = [], note, option_notes, attachments, marks, trusted, answer_action = 'answer' }: { object_id: string; choices?: string[]; note?: string | null | undefined; option_notes?: Record<string, string> | undefined; attachments?: AttachmentRef[] | undefined; marks?: unknown[] | undefined; trusted?: boolean | undefined; answer_action?: string }): Promise<Sent> {
    this.needHuman()
    const card = this.card(object_id)
    if (card.object_state !== 'open') fail('card-closed', 'the card is not open')
    // a card of a newer version is never answered by what this version guesses it means
    if (!M.cardSupported(card)) fail('needs-update', UPDATE_MESSAGE)
    if (card.content_state !== 'ok') fail('card-pruned', 'this device holds only the header of this card; answer it on a device that shows it')
    if (!card.session_id) fail('not-found', 'the card has no session')
    const content: Fields = { answer_action, choices, note, option_notes, attachments, marks, trusted }
    // An answer whose every choice is an option the agent marked final settles the card in the same step, as read
    // and shred close it. Anything said beside the choice is for the agent to read, so the card stays with it; so
    // does a trusted answer, where the agent still chooses.
    const plain = !String(note ?? '').trim() && !Object.values(option_notes ?? {}).some(v => String(v ?? '').trim()) && !attachments?.length && !marks?.length
    const settles = answer_action === 'answer' && !trusted && plain && M.choicesFinal(card, choices)
    const state = answer_action === 'answer' && !settles ? 'answered' : 'closed'
    const recipient = M.holderOf(this.model, card)
    const echo: Omit<Answer, 'pending'> = { answer_action, choices, note: note ?? null, option_notes: option_notes ?? {}, attachments: attachments ?? [], marks: marks ?? [], trusted: !!trusted,
      bound_version_hash: card.version_hash, bound_object_version: card.object_version, envelope_number: null, envelope_hash: null, by_device_id: this.my_device_id, answered_at: this.now(), taken_back_at: null, taken_back_sent_at: null }
    const local_id = `local-${randomHex(8)}`
    this.tell(ch => { M.echoAnswer(this.model, { local_id, object_id, answer: echo, object_state: state }, ch) })
    const draft: Draft = { kind: 'answer', session: unhex(card.session_id!), objectId: unhex(object_id), choices, closes: state === 'closed', payload: encodeBodyBytes('answer', content) }
    return this.send(local_id, [{ draft, recipient, files: fileIdsOf('answer', content), item: { object_id, content } }])
  }
  trust({ object_id, note }: { object_id: string; note?: string | null }): Promise<Sent> {
    const card = this.card(object_id)
    const recommended = card.recommended == null ? [] : Array.isArray(card.recommended) ? card.recommended : [card.recommended]
    return this.answer({ object_id, choices: recommended, note, trusted: true })
  }
  markRead({ object_id }: { object_id: string }): Promise<Sent> { return this.answer({ object_id, answer_action: 'read' }) }
  shred({ object_id, note }: { object_id: string; note?: string | null }): Promise<Sent> { return this.answer({ object_id, answer_action: 'shred', note }) }

  /** Takes the answer in force back: the card is open again. */
  async decideAgain({ object_id }: { object_id: string }): Promise<Sent> {
    this.needHuman()
    const card = this.card(object_id)
    if (!card.answer?.envelope_hash || !card.session_id) fail('decision-mismatch', 'no answer in force to take back')
    const draft: Draft = { kind: 'takeBack', session: unhex(card.session_id!), objectId: unhex(object_id), payload: encodeBodyBytes('take_back', {}) }
    return this.send(`local-${randomHex(8)}`, [{ draft, recipient: M.holderOf(this.model, card), item: { object_id } }])
  }

  async verdict({ object_id, allow }: { object_id: string; allow: boolean }): Promise<Sent> {
    this.needHuman()
    const p = this.model.permissions.get(object_id) ?? fail('not-found', 'no such permission request')
    if (!p.session_id) fail('not-found', 'the request has no session')
    const draft: Draft = { kind: 'verdict', session: unhex(p.session_id!), requestId: unhex(object_id), allow: !!allow, payload: encodeBodyBytes('verdict', {}) }
    return this.send(`local-${randomHex(8)}`, [{ draft, recipient: M.holderOf(this.model, p), item: { object_id } }])
  }

  /**
   * Registers, one envelope per name. Without `session_id`: the room's (shared by human devices, shown at once), and
   * this device's own `device/<id>`. With it: a register of that session's group (`goals`), no echo.
   */
  async setRegisters(values: Record<string, unknown>, { session_id = null }: { own_device?: boolean; session_id?: string | null } = {}): Promise<Sent> {
    const keys = Object.keys(values)
    if (!keys.length) return fail('bad-argument', 'no register to set')
    for (const k of keys) if (k.startsWith('device/') && k !== `device/${this.my_device_id}`) fail('forbidden', 'a device writes only its own device register')
    const group = session_id ? this.sessionGroup(session_id) : this.core.roomGroupId(this.room_id)
    if (!session_id) this.needHuman()
    // one echo and one envelope per name: a name whose sealing fails is taken back alone
    let last: Sent | null = null
    for (const key of keys) {
      const local_id = `local-${randomHex(8)}`
      if (!session_id && !key.startsWith('device/')) this.tell(ch => M.echoRegisters(this.model, { local_id, values: { [key]: values[key] ?? null } }, ch))
      const { name, value } = encodeRegister(key, values[key] ?? null)
      last = await this.send(local_id, [{ draft: { kind: 'register', group, name, value }, files: fileIdsOf('register', { value: values[key] }), item: { content: { key } } }])
      if (key.startsWith('session/') && (values[key] as { archived?: unknown } | null)?.archived === true) void this.archive(key.slice('session/'.length)).catch(() => {})
    }
    return last!
  }
  /** An archived session is over for good (5.2.10): the hub takes nothing more for its group, and neither does this device. */
  private async archive(session_id: string): Promise<void> {
    const group = this.engine.groups.find(g => g.session && hex(g.session.sessionId) === session_id)
    if (!group || group.archived) return
    await this.hub.archiveGroup(group.group)
    await this.engine.archive(group.group)
  }
  setDraft(object_id: string, draft: unknown): Promise<Sent> { return this.setRegisters({ [`draft/${object_id}`]: draft ?? null }) }
  snooze(object_id: string, until: number | null | undefined): Promise<Sent> { return this.setRegisters({ [`snooze/${object_id}`]: until == null ? null : { until } }) }
  duck(object_id: string, value: unknown): Promise<Sent> { return this.setRegisters({ [`duck/${object_id}`]: value ?? null }) }
  setCrown(value: unknown): Promise<Sent> { return this.setRegisters({ crown: value ?? null }) }
  setDesk(desk_id: string, value: unknown): Promise<Sent> { return this.setRegisters({ [`desk/${desk_id}`]: value ?? null }) }

  /** A note's version this device confirmed last (what came back from the hub), under any echo in front of it. */
  private noteHead(object_id: string): { object_version: number; version_hash: string | null; content: Fields } | null {
    const m = this.model.notes.get(object_id)
    const base = m?.pending ? m._base : m
    return base ? { object_version: base.object_version, version_hash: base.version_hash, content: noteFields(base) } : null
  }
  /**
   * A note's version. The core takes a later version only on one it holds, and it holds an own version once that
   * came back from the hub. So while a version of a note is on its way, a further edit is shown at once and kept
   * here; only the newest is kept, and it is sealed when the one before it is back. (An edit that waits like that
   * is in memory only: it is lost if the app ends before the earlier version returned.)
   */
  private async writeNote(object_id: string | null, fields: Fields, closed: boolean): Promise<string> {
    this.needHuman()
    if (object_id && this.model.notes.get(object_id)?.unsupported) fail('needs-update', UPDATE_MESSAGE)
    if (object_id && !this.model.notes.get(object_id)) fail('not-found', 'no such note')
    const { object_state: _state, ...own } = fields
    const local_id = `local-${randomHex(8)}`
    const busy = object_id ? this.noteBusy.get(object_id) : undefined
    if (busy) {
      this.tell(ch => { if (busy.next) M.rollbackEcho(this.model, busy.next.local_id, ch); M.echoNote(this.model, { local_id, object_id, fields: closed ? {} : own, closed }, ch) })
      busy.next = { own: { ...(busy.next?.own ?? {}), ...own }, closed, local_id }
      return object_id!
    }
    this.tell(ch => { M.echoNote(this.model, { local_id, object_id, fields: closed ? {} : own, closed }, ch) })
    return this.sealNote(object_id, own, closed, local_id)
  }
  private async sealNote(object_id: string | null, own: Fields, closed: boolean, local_id: string): Promise<string> {
    const head = object_id ? this.noteHead(object_id) : null
    // one above every lamport this device has seen on a note (9.3.2 chooses the current version by it)
    for (const n of this.model.notes.values()) this.lamport = Math.max(this.lamport, n.causal?.lamport ?? 0, n._base?.causal?.lamport ?? 0)
    const content: Fields = { ...(head?.content ?? {}), ...own, object_version: (head?.object_version ?? 0) + 1, lamport: ++this.lamport }
    // every version names the one before it; a first version names zeros (spec 9, `object_ref`)
    content['previous_version_hash'] = head?.version_hash ?? '0'.repeat(64)
    for (const k of Object.keys(content)) if (content[k] === undefined) delete content[k]
    const payload = encodeBodyBytes('note', content)
    let id = object_id
    const draft: Draft = object_id ? { kind: 'noteVersion', objectId: unhex(object_id), closed, payload } : { kind: 'noteFirst', payload }
    await this.send(local_id, [{ draft, files: fileIdsOf('note', content), item: { object_id, content } }], sealed => {
      id = sealed.objectId ? hex(sealed.objectId) : id
      this.noteBusy.set(id!, { hash: hex(sealed.envelopeHash), outbox: sealed.outboxId, next: null })
    })
    return id!
  }
  /** A note's version is back from the hub, or was refused: the edit that waited behind it is sealed now. */
  private noteBack(object_id: string): void {
    const busy = this.noteBusy.get(object_id)
    if (!busy) return
    this.noteBusy.delete(object_id)
    const next = busy.next
    if (next) void this.sealNote(object_id, next.own, next.closed, next.local_id).catch(() => {})
  }
  /** A new note or a new version of one: in model.notes at once (a new one first under its local id). Resolves to its object id. */
  saveNote({ object_id = null, ...fields }: { object_id?: string | null; [field: string]: unknown }): Promise<string> {
    return this.writeNote(object_id, fields, fields['object_state'] === 'closed')
  }
  /** A closed version. */
  async deleteNote(object_id: string): Promise<string> { return this.writeNote(object_id, {}, true) }

  /**
   * Scribble Board items: strokes, erase, move, send_away on `desk/<board>`. `selection_sent` (the views' "send what
   * I selected to an agent") is two writes under v2: a Chat message with the picture to that session, and
   * `send_away` of the shapes on the board they came from.
   */
  async sendStrokes({ timeline_id, content_type = 'strokes', recipient_device_id = null, ...fields }: { timeline_id: string; content_type?: string; recipient_device_id?: string | null; [field: string]: unknown }): Promise<Sent> {
    this.needHuman()
    const scope = timeline_id.slice(0, timeline_id.indexOf('/')), id = timeline_id.slice(timeline_id.indexOf('/') + 1)
    if (content_type === 'selection_sent') {
      const { stroke_ids, board, ...message } = fields
      const session_id = this.model.sessions.has(id) ? id : this.sessionOfAgent(recipient_device_id ?? id)
      const sent = await this.sendMessage({ session_id, ...message })
      if (Array.isArray(stroke_ids) && stroke_ids.length && typeof board === 'string') await this.sendStrokes({ timeline_id: board, content_type: 'send_away', stroke_ids })
      return sent
    }
    if (scope !== 'desk') return fail('bad-argument', 'a board item goes to desk/<board>')
    const content = { content_type, ...fields }
    const payload = encodeBodyBytes('board_item', content)
    const timeline_key = M.timelineKey('scribble', timeline_id)
    const local_id = `local-${randomHex(8)}`
    this.tell(ch => M.echoTimelineItem(this.model, { local_id, timeline_key, content, now: this.now() }, ch))
    return this.send(local_id, [{ draft: { kind: 'boardItem', board: unhex(id), payload }, files: fileIdsOf('board_item', content), item: { timeline_key, content } }])
  }
  /** The points of a stroke still being drawn (7.2), to the other human devices that are connected: not stored,
   *  not echoed. `piece`: { stroke (32 hex), number (from 1), tool, color, width, points (packed, scribble.ts) }. */
  async sendStrokePiece({ timeline_id, ...piece }: { timeline_id: string; stroke: string; number: number; tool: string; color?: string | null; width?: number | null; points: string }): Promise<void> {
    this.needHuman()
    const board = unhex(timeline_id.slice(timeline_id.indexOf('/') + 1))
    const bytes = new TextEncoder().encode(encodePiece(piece))
    await this.engine.do(d => d.sendStrokePiece(board, bytes))
  }

  // ---- timelines: lazy, newest first

  private async cached(timeline_key: string, opts: { before?: number; after?: number; limit?: number; reverse?: boolean }): Promise<TimelineItem[]> {
    const prefix = `tl/${timeline_key}/`
    const rows = await this.cache.range(prefix, {
      ...(opts.before !== undefined && Number.isFinite(opts.before) ? { before: M.cacheItemKey(timeline_key, opts.before) } : {}),
      ...(opts.after !== undefined ? { after: M.cacheItemKey(timeline_key, opts.after) } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}), reverse: opts.reverse ?? false,
    })
    return rows.map(([, v]) => v as TimelineItem)
  }
  /** One page of a Chat or a board from the hub, read by the core out of the hub's order. */
  private async page(timeline_key: string, opts: { before?: number; after?: number; limit: number }): Promise<{ received: ReceivedEnvelope[]; more: boolean; last: number }> {
    const p = M.parseTimelineKey(timeline_key), ref = unhex(p.scope_id)
    const got = p.timeline_kind === 'scribble'
      ? await this.hub.boardItems(ref, { after_change: opts.after ?? 0, limit: opts.limit })
      : await this.hub.chatItems(p.scope as 'session' | 'card', ref, { ...(opts.before !== undefined && Number.isFinite(opts.before) ? { before: opts.before } : {}), limit: opts.limit })
    // `last`: how far the hub's page went, whatever of it could be read
    return { received: (await this.engine.receivePage(got.items)).filter(r => r.outcome !== 'refused'), more: got.more, last: got.items.at(-1)?.change ?? 0 }
  }
  /** Older items of a timeline, newest first: from the cache where it holds them, else the hub's page. `into`: the
   *  model the hub's page is applied to (the client's own, or a scratch one for a read that must not grow the window). */
  private async older(timeline_key: string, before: number, limit: number, into: Model, ch: Change): Promise<{ items: TimelineItem[]; more: boolean }> {
    await this.flush().catch(() => {})
    const local = await this.cached(timeline_key, { before, limit, reverse: true })
    if (local.length >= limit) return { items: local, more: true }
    let more = false
    try {
      const page = await this.page(timeline_key, { before, limit })
      more = page.more
      const t = M.timelineOf(into, timeline_key)
      t.window_open = true
      for (const r of page.received) M.applyEnvelope(into, r, ch, { now: this.now() })
      const merged = new Map<number, TimelineItem>(local.map(i => [i.envelope_number!, i]))
      for (const r of page.received) { const item = t.items.get(r.change); if (item) merged.set(r.change, merged.get(r.change)?.content && !item.content ? merged.get(r.change)! : item) }
      return { items: [...merged.values()].sort((a, b) => b.envelope_number! - a.envelope_number!).slice(0, limit), more }
    } catch (e) {
      // offline: what the cache holds is what there is
      if (!(e instanceof HubError) || !e.transient) throw e
      return { items: local, more: local.length > 0 }
    }
  }
  /** Loads the next older page of a timeline into the window. */
  async loadTimeline(timeline_key: string, { limit = 50 }: { limit?: number } = {}): Promise<{ loaded: number; has_more: boolean }> {
    // a board has no pages towards the past (its route reads forwards from a change): all of it, once
    if (timeline_key.startsWith('scribble:')) return { loaded: (await this.loadTimelineAfter(timeline_key, 0)).loaded, has_more: false }
    const t = M.timelineOf(this.model, timeline_key)
    t.window_open = true
    const ch = M.emptyChange()
    const { items, more } = await this.older(timeline_key, t.loaded_down_to, limit, this.model, ch)
    for (const it of items) { if (!t.items.get(it.envelope_number!)?.content) t.items.set(it.envelope_number!, it); M.addItem(ch, timeline_key, t.items.get(it.envelope_number!)!) }
    if (items.length) t.loaded_down_to = Math.min(t.loaded_down_to, items.at(-1)!.envelope_number!)
    t.has_more = more && items.length > 0
    ch.timelines.add(timeline_key)
    this.tell(now => { for (const k of ch.timelines) now.timelines.add(k); for (const [k, list] of ch.items) for (const it of list) M.addItem(now, k, it); for (const c of ch.cards) now.cards.add(c); for (const s of ch.sessions) now.sessions.add(s) })
    return { loaded: items.length, has_more: t.has_more }
  }
  /** A windowed read for scrolling: items before an envelope number, oldest first. Does not grow the window. */
  async timelineWindow(timeline_key: string, { before_envelope_number = Infinity, limit = 50 }: { before_envelope_number?: number; limit?: number } = {}): Promise<TimelineItem[]> {
    const { items } = await this.older(timeline_key, before_envelope_number, limit, M.emptyModel(), M.emptyChange())
    return items.reverse()
  }
  /** A board's tail after a snapshot: every item after an envelope number, oldest first, all pages. */
  async loadTimelineAfter(timeline_key: string, after_envelope_number: number): Promise<{ loaded: number; items: TimelineItem[]; has_more: false }> {
    const t = M.timelineOf(this.model, timeline_key)
    t.window_open = true
    const ch = M.emptyChange()
    const out = new Map<number, TimelineItem>()
    await this.flush().catch(() => {})
    for (const it of await this.cached(timeline_key, { after: after_envelope_number })) out.set(it.envelope_number!, it)
    try {
      for (let after = after_envelope_number; ;) {
        const page = await this.page(timeline_key, { after, limit: 500 })
        for (const r of page.received) {
          M.applyEnvelope(this.model, r, ch, { now: this.now() })
          const item = t.items.get(r.change)
          if (item && !(out.get(r.change)?.content && !item.content)) out.set(r.change, item)
        }
        if (!page.more || page.last <= after) break
        after = page.last
      }
    } catch (e) {
      // not reached: what the cache holds is given if it holds anything, else the caller hears that nothing was read
      if (!(e instanceof HubError) || !e.transient || !out.size) throw e
    }
    const items = [...out.values()].sort((a, b) => a.envelope_number! - b.envelope_number!)
    for (const it of items) { if (!t.items.get(it.envelope_number!)?.content) t.items.set(it.envelope_number!, it); M.addItem(ch, timeline_key, it) }
    ch.timelines.add(timeline_key)
    this.tell(now => { for (const k of ch.timelines) now.timelines.add(k); for (const [k, list] of ch.items) for (const it of list) M.addItem(now, k, it) })
    return { loaded: items.length, items, has_more: false }
  }

  // ---- attachments and Share links

  /** Encrypts and stores a file; the reference goes into the body that names it. Its plaintext is kept in memory. */
  async uploadAttachment(data: Uint8Array | ArrayBuffer | Blob, meta: Record<string, unknown> = {}): Promise<AttachmentRef> {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data
    const { file, size } = await putEncrypted(this.core, this.hub, bytes)
    const ref = attachmentRef(file, { ...meta, total_size: size })
    if (bytes instanceof Uint8Array) this.remember(ref.attachment_id, bytes)
    return ref
  }
  private remember(id: string, bytes: Uint8Array): void {
    if (this.attachmentCache.size > 64) this.attachmentCache.delete(this.attachmentCache.keys().next().value!)
    this.attachmentCache.set(id, bytes)
  }
  async fetchAttachment(ref: AttachmentRef): Promise<Uint8Array> {
    const hit = this.attachmentCache.get(ref.attachment_id)
    if (hit) return hit
    const bytes = await getDecrypted(this.core, this.hub, fileRefOf(ref))
    this.remember(ref.attachment_id, bytes)
    return bytes
  }
  async attachmentBlob(ref: AttachmentRef): Promise<Blob> { return new Blob([await this.fetchAttachment(ref) as Uint8Array<ArrayBuffer>], { type: ref.media_type ?? 'application/octet-stream' }) }

  /** A link for someone outside the room to one file of an open Artifact (11.5): the hub learns the hash of the
   *  link's secret, never the key. `keep_link`: the link is kept in this device's cache for the Links page. */
  async shareAttachment(ref: AttachmentRef, { expires_at = this.now() + 30 * DAY - 60_000, app_url = 'https://app.trommi.com', keep_link = false }: { expires_at?: number; app_url?: string; keep_link?: boolean } = {}): Promise<{ share_id: string; link: string; expires_at: number }> {
    const share = this.core.shareLinkCreate(originOf(app_url), fileRefOf(ref))
    const made = await this.hub.postShare({ share_id: share.shareId, secret_hash: share.secretHash, file_id: unhex(ref.attachment_id), expires_at })
    const share_id = hex(share.shareId)
    const shares = await this.shares()
    shares[share_id] = { attachment_id: ref.attachment_id, expires_at: made.expires_at, ...(keep_link ? { link: share.text, created_at: this.now() } : {}) }
    for (const [id, s] of Object.entries(shares)) if (s.expires_at < this.now()) delete shares[id]
    await this.cache.set('client/shares', shares)
    return { share_id, link: share.text, expires_at: made.expires_at }
  }
  private async shares(): Promise<Record<string, { attachment_id: string; expires_at: number; link?: string; created_at?: number }>> {
    return ((await this.cache.get('client/shares')) ?? {}) as Record<string, { attachment_id: string; expires_at: number; link?: string; created_at?: number }>
  }
  /** The open shares this device made, newest first; `link` only where it was kept. */
  async myShares(): Promise<{ share_id: string; attachment_id: string; expires_at: number; link?: string; created_at?: number }[]> {
    return Object.entries(await this.shares()).filter(([, s]) => s.expires_at > this.now()).map(([share_id, s]) => ({ share_id, ...s })).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
  }
  async revokeShare(share_id: string, _opts: { attachment_id?: string | null } = {}): Promise<void> {
    await this.hub.deleteShare(unhex(share_id))
    const shares = await this.shares()
    delete shares[share_id]
    await this.cache.set('client/shares', shares)
  }

  // ---- invites (12.1): the inviter's side

  private setInvite(invite_id: string, fields: Partial<Invite> & { done?: boolean }): void {
    const kept = this.invites.get(invite_id)
    if (!kept) return
    const { done, ...shown } = fields
    Object.assign(kept.public, shown)
    if (done) kept.done = true
    void this.cache.set(`client/invite/${invite_id}`, kept).catch(() => {})
    this.tell(ch => ch.invites.add(invite_id))
  }
  /**
   * An invite link for a human device or an agent. Every invite is bound to the device the human confirms: both
   * sides show the same six emoji, and `confirmInvite` adds the newcomer or burns the link. `takeover` with
   * `session_id`: the agent that joins continues that session and the device that held it is removed (5.3, 13.5).
   */
  async createInvite({ device_role = 'human', app_url = 'https://app.trommi.com/join', label = null, session_id = null, with_history, takeover = false, desk = null }: { device_role?: 'human' | 'agent'; app_url?: string; ttl_ms?: number; label?: string | null; session_id?: string | null; with_history?: boolean; takeover?: boolean; desk?: string | null } = {}): Promise<Invite> {
    this.needHuman()
    if (takeover && (device_role !== 'agent' || !session_id || !this.model.sessions.get(session_id)?.group_id)) fail('bad-argument', 'a takeover invite names an existing session and is for an agent')
    const opened = await this.engine.do(d => d.inviteOpen(device_role, takeover ? unhex(session_id!) : null, originOf(app_url), this.hub.hub_url, this.now()))
    await this.hub.postInvite(opened.offer, opened.signature, opened.mac)
    const invite_id = hex(opened.inviteId)
    const pub: Invite = { invite_id, device_role, link: opened.link, label: label ?? '', session_id: takeover ? session_id : null, with_history: takeover ? with_history !== false : !!with_history, takeover: !!takeover,
      desk: device_role === 'agent' && !takeover && typeof desk === 'string' && desk ? desk.slice(0, 64) : null, confirm_code: true, expires_at: opened.expiresAt, check_code: null, invite_state: 'open', newcomer: null, error: null }
    this.invites.set(invite_id, { public: pub })
    this.model.invites.set(invite_id, pub)
    this.setInvite(invite_id, {})
    return pub
  }
  /** Once a second while invites are open: expiry, and a look for the Request (the stream's event comes first when it comes). */
  private watchInvites(): void {
    for (const [id, kept] of this.invites) {
      if (kept.done) continue
      const state = kept.public.invite_state
      if (state === 'open' && this.now() > kept.public.expires_at) this.setInvite(id, { invite_state: 'expired', done: true })
      else if (state === 'confirm_code' && this.now() > (kept.checked_at ?? 0) + INVITE_CONFIRM_MS) this.setInvite(id, { invite_state: 'expired', error: 'invite-expired', done: true })
      else if (state === 'open') void this.checkInvite(id).catch(() => {})
    }
  }
  private async checkInvite(invite_id: string): Promise<void> {
    const kept = this.invites.get(invite_id)
    if (!kept || kept.done || kept.public.invite_state !== 'open' || this.checking.has(invite_id)) return
    this.checking.add(invite_id)
    try {
      const id = unhex(invite_id)
      const { requests } = await this.hub.getInvite(id)
      for (const request of requests ?? []) {
        let accepted
        try { accepted = await this.engine.do(d => d.inviteAccept(id, request, this.now())) }
        catch (e) { if (this.core.errorCode(e) === 'invite-expired') { this.setInvite(invite_id, { invite_state: 'expired', error: 'invite-expired', done: true }); return } continue }
        // a lost answer here is tried again at the next look: accepting the same Request again gives the same Reveal
        await this.hub.putReveal(id, accepted.reveal, accepted.signature)
        kept.checked_at = this.now()
        // what the person's confirmation names, kept so that it survives a restart (neither is a secret)
        kept.code = [...accepted.code.numbers]; kept.request_hash = b64u(accepted.requestHash)
        this.setInvite(invite_id, { check_code: codeText(kept.code), newcomer: { device_id: hex(accepted.newDevice), device_name: '' }, invite_state: 'confirm_code' })
        return
      }
    } finally { this.checking.delete(invite_id) }
  }
  /** The human compared the six emoji: `true` adds the newcomer, `false` burns the invite. Resolves once the
   *  newcomer is in and everything that follows is done (keys handed over, sessions joined or founded or taken over). */
  async confirmInvite(invite_id: string, matches: unknown): Promise<void> {
    if (typeof matches !== 'boolean') fail('bad-argument', 'confirmInvite takes true (the codes match) or false (they do not)')
    const kept = this.invites.get(invite_id)
    if (!kept || kept.public.invite_state !== 'confirm_code' || !kept.code || !kept.request_hash) return fail('bad-invite', 'this invite waits for no code')
    const id = unhex(invite_id), code = Uint8Array.from(kept.code), request_hash = unb64u(kept.request_hash)
    if (!matches) {
      await this.engine.do(d => d.inviteConfirm(id, code, request_hash, false, this.now())).catch(() => {})
      this.setInvite(invite_id, { invite_state: 'failed', error: 'code-mismatch', done: true })
      void this.hub.deleteInvite(id).catch(() => {})
      return fail('code-mismatch', 'the check codes do not match: nobody was added, the invite is spent')
    }
    // The core commits the newcomer in the write that finishes the invite: a confirmation is acted on once. What
    // follows is the engine's, step by step as the core lists it (engine.ts `invited`), also after a restart.
    try {
      if (kept.public['takeover'] && kept.public['with_history'] === false) await this.engine.withoutHistory(id)
      await this.engine.do(d => d.inviteConfirm(id, code, request_hash, true, this.now()))
    } catch (err) {
      this.setInvite(invite_id, { invite_state: 'failed', error: String(this.core.errorCode(err) ?? 'failed'), done: true })
      throw err
    }
    kept.committed = true
    this.setInvite(invite_id, { invite_state: 'adding' })
    this.engine.keepSoon(0)
    await new Promise<void>((resolve, reject) => { this.finishing.set(invite_id, { resolve, reject }) })
  }
  /** After each look at the invites' steps: an invite that was committed, has nothing left to do and whose device
   *  is in, is `joined`; one whose device is not in (it was removed again) has failed. */
  private invitesDone(open: readonly string[]): void {
    const e = this.engine
    for (const [invite_id, kept] of this.invites) {
      if (kept.done || kept.public.invite_state !== 'adding' || open.includes(invite_id)) continue
      const device = kept.public.newcomer?.device_id, human = kept.public.device_role === 'human'
      const inside = ((human ? e.roles?.humans : e.roles?.agents) ?? []).some(d => hex(d) === device)
      const waiter = this.finishing.get(invite_id)
      this.finishing.delete(invite_id)
      if (!inside) { this.setInvite(invite_id, { invite_state: 'failed', error: 'removed-sender', done: true }); waiter?.reject(new ClientError('removed-sender', 'the newcomer is not in the room')); continue }
      if (!human && !kept.public['takeover']) {
        // the new agent's session: the name the human chose when inviting, and the desk the invite was made on
        const session = e.groups.find(g => g.session && !g.archived && g.leaves.some(l => hex(l) === device))?.session
        if (session) {
          const session_id = kept.public['session_id'] = hex(session.sessionId)
          const place = { ...(kept.public.label ? { name: kept.public.label } : {}), ...(kept.public['desk'] ? { desk: kept.public['desk'] } : {}) }
          if (Object.keys(place).length) void this.setRegisters({ [`session/${session_id}`]: { ...(this.model.human.session_settings.get(session_id) ?? {}), ...place } }).catch(() => {})
        }
      }
      this.setInvite(invite_id, { invite_state: 'joined', done: true })
      waiter?.resolve()
    }
  }

  // ---- removal (5.2.8)

  /** Removes devices: human devices by one room Commit with their Cuts, agent devices from `agents`; then every
   *  session group that still holds one gets its Remove (5.2.8). Any human device finishes what a crash leaves. */
  async removeDevices(device_ids: string[]): Promise<{ key_epoch: number }> {
    this.needHuman()
    const e = this.engine, room = this.core.roomGroupId(this.room_id)
    const humans = device_ids.filter(id => this.model.members.get(id)?.device_role === 'human').map(unhex)
    const agents = device_ids.filter(id => (e.roles?.agents ?? []).some(a => hex(a) === id)).map(unhex)
    if (humans.length) await e.land(async d => { const cuts = []; for (const h of humans) cuts.push(await d.cutOf(room, h)); return d.removeHumanDevices(cuts, this.now()) })
    if (agents.length) await e.land(d => d.removeAgents(agents, this.now()))
    await e.healNow()
    return { key_epoch: this.model.room.key_epoch }
  }
  /** Log out. The core lets no device commit its own removal, so nothing is removed here: what is still in the
   *  outbox goes out if it can, the client stops, and the caller wipes this device's storage. The device stays a
   *  member (it shows under Devices) until another human device removes it; `removed` says so. */
  async leaveRoom(): Promise<{ key_epoch: number; humans_left: number; removed: false }> {
    this.needHuman()
    try {
      await this.settle({ timeout_ms: 3000 }).catch(() => {})
      const humans_left = [...this.model.members.values()].filter(m => m.is_active && m.device_role === 'human' && m.device_id !== this.my_device_id).length
      return { key_epoch: this.model.room.key_epoch, humans_left, removed: false }
    } finally {
      await this.stop().catch(() => {})
      // the token ends at the hub now, not when it runs out (spec/hub-api.md "Signing out")
      await this.hub.signOut().catch(() => {})
    }
  }

  /** Each live main session on a desk carries that desk's goals for its agent (9.3.4): written when they differ. */
  private goalsSoon(): void {
    if (this.goalsTimer !== null || !this.started) return
    this.goalsTimer = setTimeout(() => { this.goalsTimer = null; void this.syncGoals().catch(() => {}) }, 1500)
  }
  private async syncGoals(): Promise<void> {
    if (!this.started || this.model.room.connection !== 'live') return
    for (const s of this.model.sessions.values()) {
      if (!s.is_active || s.stale || s.parent_session_id || !s.group_id || s.settings?.archived) continue
      const desk_id = s.settings?.desk ?? null
      const desk = desk_id ? this.model.human.desks.get(desk_id) : null
      const goals = M.cleanGoals(desk?.goals)
      const wanted = goals && desk_id ? { desk_id, desk_name: String(desk?.name ?? ''), goals } : null
      const held = s.registers.get('goals')?.value ?? null
      if (JSON.stringify(held) !== JSON.stringify(wanted)) await this.setRegisters({ goals: wanted }, { session_id: s.session_id }).catch(() => {})
    }
  }

  // ---- recovery code (8.6), for account.ts, which holds no key itself

  /** Replaces the recovery code (8.6): the core makes the new one, `account` seals it into the account's new
   *  copies, and one request carries the room Commit, its RecoveryLink and those copies, all or nothing.
   *  `wrong-recovery` (a `code` that is not the one in force) passes through. */
  async replaceRecoveryCode({ code, account }: { code: Uint8Array; account: (new_code: Uint8Array) => Record<string, unknown> | null | Promise<Record<string, unknown> | null> }): Promise<void> {
    this.needHuman()
    const e = this.engine, held = code.slice()
    try {
      const fresh = await e.do(d => d.newRecoveryCode(held))
      let copies: Uint8Array
      try { copies = accountCopiesBytes((await account(fresh)) as AccountCopies | null) } finally { fresh.fill(0) }
      await e.land(d => d.replaceCode(held, copies, this.now()))
    } finally { held.fill(0) }
  }

  /** Resolves only if `code` is the room's recovery code in force, by this device's own verified room state;
   *  `wrong-recovery` otherwise. Sends nothing and leaves nothing behind: the code's signature key is read from a
   *  sign-in it would make (the HubAuth names the key that signs, spec 12.3) and compared with the room's. */
  async checkRecoveryCode(code: Uint8Array): Promise<void> {
    const held = code.slice()
    try {
      const key = this.engine.roles?.recoverySignatureKey
      const { auth } = this.core.recoverySignIn(held, this.room_id, this.hub.hub_url, new Uint8Array(32))
      // HubAuth: room, hub, device, challenge; the device is the 32 bytes before the last 32
      if (!key || !sameBytes(auth.subarray(auth.length - 64, auth.length - 32), key)) fail('wrong-recovery', 'that is not this account\'s recovery code')
    } catch (e) {
      if (e instanceof ClientError) throw e
      fail('wrong-recovery', 'that is not this account\'s recovery code')
    } finally { held.fill(0) }
  }

  // ---- push (15)

  /** Registers this device's Web Push subscription (`subscription.toJSON()`) at a level, or removes it. */
  async pushSubscribe(subscription: unknown, remove = false, level: string | null = null): Promise<void> {
    const s = subscription as { endpoint?: string; keys?: { p256dh?: string; auth?: string } } | null
    if (!s?.endpoint) return fail('bad-argument', 'a push subscription has an endpoint')
    if (remove) { await this.hub.pushRemove(s.endpoint); return }
    if (!s.keys?.p256dh || !s.keys.auth) return fail('bad-argument', 'a push subscription has its keys')
    await this.hub.pushRegister({ web_push: { endpoint: s.endpoint, keys: { p256dh: unb64u(s.keys.p256dh), auth: unb64u(s.keys.auth) } }, level: level === 'knocking' ? 'knocking' : 'all' })
  }
  /** This device's push registrations, as the views read them: `devices[<device id>]`, and the hub's Web Push key. */
  async pushStates(): Promise<{ devices: Record<string, { level: string; endpoints: string[] }>; vapid_public_key: string; apns: boolean }> {
    const state = await this.hub.pushState()
    const devices: Record<string, { level: string; endpoints: string[] }> = {}
    if (state.subscriptions.length) devices[this.my_device_id] = { level: state.subscriptions.some(s => s.level === 'all') ? 'all' : 'knocking', endpoints: state.subscriptions.map(s => s.endpoint) }
    return { devices, vapid_public_key: b64u(state.vapid_public_key), apns: state.apns }
  }
}

export type { EngineMeta }
/** The engine's records in the app's cache, under a prefix of their own. */
export function engineMeta(cache: Cache): EngineMeta {
  return { get: key => cache.get(`engine/${key}`), set: (key, value) => cache.set(`engine/${key}`, value, { durable: true }), delete: key => cache.delete(`engine/${key}`) }
}
/** Whether a register key is one a human device writes into the room group, or one an agent writes into its session. */
const AGENT_KEY = /^(profile|heard|status_line\/.+|alert\/.+)$/
export const isAgentRegisterKey = (key: string): boolean => AGENT_KEY.test(key)
export const isHumanRegisterKey = (key: string): boolean => !isAgentRegisterKey(key) && key !== 'heads' && !key.startsWith('device/')
