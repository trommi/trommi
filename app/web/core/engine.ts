// engine.ts: the one owner of this device's `Device` (core-api.ts) and of everything that must happen to it in a
// fixed order. It knows the core and the hub and nothing of the model or the views: client.ts listens to what it
// reports and builds the model from that.
//
// What it does (spec/v2.md 5, 7, 9, 13.2 to 13.4; core/README.md "How a client uses it"):
//   write, then send   an action seals into the core's outbox and returns; the PUMP posts the outbox, strictly in its
//                      order, one entry in flight, and tells the core the hub's answer
//   catch-up           pages of `GET /v2/changes` after the cursor, to the core in the hub's order: a page in batches
//                      (`feed`: the store writes a batch in one step), each item's outcome told as if it came alone
//   the live stream    the same items as they happen, the relayed stroke pieces, Welcomes, wishes of other devices
//   upkeep             joining by Welcome, the steps of the invites this device confirmed (`inviteSteps`), adding a
//                      human device a live session lacks (5.2.7), cleaning stale sessions (5.2.8), the own-leaf
//                      update (5.2.9), `heads` (9.0.7), KeyPackages, the core's findings
//   recovery           a device that closed itself is opened again from its store
//
// THE INVARIANTS
// 1. One queue (`serial`). Every call into the device that belongs to a step with a meaning runs inside one job of
//    it: an action, the taking of one page or one stream event, the report of one hub answer, one piece of upkeep.
//    Jobs never interleave. The binding runs single calls in order by itself; the queue is for the steps.
// 2. Nothing waits for the network inside the queue, with two exceptions that are short and rare: fetching this
//    device's Welcomes when an item needs one, and the page of a rescan. So an action never waits for a post.
// 3. The pump reads the outbox's head in the queue, posts it OUTSIDE, and reports the answer in the queue. An entry
//    leaves the outbox only by `outboxAccepted` or `outboxRefused`. A transient failure (not reached, 5xx, busy,
//    throttled, a sign-in to make again, a code the core does not know) is the same entry again after a wait:
//    never dropped, never reordered. After a restart the stored outbox is posted again unchanged.
// 4. A definitive refusal is reported to the core (`outboxRefused`) and to the client (the echo is rolled back),
//    and the pump goes on. One case is NOT reported: an envelope the hub refused WITHOUT keeping a void record,
//    for a reason that is not the end of the group or of this device (`BLOCKS`). Its number is not taken at the
//    hub and may never be signed again (9.0.1), so every later envelope of that chain would meet `gap`: the pump
//    halts on it (`blocked`), keeps the bytes and tries them again now and then.
// 5. `epoch-taken`, `room-behind`, `wrong-epoch` and `stale-session` mean the group moved on: the refusal is
//    reported, the log is processed, and whoever asked for the Commit or message (`land`) builds it again.
// 6. The position in the hub's order (`position`, the model's last_envelope_number) moves only in `ingest`, item by
//    item as each one's outcome is told, upwards. Both sources are gap-free from a point at or below the position when their first item is
//    taken (a page starts after the cursor it was asked with; hub.ts's stream resumes after the last change it
//    handed over), so an item at or below the position is one already taken and is skipped. Change numbers are not
//    consecutive for one device (SealedKeys take numbers, other groups' items are not served), so "the next
//    expected number" does not exist; what a hub withholds shows in `heads` (9.0.7), not here.
// 7. An item that does not process halts: `duplicate` is skipped, `early` is tried once more after this device's
//    Welcomes were joined, `badGroup` raises `bad-group`, reports it to the hub (14.7) and stops the batch with the
//    position where it was (13.4: the last good state and cursor are kept), `local` reopens the device. A halted
//    batch is tried again by the next catch-up.
// 8. No timer survives `stop()`. Nothing here logs: errors travel as events with a code.
//
// WHAT THE CORE DOES NOT DO YET, and how this module is written against that (README.md):
// - An envelope that arrived before this device joined its group, or before its key was handed over, is not taken
//   in the hub's order. The engine then reads the room's changes once more from the start (`rescan`): what the
//   chain could not take is taken, what it holds is read back (`receiveEnvelope(…, ordered = false)`).
import { measuring, spent, timed, timedSync } from './spent.ts'
import type {
  Core, Cut, Device, Draft, ErrorCode, Fed, FeedItem, FeedOutcome, GroupSummary, InviteStep, OutboxEntry, Processed, ReceivedEnvelope, ReceivedMessage, RoomRoles, Sealed, Store,
} from './core-api.ts'
import { HubError, logEntry } from './hub.ts'
import type { ChangeItem, EnvelopeItem, Hub, LogItem, NewAccount, OutboxAnswer, StreamEvent } from './hub.ts'
import { hex } from './ids.ts'
import type { Connection } from './types.ts'

/** The engine's own small records beside the device's state (store-idb.ts `Cache` is one). Safe to lose: a lost
 *  record costs a repeated upload or a rescan that is not made. */
export interface EngineMeta {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

export class EngineError extends Error {
  code: string
  constructor(code: string, message: string) { super(message); this.name = 'EngineError'; this.code = code }
}

/** What the engine reports. A `batch` ends every group of reports that belong together: the client projects, tells
 *  the views and writes its cache then. */
export interface EngineEvents {
  /** An envelope as the core took it: in the hub's order, or `again` (a rescan: taken late, or read back). */
  envelope: { received: ReceivedEnvelope; how: 'ordered' | 'again' }
  log: { item: LogItem; done: Processed }
  relay: ReceivedMessage
  groups: { groups: GroupSummary[]; roles: RoomRoles | null }
  sealed: { id: number }
  accepted: { entry: OutboxEntry; change: number | null }
  refused: { entry: OutboxEntry; code: string; voided: boolean }
  /** The pump halts on this entry (invariant 4), or goes on again (null). */
  blocked: { entry: OutboxEntry; code: string; message: string } | null
  connection: Connection
  /** Stream events that are not the engine's to act on: presence, wishes, invite Requests, archived, evicted files. */
  stream: StreamEvent
  /** After each look at the invites' steps: the invites (hex ids) whose device is not let in to the end yet. A
   *  human device counts as in once it was handed the keys: it is added to the live sessions after that, as its
   *  KeyPackages reach the hub, which they do only once it is in. */
  invites: { open: string[] }
  alert: { code: string; message: string; group: Uint8Array | null; change: number | null }
  batch: null
  /** A rescan is through: what the hub holds up to the position was handed to the core once more. */
  rescanned: null
  /** The device was opened again from its store: everything derived from the old object is to be built again. */
  reopened: null
  /** Over: `removed` (this device is no member any more), `device-closed` (another owner, or the store does not open). */
  closed: { code: 'removed' | 'device-closed' | 'unreachable' }
}
type Listener<K extends keyof EngineEvents> = (data: EngineEvents[K]) => void

export interface EngineTiming {
  /** The pump's waits after a transient failure: the first, doubling to the most. */
  backoff_first: number; backoff_max: number
  /** How long the pump waits before it tries a blocking entry again. */
  blocked_retry: number
  /** How long a human device leaves a gap it did not cause (a missing human leaf, a stale session) to the device
   *  that did, before it closes the gap itself (5.2.7, 5.2.8). */
  heal_delay: number
  /** How often the timed upkeep runs: KeyPackages, the own-leaf update, `heads`. */
  upkeep_every: number
  /** How long a halted catch-up waits before it is tried again. */
  halted_retry: number
  /** How long `land` waits for the hub to take, and hand back, what it built. */
  land: number
  /** How long a page that is being taken goes on without a `batch`: what it took so far is reported at least so often. */
  progress: number
}
const TIMING: EngineTiming = { backoff_first: 300, backoff_max: 30_000, blocked_retry: 30_000, heal_delay: 3000, upkeep_every: 600_000, halted_retry: 15_000, land: 60_000, progress: 500 }

export interface EngineOptions {
  core: Core
  hub: Hub
  /** A new store object on this device's stored state: with it, a device that closed itself (a failed write) is
   *  opened again in place. Without it the engine ends with `device-closed` and its host opens the state again: in a
   *  browser that host is tabs.ts, which owns the store's lock and this recovery; a second loop here would fight it. */
  store?: () => Store
  meta: EngineMeta
  now?: () => number
  timing?: Partial<EngineTiming>
}

/** Definitive refusals that end an envelope without a void record and without a hole that matters: the group is
 *  archived, or this device is out. */
const DEAD: readonly string[] = ['gone', 'not-member', 'removed-sender', 'no-room']
/** Refusals that mean "the group moved on under this Commit or message": process the log and build again. */
const MOVED: readonly string[] = ['epoch-taken', 'room-behind', 'wrong-epoch', 'stale-session', 'group-behind']
const PAGE = 500
/** How many items of a page the core is handed in one call (`feed`): one write of the store for all of them. */
const FEED = 200
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i])

/** JSON with its keys in order: two values are the same value exactly when these texts are equal. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v) ?? 'null'
}
/** A catch-up or stream batch stopped at an item that did not process; the position is before it. */
class Halt extends EngineError {}

export class Engine {
  readonly core: Core
  readonly hub: Hub
  device: Device
  device_id: Uint8Array = new Uint8Array(32)
  room_id: Uint8Array | null = null
  is_human = false
  groups: GroupSummary[] = []
  roles: RoomRoles | null = null
  /** How far this device has taken the hub's order: the hub's cursor after the last page or event. */
  position = 0
  /** The device's own cursor: the change number of the last item it was handed. The client's cache is kept with it. */
  cursor = 0
  connection: Connection = 'offline'
  blocked: EngineEvents['blocked'] = null
  readonly timing: EngineTiming

  private readonly opts: EngineOptions
  private readonly now: () => number
  private readonly listeners = new Map<string, Set<(data: never) => void>>()
  private tail: Promise<unknown> = Promise.resolve()
  private running = false
  private over = false
  private pumping: Promise<void> | null = null
  private catching: Promise<void> | null = null
  private again = false
  private keeping: Promise<void> | null = null
  private keepAgain = false
  private closeStream: (() => void) | null = null
  private streamLive = false
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly sleepers = new Set<() => void>()
  /** Who waits for the hub's answer to an outbox entry, and the answers of entries nobody waited for yet. */
  private readonly waiters = new Map<number, (outcome: string) => void>()
  private readonly outcomes = new Map<number, string>()
  private readonly badWelcomes = new Set<string>()
  /** Per group, the log number up to which `handLog` handed the log to the device. */
  private readonly logRead = new Map<string, number>()
  private rescanDue = false
  /** How often an envelope of the hub's order was repaired (a Welcome joined for it, its sender's chain fetched). */
  private repairs = 0
  /** The change after which the next rescan reads (0: everything). */
  private rescanFrom = 0
  private learnDue = false
  /** How often a rescan was asked for: one asked for while a rescan runs is not lost. */
  private rescanAsked = 0
  /** The outbox entry the pump is posting, and the entries whose own Commit came back before their POST was answered. */
  private inFlight: number | null = null
  private readonly merged = new Set<number>()
  private halted = false
  /** Accepted Commits that wait to come back in the hub's order: outbox id -> group (hex). */
  private readonly awaiting = new Map<number, string>()
  /** Upkeep left a gap open that it will look at again (a human device without a KeyPackage at the hub yet). */
  private owing = false
  private timedAt = 0

  constructor(opts: EngineOptions, device: Device) {
    this.opts = opts
    this.core = opts.core
    this.hub = opts.hub
    this.device = device
    this.now = opts.now ?? Date.now
    this.timing = { ...TIMING, ...opts.timing }
  }

  /** Reads what the device is: its id, room, role, groups and cursor; signs it in to the hub from now on. `room`:
   *  the room of a device that is being let in and holds no group of it yet. */
  async load(room: Uint8Array | null = null): Promise<this> {
    await this.serial(async () => {
      const d = this.device
      this.device_id = await d.id()
      this.room_id = (await d.room()) ?? room
      this.cursor = await d.cursor()
      this.position = Math.max(this.position, this.cursor)
      await this.refresh()
      const due = await this.opts.meta.get('rescan').catch(() => null)
      this.rescanDue = due === true || typeof due === 'number'
      this.rescanFrom = typeof due === 'number' ? due : 0
      this.learnDue = (await this.opts.meta.get('learn').catch(() => null)) === true
    })
    // the signer asks whatever device the engine holds at that moment: a reopened one signs as the same key
    if (this.room_id) this.hub.useSigner(this.room_id, (hub, challenge) => this.device.hubSignIn(hub, challenge))
    // every sign-in says what the hub takes this key for: a removed one is checked by the device itself
    this.hub.onRole = role => { if (role === 'removed') this.lost() }
    return this
  }

  // ---- events

  on<K extends keyof EngineEvents>(event: K, fn: Listener<K>): () => void {
    let set = this.listeners.get(event)
    if (!set) this.listeners.set(event, set = new Set())
    set.add(fn as (data: never) => void)
    return () => { set.delete(fn as (data: never) => void) }
  }
  private emit<K extends keyof EngineEvents>(event: K, data: EngineEvents[K]): void {
    // a listener that throws is the listener's fault: the engine's step is done either way
    timedSync('model', () => { for (const fn of this.listeners.get(event) ?? []) { try { (fn as Listener<K>)(data) } catch { /* the listener's */ } } })
  }
  private alert(code: string, message: string, group: Uint8Array | null = null, change: number | null = null): void { this.emit('alert', { code, message, group, change }) }

  // ---- the queue, and calls into the device

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job)
    this.tail = run.catch(() => {})
    return run
  }
  private isLocal(e: unknown): boolean {
    const code = this.core.errorCode(e)
    return code === 'storage' || code === 'internal' || (e instanceof Error && e.name === 'StoreConflict')
  }
  /** One call into the device, inside a job. A device that closed itself (`storage`, `internal`, a store conflict)
   *  is opened again from its store before the failure is handed on: what the call did is there or it is not. */
  private async call<T>(fn: (d: Device) => Promise<T>): Promise<T> {
    spent.calls++
    try { return await timed('core', () => fn(this.device)) } catch (e) {
      if (this.isLocal(e) && !this.over) await this.reopen()
      throw e
    }
  }
  private async reopen(): Promise<void> {
    await this.device.close().catch(() => {})
    const store = this.opts.store
    if (!store) { this.end('device-closed'); return }
    let failure: unknown = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        this.device = await this.core.openDevice(store())
        this.cursor = await this.device.cursor()
        this.position = Math.max(this.position, this.cursor)
        await this.refresh()
        this.emit('reopened', null)
        this.emit('batch', null)
        return
      } catch (e) { failure = e; await this.sleep(100 * 2 ** attempt) }
    }
    // another owner holds the state, or it does not open: this engine is over (tabs.ts stands in line again)
    this.end('device-closed')
    throw failure
  }
  private async refresh(): Promise<void> {
    const d = this.device
    this.is_human = await d.isHuman()
    this.groups = await d.groups()
    this.roles = await d.roomRoles()
    this.emit('groups', { groups: this.groups, roles: this.roles })
  }
  private group(group: Uint8Array): GroupSummary | undefined { return this.groups.find(g => same(g.group, group)) }

  /**
   * An action on the device: runs in the queue, and the pump is woken for whatever it put into the outbox. While a
   * Commit of the group waits for the hub's answer the core refuses with `busy`: the action waits for the pump and
   * is tried again a few times.
   */
  async do<T>(fn: (d: Device) => Promise<T>): Promise<T> {
    for (let tries = 0; ; tries++) {
      try {
        const result = await this.serial(() => this.call(fn))
        this.kick()
        return result
      } catch (e) {
        if (this.core.errorCode(e) !== 'busy' || tries >= 5 || !this.running) throw e
        this.kick()
        await this.sleep(200 * 2 ** tries)
      }
    }
  }
  /** Seals one stored item into the outbox. Its number is used for good once this resolves. */
  async seal(draft: Draft, recipient: Uint8Array | null, fileIds: Uint8Array[]): Promise<Sealed> {
    const sealed = await this.do(d => d.seal(draft, recipient, fileIds, this.now()))
    this.emit('sealed', { id: sealed.outboxId })
    return sealed
  }
  /**
   * A Commit or an application message that must land: `build` puts it into the outbox (and returns its ids; null:
   * nothing to do), the pump posts it, and when the group moved on under it (invariant 5) the log is processed and
   * it is built again, a few times. Rejects with the hub's code when the refusal is final.
   */
  async land(build: (d: Device) => Promise<number | number[] | null>): Promise<void> {
    for (let tries = 0; ; tries++) {
      const made = await this.do(build)
      const ids = made === null ? [] : Array.isArray(made) ? made : [made]
      if (!ids.length) return
      // an engine that was never started has no pump: what was built is posted here and now, and fed back
      if (!this.running) await this.drain()
      const outcomes = Promise.all(ids.map(id => this.outcome(id)))
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), this.running ? this.timing.land : 0) })
      const got = await Promise.race([outcomes, late]).finally(() => clearTimeout(timer))
      if (got === 'timeout') {
        for (const id of ids) this.waiters.delete(id)
        throw new EngineError(this.running ? 'timeout' : 'offline', 'the hub did not take it in time: it stays in the outbox and is sent again')
      }
      const lost = got.find(o => o !== 'accepted')
      if (!lost) return
      if (lost === 'stopped') throw new EngineError('stopped', 'the engine stopped before the hub answered')
      if (!MOVED.includes(lost) || tries >= 4) throw new EngineError(lost, `the hub refused it (${lost})`)
      await this.catchUp().catch(() => {})
    }
  }
  /** Without the pump: posts the outbox in order, reports each answer, and takes the hub's order once, so that a
   *  Commit that was accepted is merged. A failure is the caller's to hear; the entry stays for the next start. */
  private async drain(): Promise<void> {
    for (;;) {
      const entry = (await this.outbox())[0]
      if (!entry) break
      let answer: OutboxAnswer
      try { answer = await this.post(entry) } catch (e) {
        const verdict = this.judge(entry, e)
        if (verdict.kind !== 'refuse') throw e
        await this.serial(() => this.refused(entry, verdict.code, verdict.voided))
        continue
      }
      await this.serial(() => this.accepted(entry, answer))
    }
    if (this.awaiting.size) await this.catchUp()
  }
  private outcome(id: number): Promise<string> {
    if (this.halted) return Promise.resolve('stopped')
    const known = this.outcomes.get(id)
    if (known) { this.outcomes.delete(id); return Promise.resolve(known) }
    return new Promise(resolve => { this.waiters.set(id, resolve) })
  }
  private settleEntry(id: number, outcome: string): void {
    if (this.outcomes.has(id)) return
    const waiter = this.waiters.get(id)
    if (waiter) { this.waiters.delete(id); waiter(outcome); return }
    this.outcomes.set(id, outcome)
    if (this.outcomes.size > 256) this.outcomes.delete(this.outcomes.keys().next().value!)
  }
  /** The outbox as the core holds it now. */
  outbox(): Promise<OutboxEntry[]> { return this.serial(() => this.call(d => d.outbox())) }
  /** What the hub is to get beside an outbox entry (the account that is made with the room, the recovery a part
   *  belongs to): kept until the entry is answered, so a restart posts the same. */
  async attach(id: number, extra: Record<string, unknown>): Promise<void> { await this.opts.meta.set(`outbox-extra/${id}`, extra) }

  // ---- the pump

  /** Wakes the pump. */
  kick(): void {
    if (!this.running || this.pumping) return
    this.pumping = this.pump().finally(() => { this.pumping = null })
  }
  private async pump(): Promise<void> {
    let backoff = this.timing.backoff_first
    let posted: number | null = null
    while (this.running) {
      let entry: OutboxEntry | undefined
      try {
        const entries = await this.outbox()
        entry = entries[0]
        // An entry that was posted without an answer and is gone from the outbox: the log settled it meanwhile.
        // Its own Commit came back (merged), or another took its epoch; whoever waits is told.
        if (posted !== null && !entries.some(e => e.id === posted)) this.settleEntry(posted, this.merged.delete(posted) ? 'accepted' : 'epoch-taken')
        posted = null
      } catch { await this.sleep(backoff); continue }
      if (!entry) break
      const head = entry
      try {
        this.inFlight = head.id
        const answer = await this.post(head)
        await this.serial(() => this.accepted(head, answer))
        backoff = this.timing.backoff_first
        this.setBlocked(null)
      } catch (e) {
        if (!this.running) break
        posted = head.id
        const verdict = this.judge(head, e)
        if (verdict.kind === 'refuse') {
          const { code, voided } = verdict
          try { await this.serial(() => this.refused(head, code, voided)) } catch { await this.sleep(backoff) }
          continue
        }
        if (verdict.kind === 'block') { this.setBlocked({ entry: head, code: verdict.code, message: verdict.message }); await this.sleep(this.timing.blocked_retry); continue }
        await this.sleep(verdict.wait ?? backoff)
        backoff = Math.min(backoff * 2, this.timing.backoff_max)
      }
    }
  }
  private async post(entry: OutboxEntry): Promise<OutboxAnswer> {
    if (entry.kind !== 'roomFounding' && entry.kind !== 'recoveryCommit' && entry.kind !== 'recoveryFinish') return this.hub.postOutbox(entry)
    const extra = (await this.opts.meta.get(`outbox-extra/${entry.id}`)) as { account?: unknown; found_token?: string | null; recovery_id?: Uint8Array } | undefined
    if (entry.kind !== 'roomFounding') {
      if (!extra?.recovery_id) throw new EngineError('incomplete', 'a part of a recovery without the recovery it belongs to')
      return this.hub.postOutbox(entry, { recovery_id: extra.recovery_id })
    }
    // the room is founded together with its account (hub-api.md `POST /v2/rooms`)
    const found = await this.hub.foundRoom({ group_info: entry.parts[0]!, sealed_key: entry.parts[1]!, account: (extra?.account ?? null) as NewAccount | null, found_token: extra?.found_token ?? null })
    if (entry.group && !same(found.room_id, entry.group)) throw new HubError('bad-answer', 'the hub founded another room')
    return { change: null, ...found }
  }
  /** What a failed post means for the entry (invariants 3 to 5). */
  private judge(entry: OutboxEntry, e: unknown): { kind: 'again'; wait: number | null } | { kind: 'refuse'; code: ErrorCode; voided: boolean } | { kind: 'block'; code: string; message: string } {
    if (!(e instanceof HubError)) {
      const code = (e as { code?: unknown } | null)?.code
      return { kind: 'block', code: typeof code === 'string' ? code : 'internal', message: 'an outbox entry could not be posted' }
    }
    if (e.transient) return { kind: 'again', wait: e.retry_after === null ? null : e.retry_after * 1000 }
    const code = this.core.errorCodeFromText(e.code)
    if (code === null) return { kind: 'again', wait: null }
    if (entry.kind === 'envelope' && !e.voided && !DEAD.includes(code)) return { kind: 'block', code, message: e.message }
    return { kind: 'refuse', code, voided: e.voided }
  }
  private setBlocked(blocked: EngineEvents['blocked']): void {
    if (this.blocked?.entry.id === blocked?.entry.id) return
    this.blocked = blocked
    this.emit('blocked', blocked)
    this.emit('batch', null)
  }
  private async accepted(entry: OutboxEntry, answer: OutboxAnswer): Promise<void> {
    // (`not-found`: the stream brought this device's own Commit before the POST was answered, and the core merged
    // it and dropped the entry then)
    try { await this.call(d => d.outboxAccepted(entry.id, answer.change ?? null)) } catch (e) { if (this.core.errorCode(e) !== 'not-found') throw e }
    await this.opts.meta.delete(`outbox-extra/${entry.id}`).catch(() => {})
    if (entry.kind === 'keyPackages' && answer.unused !== undefined) await this.opts.meta.set('key-packages', { unused: answer.unused }).catch(() => {})
    const commit = entry.kind !== 'message' && entry.kind !== 'relayMessage' && entry.kind !== 'envelope' && entry.kind !== 'keyPackages' && entry.kind !== 'sealedKey'
    if (commit) await this.refresh()
    // An accepted Commit is not merged by the hub's answer: the group stands in its old epoch until the Commit
    // comes back at its place in the hub's order (core/README.md). Whoever waits for it waits for that; the
    // position does not move here, or the Commit would be passed over when it comes.
    if (commit && entry.group && this.group(entry.group)?.pending) {
      this.awaiting.set(entry.id, hex(entry.group))
      if (this.running && !this.streamLive) void this.catchUp().catch(() => {})
    } else this.settleEntry(entry.id, 'accepted')
    this.emit('accepted', { entry, change: answer.change ?? null })
    this.emit('batch', null)
    if (commit) this.keepSoon(this.timing.heal_delay)
  }
  private async refused(entry: OutboxEntry, code: ErrorCode, voided: boolean): Promise<void> {
    // (`not-found`: the log already showed the Commit that took the epoch, and the core dropped the entry with it)
    // An envelope's number stays used whatever became of it: one the hub keeps as a void record is reported as
    // that, one refused because this device is out of the group is given up.
    const report = (d: Device): Promise<void> => (entry.kind !== 'envelope' ? d.outboxRefused(entry.id, code) : voided ? d.outboxVoided(entry.id) : d.envelopeAbandon(entry.id))
    try { await this.call(report) } catch (e) { if (this.core.errorCode(e) !== 'not-found') throw e }
    await this.opts.meta.delete(`outbox-extra/${entry.id}`).catch(() => {})
    await this.refresh()
    this.emit('refused', { entry, code, voided })
    this.emit('batch', null)
    // whoever waits builds again after the log; nobody waiting: the log is processed all the same
    if (MOVED.includes(code)) void this.catchUp().catch(() => {})
    // the epoch took all the envelopes it may hold (3.5): a human device moves the group on, and writing goes on there
    if (code === 'epoch-full' && entry.group && this.is_human) { const group = entry.group; void this.land(d => d.update(group, true, this.now())).catch(() => {}) }
    this.settleEntry(entry.id, code)
  }
  /** Resolves when the pump has nothing in flight and nothing to wait for (the outbox is empty, or the engine stopped). */
  async idle(): Promise<void> {
    this.kick()
    while (this.pumping) await this.pumping
  }
  /** Posts the outbox's head once, now, without the pump: for a founding, whose failure is its caller's to hear. */
  async postHead(): Promise<void> {
    const entry = (await this.outbox())[0]
    if (!entry) return
    const answer = await this.post(entry)
    await this.serial(() => this.accepted(entry, answer))
  }

  // ---- taking the hub's order

  /**
   * Takes items in the hub's order, inside a job. `upTo`: the hub's cursor after them.
   *
   * One item (a live event) is one call into the device. Several (a page) go to the core in batches (`feed`): it
   * takes them in order and stops at the first it refuses, and the store writes the whole batch in one durable
   * step instead of one per item, which is what a long catch-up otherwise spends its time on. Each outcome is then
   * told exactly as if its item had come alone, in order; the item the core refused is taken as a single item (its
   * repair, or the halt of invariant 7), and what follows it is fed after that.
   */
  private async ingest(items: readonly ChangeItem[], upTo: number): Promise<void> {
    let changed = false, told = this.now()
    const step = (item: ChangeItem, moved: boolean): void => {
      if (moved) changed = true
      this.position = this.cursor = item.change
      // A page holds hundreds of items, and on a slow disk it takes seconds. What is taken so far is reported
      // while it goes on, so the position on screen moves and a slow catch-up is not mistaken for one that stands.
      if (this.now() - told >= this.timing.progress) { told = this.now(); this.emit('batch', null) }
    }
    try {
      const due = items.filter(item => item.change > this.position)
      if (due.length === 1) step(due[0]!, await this.take(due[0]!))
      else for (let at = 0; at < due.length;) {
        const batch = due.slice(at, at + FEED)
        const fed = await this.feed(batch)
        if (!fed) { for (const item of batch) step(item, await this.take(item)); at += batch.length; continue }
        const outcomes = [...fed.outcomes]
        // An envelope the core could not take for want of a Welcome or of a stretch of its sender's chain is
        // repaired when its turn comes. The ones after it in the batch were refused before that repair: they are
        // fed once more, together, and each is told at its place with the outcome it has then.
        const waits = (i: number): boolean => { const r = outcomes[i]!.envelope; return r?.outcome === 'refused' && (r.code === 'group-behind' || r.code === 'gap') }
        let repaired = false
        try {
          for (let i = 0; i < outcomes.length; i++) {
            if (repaired && waits(i)) {
              const late = outcomes.map((_, j) => j).filter(j => j >= i && waits(j))
              const again = await this.feed(late.map(j => batch[j]!))
              for (const [k, outcome] of (again?.outcomes ?? []).entries()) outcomes[late[k]!] = outcome
              repaired = false
            }
            const was = this.repairs
            step(batch[i]!, await this.told(batch[i]!, outcomes[i]!))
            if (this.repairs !== was) repaired = true
          }
        } catch (e) {
          // the device holds the whole batch, the model only what was told of it: the rest is read once more
          await this.wantRescan(this.position)
          throw e
        }
        at += fed.outcomes.length
        if (fed.refusedAt !== null) { const refused = batch[fed.refusedAt]!; step(refused, await this.take(refused)); at++ }
      }
      this.position = Math.max(this.position, upTo)
    } finally {
      if (changed) { await this.refresh().catch(() => {}); this.mergedNow() }
      this.emit('batch', null)
    }
    if (changed) this.keepSoon(this.timing.heal_delay)
  }
  /** The accepted Commits whose group no longer waits: they were merged (or dropped for the one that took their epoch,
   *  which `processed` told already). */
  private mergedNow(): void {
    for (const [id, group] of this.awaiting) {
      if (this.groups.find(g => hex(g.group) === group)?.pending) continue
      this.awaiting.delete(id)
      this.settleEntry(id, 'accepted')
    }
  }
  /** Hands the core a batch of a page. Null: the core did not take the call as a whole (nothing of it was taken),
   *  and the items go one by one. A device that closed itself is opened again, and the failure handed on. */
  private async feed(items: readonly ChangeItem[]): Promise<Fed | null> {
    if (measuring.itemByItem) return null
    const fed = items.map((item): FeedItem => (item.kind === 'envelope' ? { envelope: { bytes: item.envelope, change: item.change, voidCode: this.voidCode(item) } } : { entry: logEntry(item) }))
    try { return await this.call(d => d.feed(fed, this.now())) } catch (e) {
      if (this.isLocal(e)) throw e
      return null
    }
  }
  /** What follows from one outcome of a batch: the same as if its item had been taken alone. Returns whether the
   *  device's groups may have changed. */
  private async told(item: ChangeItem, outcome: FeedOutcome): Promise<boolean> {
    if (item.kind === 'envelope') { await this.received(item, outcome.envelope, true); return false }
    if (!outcome.processed) return false
    await this.processed(item, outcome.processed)
    return outcome.processed.kind !== 'message' && outcome.processed.kind !== 'skipped'
  }
  /**
   * What follows from an envelope the core was handed in the hub's order: a Welcome or a missing stretch of its
   * sender's chain is fetched and the envelope tried again; then it is told. `batched`: the core took what followed
   * it in the same call already, before that repair. Those items were judged without the repaired one, so after
   * a repair they are read once more (a rescan from this envelope on).
   */
  private async received(item: Extract<ChangeItem, { kind: 'envelope' }>, first: ReceivedEnvelope | null, batched: boolean): Promise<void> {
    let received = first
    const behind = (): boolean => received?.outcome === 'refused' && received.code === 'group-behind'
    const was = this.repairs
    if (behind()) {
      // a Welcome this device has not taken yet may be what it lacks
      if (await this.joinWelcomes(null)) { this.repairs++; received = await this.receive(item, true) }
      if (behind()) { await this.wantRescan(); return }
    }
    if (received?.outcome === 'refused' && received.code === 'gap') { this.repairs++; received = await this.fillGap(item, received) }
    if (batched && this.repairs !== was) await this.wantRescan(item.change)
    if (received) this.emit('envelope', { received, how: 'ordered' })
  }
  /** One item. Returns whether the device's groups may have changed. Throws Halt when it does not process. */
  private async take(item: ChangeItem): Promise<boolean> {
    if (item.kind === 'envelope') { await this.received(item, await this.receive(item, true), false); return false }
    let done: Processed | null
    try { done = await this.process(item) } catch (e) {
      if (!(e instanceof Halt) || e.code !== 'early') throw e
      // what it builds on may be a Welcome not taken yet. Nothing is read ahead of the hub's order for it: an
      // entry that still comes early halts the batch, and the next catch-up tries it again.
      if (!(await this.joinWelcomes(null))) throw e
      done = await this.process(item)
    }
    if (!done) return false
    await this.processed(item, done)
    return done.kind !== 'message' && done.kind !== 'skipped'
  }
  /** What follows from a log entry the device took: keys that open what was closed, this device's own removal. */
  private async processed(item: LogItem, done: Processed): Promise<void> {
    if (done.message?.kind === 'keys' && done.message.keysTaken > 0) await this.wantRescan()
    // another Commit took the epoch of one of this device's: whoever waits for it builds it again
    if (done.superseded !== null) { this.awaiting.delete(done.superseded); this.settleEntry(done.superseded, 'epoch-taken') }
    // this device's own Commit, back from the hub: if its POST is still without an answer, it is the one in flight
    if (done.kind === 'ownCommit' && this.inFlight !== null) this.merged.add(this.inFlight)
    this.emit('log', { item, done })
    if (done.removed && item.group.length === 32) this.end('removed')
  }
  /** Hands a group's log to the device again from where this engine last read it, up to the change `upTo`: the
   *  core takes the next Commit of a group it holds or follows also behind the cursor, and passes over what it has.
   *  `upTo` is the position for a group joined late: an entry after it comes at its place in the hub's one order,
   *  or the cursor would jump over other groups' entries. Only the room group's Commits are read ahead of it, for
   *  what must be judged against them (an entry that came `early`, a Welcome of a device that follows the room).
   *  An entry that does not process stops the reading like any other (invariant 7). Inside a job. */
  private async handLog(group: Uint8Array, upTo: number): Promise<void> {
    const key = hex(group)
    for (let more = true; more;) {
      let page
      try { page = await this.hub.groupLog(group, { after: this.logRead.get(key) ?? 0, limit: PAGE }) } catch { return }
      for (const item of page.items) {
        if (item.change > upTo) { more = false; break }
        let done: Processed | null
        try { done = await this.process(item) } catch (e) {
          if (e instanceof Halt && e.code === 'early') { more = false; break }     // not yet: read again from here next time
          throw e
        }
        if (done) await this.processed(item, done)
        this.logRead.set(key, item.n)
      }
      more = more && page.more && page.items.length > 0
    }
    await this.refresh()
    this.mergedNow()
  }
  private async process(item: LogItem): Promise<Processed | null> {
    try { return await this.call(d => d.processLogEntry(logEntry(item), this.now())) } catch (e) {
      const code = this.core.errorCode(e)
      if (code === null || code === 'core-missing') throw e
      const finding = this.core.logFinding(code)
      if (finding === 'duplicate') return null
      if (finding === 'local') throw e
      if (finding === 'early') throw new Halt('early', `an entry of the hub's order came before what it builds on (${code})`)
      this.alert('bad-group', `an entry of a group's log does not process (${code}): the group is kept as it was`, item.group, item.change)
      if (item.kind === 'commit') void this.hub.rejectCommit(item.group, item.n).catch(() => {})
      throw new Halt('bad-group', `an entry of a group's log does not process (${code})`)
    }
  }
  /** The hub's void record of an envelope, as the core names it. */
  private voidCode(item: { void_code: string | null }): ErrorCode | null {
    return item.void_code === null ? null : this.core.errorCodeFromText(item.void_code) ?? 'hub-voided-other'
  }
  private async receive(item: { envelope: Uint8Array; change: number; void_code: string | null }, ordered: boolean): Promise<ReceivedEnvelope | null> {
    const voided = this.voidCode(item)
    try { return await this.call(d => d.receiveEnvelope(item.envelope, item.change, ordered, voided, this.now())) } catch (e) {
      if (this.isLocal(e) || this.core.errorCode(e) === 'core-missing') throw e
      // not an envelope at all: nothing of it is taken
      this.alert(String(this.core.errorCode(e) ?? 'bad-format'), 'the hub served something that is no envelope', null, item.change)
      return null
    }
  }
  /** An envelope whose chain misses what stands before it: the sender's chain is fetched from where this device
   *  holds it (9.0.6), taken in order, and the envelope tried again. Still a gap: the hub withholds a part of the
   *  chain, which is said (`withheld`); the envelope stays out, and a rescan takes it when the chain is whole. */
  private async fillGap(item: { envelope: Uint8Array; change: number; void_code: string | null }, refused: ReceivedEnvelope): Promise<ReceivedEnvelope | null> {
    const { group, sender } = refused.header
    try {
      const held = await this.call(d => d.cutOf(group, sender))
      for (let after = held.seq, more = true; more;) {
        const page = await this.hub.chain(group, sender, { after, limit: PAGE })
        for (const link of page.items) {
          if (link.seq >= refused.header.seq) { more = false; break }
          const taken = await this.receive(link, true)
          if (taken && taken.outcome !== 'refused') this.emit('envelope', { received: taken, how: 'again' })
          after = link.seq
        }
        more = more && page.more && page.items.length > 0
      }
    } catch (e) { if (this.isLocal(e)) throw e }
    const again = await this.receive(item, true)
    if (again?.outcome === 'refused' && again.code === 'gap') {
      this.alert('withheld', 'the hub does not serve a part of a device\'s chain: what follows it is not shown', group, item.change)
      await this.wantRescan()
    }
    return again
  }
  /**
   * A register value that was read back (an envelope its chain already holds): the core hands its body but does
   * not say again whether it is the current value of its name. It is, if the core's current value of that name
   * (the shared one, else this sender's own) is this body's. Without that, a model built again from what the core
   * holds would show no register at all.
   */
  private async readBack(received: ReceivedEnvelope): Promise<ReceivedEnvelope> {
    if (received.header.kind !== 'register' || received.register || received.outcome !== 'applied' || !received.payload) return received
    try {
      const body = JSON.parse(new TextDecoder().decode(received.payload)) as { name?: unknown; value?: unknown }
      if (typeof body.name !== 'string') return received
      const name = body.name, { group, sender } = received.header
      const held = await this.call(async d => (await d.register(group, name)) ?? d.registerOf(group, name, sender))
      const current = held !== null && canonical(JSON.parse(new TextDecoder().decode(held))) === canonical(body.value ?? null)
      return { ...received, register: { name, of: sender, current } }
    } catch (e) {
      if (this.isLocal(e)) throw e
      return received
    }
  }
  /** Envelopes fetched out of the hub's order (a page of a Chat, a board's items, an object): shown as the core
   *  says, provisional until their chain reaches them. */
  receivePage(items: readonly EnvelopeItem[]): Promise<ReceivedEnvelope[]> {
    return this.serial(async () => {
      const out: ReceivedEnvelope[] = []
      for (const item of items) { const r = await this.receive(item, false); if (r) out.push(await this.readBack(r)) }
      return out
    })
  }

  /** Catches up with the hub: pages after the position until the hub has no more. One at a time; a call while one
   *  runs gets a pass that started after the call. */
  catchUp(): Promise<void> {
    if (this.catching) {
      this.again = true
      return this.catching.then(() => (this.again ? this.catchUp() : undefined), () => this.catchUp())
    }
    this.again = false
    const pass = this.catching = this.pages().finally(() => { if (this.catching === pass) this.catching = null })
    return pass
  }
  private async pages(): Promise<void> {
    const was = this.connection, from = this.position
    this.setConnection('catching_up')
    try {
      for (;;) {
        const page = await timed('hub', () => this.hub.changes(this.position, PAGE))
        spent.items += page.items.length
        await this.serial(() => this.ingest(page.items, page.change))
        if (!page.more) break
      }
    } catch (e) {
      if (e instanceof Halt && this.running) this.later(this.timing.halted_retry, () => { void this.catchUp().catch(() => {}) })
      if (e instanceof HubError && e.code === 'not-member') this.lost()
      // a page that breaks the hub's own order (hub.ts refuses it whole): nothing of it was taken
      if (e instanceof HubError && e.code === 'bad-answer') this.alert('bad-answer', 'the hub answered a catch-up with something the protocol does not allow: nothing of it was taken')
      throw e
    } finally {
      this.setConnection(this.streamLive ? 'live' : was === 'catching_up' ? 'offline' : was === 'live' ? 'offline' : was)
    }
    // a device without a stream hears of no Welcome: it looks after each catch-up that brought something
    if (!this.streamLive && this.position !== from) this.keepSoon(0)
    if (this.rescanDue) await this.rescan()
  }
  /** Asks for a rescan (see the header): also the client's, when it has to build its model again from nothing. */
  async wantRescan(from = 0): Promise<void> {
    this.rescanAsked++
    // (asked for twice: from the earlier of the two places)
    const start = this.rescanDue ? Math.min(this.rescanFrom, from) : from
    if (this.rescanDue && start === this.rescanFrom) return
    this.rescanDue = true
    this.rescanFrom = start
    await this.opts.meta.set('rescan', start).catch(() => {})
    this.keepSoon(0)
  }
  /** Reads the room's envelopes once more from the start, up to the position (see the header). */
  private async rescan(): Promise<void> {
    const asked = this.rescanAsked
    const upTo = this.position
    for (let after = this.rescanFrom; after < upTo;) {
      const page = await this.hub.changes(after, PAGE)
      await this.serial(async () => {
        // (what the chain could not take before is written now: in batches, like a page of a catch-up)
        const due = page.items.filter((item): item is Extract<ChangeItem, { kind: 'envelope' }> => item.kind === 'envelope' && item.change <= upTo)
        const again = async (item: Extract<ChangeItem, { kind: 'envelope' }>, first: ReceivedEnvelope | null): Promise<void> => {
          let received = first
          if (received?.outcome === 'refused' && received.code === 'replay') { received = await this.receive(item, false); if (received) received = await this.readBack(received) }
          if (received && received.outcome !== 'refused') this.emit('envelope', { received, how: 'again' })
        }
        for (let at = 0; at < due.length;) {
          const batch = due.slice(at, at + FEED)
          const fed = await this.feed(batch)
          const outcomes = fed?.outcomes ?? []
          for (const [i, outcome] of outcomes.entries()) await again(batch[i]!, outcome.envelope)
          at += outcomes.length
          // the one the core did not take in the batch (or the first of a batch it did not take): alone
          if (!fed || fed.refusedAt !== null) { await again(batch[outcomes.length]!, await this.receive(batch[outcomes.length]!, true)); at++ }
        }
        this.emit('batch', null)
      })
      if (page.change <= after || !page.more) break
      after = page.change
    }
    // asked for again meanwhile (keys that came while this one ran): it stays due, and upkeep runs the next
    if (this.rescanAsked !== asked) { this.keepSoon(0); return }
    this.rescanDue = false
    this.rescanFrom = 0
    await this.opts.meta.delete('rescan').catch(() => {})
    this.emit('rescanned', null)
    this.emit('batch', null)
  }

  // ---- the live stream

  private openStream(): void {
    this.closeStream = this.hub.stream(() => this.position, event => this.onStream(event), state => {
      this.streamLive = state === 'live'
      if (state === 'live') { for (const wake of [...this.sleepers]) wake(); this.keepSoon(0) }
      if (!this.catching) this.setConnection(state === 'live' ? 'live' : state === 'connecting' && this.connection !== 'live' ? 'connecting' : state === 'offline' ? 'offline' : this.connection)
    }, e => { if (e instanceof HubError && e.code === 'not-member') this.lost() })
  }
  private async onStream(event: StreamEvent): Promise<void> {
    switch (event.event) {
      case 'change': await this.serial(() => this.ingest([event.item], event.item.change)); return
      case 'relay': {
        // (a piece that does not open, or a core without the call, is a piece not shown: nothing else follows)
        const message = await this.serial(() => this.call(d => d.receiveRelay(event.group, event.message, this.now()))).catch(() => null)
        if (message) { this.emit('relay', message); this.emit('batch', null) }
        return
      }
      case 'welcome': this.keepSoon(0); return
      case 'request':
        // a human device that holds the keys sends them again on a newcomer's wish (7.1)
        if (event.kind === 'handover' && this.is_human && this.room_id) void this.land(d => d.sendHandover(event.group ?? this.core.roomGroupId(this.room_id!), event.device)).catch(() => {})
        this.emit('stream', event)
        return
      default: this.emit('stream', event)
    }
  }
  private setConnection(connection: Connection): void {
    if (this.connection === connection) return
    this.connection = connection
    this.emit('connection', connection)
    this.emit('batch', null)
  }

  // ---- upkeep

  /** Joins every group the hub holds a Welcome of this device for; `committer`: who must have committed it (12.1.5),
   *  null where any device the group's rules allow may have. True when a group was joined. Inside a job. */
  private async joinWelcomes(committer: Uint8Array | null): Promise<boolean> {
    if (!this.room_id) return false
    const room = this.room_id
    let rows
    try { rows = await this.hub.welcomes() } catch { return false }
    let joined = false
    // a device that only follows the room group (it holds the room's roles and is no leaf of it) takes the room's
    // Commits first: the Welcome is judged against them (5.2.6)
    if (rows.length && !this.is_human && this.roles) await this.handLog(this.core.roomGroupId(room), Infinity)
    for (const row of rows) {
      const id = `${hex(row.group)}/${row.at}`
      if (this.group(row.group) || this.badWelcomes.has(id)) continue
      try {
        let done
        // into the room group: only as this device's invite said (12.1.5), which the core reads from the stored invite
        const join = (d: Device) => (row.group.length === 32 ? d.joinInvited(row.welcome, this.now()) : d.joinWelcome(row.welcome, room, committer, this.now()))
        try { done = await this.call(join) } catch (e) {
          // behind the room: its Commits first (an agent device follows the room group by its log), then once more
          if (this.core.errorCode(e) !== 'room-behind') throw e
          await this.handLog(this.core.roomGroupId(room), Infinity)
          done = await this.call(join)
        }
        joined = true
        // a Welcome taken later than its place in the hub's order: the group's entries since are handed again
        await this.handLog(row.group, this.position)
        if (done.offending.length) this.alert('bad-group', 'a session failed its first contact: its content stays closed until its wrong leaves are removed', row.group)
        const held = (await this.opts.meta.get('key-packages').catch(() => null)) as { unused: number } | null
        if (held) await this.opts.meta.set('key-packages', { unused: Math.max(0, held.unused - 1) }).catch(() => {})
      } catch (e) {
        if (this.isLocal(e)) throw e
        const code = this.core.errorCode(e)
        // behind: the Welcome is taken again after the log (core/README.md); anything else is no Welcome for this device
        if (code !== 'room-behind' && code !== 'group-behind') { this.badWelcomes.add(id); this.alert(String(code ?? 'bad-format'), 'a Welcome was not taken', row.group) }
      }
    }
    if (joined) {
      await this.refresh()
      // a device that came in by link knows nothing of the time before: its groups' past is learned, then read
      this.learnDue = true
      await this.opts.meta.set('learn', true).catch(() => {})
    }
    return joined
  }
  /** Joins by Welcome now: for a device that was just let in. */
  joinNow(committer: Uint8Array | null): Promise<boolean> {
    return this.serial(async () => { const joined = await this.joinWelcomes(committer); this.emit('batch', null); return joined })
  }

  /** Runs upkeep after `delay` ms; calls while it waits or runs fold into one more run. */
  keepSoon(delay: number): void {
    if (!this.running) return
    if (this.keeping) { this.keepAgain = true; return }
    const run = this.keeping = (async () => {
      if (delay > 0) await this.sleep(delay)
      try { if (this.running) await this.keep() } catch { /* tried again with the next change or the timer */ }
    })().finally(() => {
      if (this.keeping === run) this.keeping = null
      if (this.keepAgain) { this.keepAgain = false; this.keepSoon(this.timing.heal_delay) }
    })
  }
  private async keep(): Promise<void> {
    await this.serial(async () => { await this.joinWelcomes(null); await this.tellFindings(); this.emit('batch', null) })
    if (this.is_human) await this.heal(await this.invited())
    if (this.now() - this.timedAt >= this.timing.upkeep_every) { this.timedAt = this.now(); await this.timed() }
    if (this.learnDue) await this.learn()
    if (this.rescanDue && !this.catching) await this.rescan()
  }
  /**
   * The past of the groups a device joined by link (core `learnHistory`): each group's founding GroupInfo and its
   * Commits from the hub, the room group first, then main sessions, then helper sessions. After that the envelopes
   * of the earlier epochs are handed over again (`rescan`); the keys to read them come by the handover. A group
   * that is not learned now (the hub not reached) is tried again with the next upkeep.
   */
  private async learn(): Promise<void> {
    const rank = (g: GroupSummary): number => (!g.session ? 0 : g.session.parent.every(b => b === 0) ? 1 : 2)
    let open = false
    // (the room group also for a device that only follows it: a session's past is judged against the room's)
    const sessions = this.groups.filter(g => g.session && !g.archived).sort((x, y) => rank(x) - rank(y)).map(g => g.group)
    for (const group of [...(this.room_id ? [this.core.roomGroupId(this.room_id)] : []), ...sessions]) {
      try {
        const served = await this.hub.servedGroup(group)
        await this.serial(() => this.call(d => d.learnHistory(group, served.founding, served.commits)))
      } catch (e) {
        if (this.isLocal(e)) throw e
        if (e instanceof HubError && e.transient) open = true
      }
    }
    if (open) { this.owing = true; return }
    this.learnDue = false
    await this.opts.meta.delete('learn').catch(() => {})
    await this.wantRescan()
  }
  /** Closes the gaps any human device closes when it sees them: a stale session group gets its missing Remove
   *  (5.2.8), a live one that lacks a human device gets it added (5.2.7), one Commit and one KeyPackage each. */
  private async heal(steps: InviteStep[]): Promise<void> {
    // what an open invite still has to do is the invite's: a takeover's session (and its helper sessions) keeps
    // its old leaf until the new one takes the seat, and a newcomer is added by its inviter's steps
    const taken = steps.filter(s => s.kind === 'takeOver' && s.group).map(s => hex(s.group!))
    const coming = steps.filter(s => s.device).map(s => hex(s.device!))
    const covered = (g: GroupSummary): boolean => taken.includes(hex(g.group)) || (!!this.room_id && taken.includes(hex(this.core.sessionGroupId(this.room_id, g.session!.parent))))
    const humans = (this.roles?.humans ?? []).filter(h => !coming.includes(hex(h)))
    for (const g of this.groups) {
      if (!g.session || g.archived || covered(g)) continue
      if (g.disallowed.length) { await this.clean(g.group, null).catch(() => {}); continue }
      for (const device of humans) {
        if (g.leaves.some(l => same(l, device))) continue
        let keyPackage: Uint8Array
        // none uploaded yet (a device that was let in a moment ago): looked at again soon
        try { keyPackage = (await this.hub.claimKeyPackages([device]))[0]!.key_package } catch { this.owing = true; this.later(this.timing.heal_delay * 5, () => this.keepSoon(0)); continue }
        await this.land(async d => {
          const now = await d.group(g.group)
          if (now.pending || now.disallowed.length || now.leaves.some(l => same(l, device))) return null
          return d.addToSession(g.group, device, keyPackage, this.now())
        }).catch(() => {})
      }
    }
  }
  /** The Commit that removes a session group's leaves the room no longer allows, each with its Cut; `replacement`:
   *  the agent device that takes the seat (a takeover, 5.3). Resolves when the hub took it; null was nothing to do. */
  clean(group: Uint8Array, replacement: { device: Uint8Array; keyPackage: Uint8Array } | null): Promise<void> {
    return this.land(async d => {
      const now = await d.group(group)
      if (now.pending || (!now.disallowed.length && !replacement)) return null
      if (replacement && now.leaves.some(l => same(l, replacement.device))) return null
      const cuts: Cut[] = []
      for (const gone of now.disallowed) cuts.push(await d.cutOf(group, gone))
      return d.cleanSession(group, cuts, replacement, this.now())
    })
  }
  /** Archives a session group on this device (5.2.10): the hub was told, or told this device. */
  async archive(group: Uint8Array): Promise<void> {
    await this.serial(async () => { await this.call(d => d.archive(group)); await this.refresh(); this.emit('batch', null) })
  }
  /** A takeover whose person chose "without the earlier conversation": its handover step is dropped, not sent (5.3.2). */
  async withoutHistory(inviteId: Uint8Array): Promise<void> { await this.opts.meta.set(`invite-no-history/${hex(inviteId)}`, true) }
  /**
   * What is left to do for the devices this one let in by link (spec 12.1.5, 12.1.6, 5.3), as the core lists it
   * from the state of the groups: each step is taken once, the next shows after its Commit came back. Returns the
   * steps that were open, and tells the client which invites are still at work. A step that fails (no KeyPackage at
   * the hub yet, the hub not reached) is simply there again at the next round.
   */
  private async invited(): Promise<InviteStep[]> {
    this.owing = false
    let steps: InviteStep[]
    try { steps = await this.serial(() => this.call(d => d.inviteSteps())) } catch { return [] }
    for (const step of steps) {
      const id = step.inviteId, device = step.device, group = step.group
      try {
        switch (step.kind) {
          case 'wait': break
          case 'commit': await this.do(d => d.inviteRecommit(id, this.now())); break
          case 'handover': {
            // (the recovery key's tag for a new human device, 7.4, went with the Commit that added it)
            const skip = (await this.opts.meta.get(`invite-no-history/${hex(id)}`).catch(() => null)) === true
            await this.do(async d => { if (skip) await d.inviteForget(id); else await d.inviteHandover(id) })
            break
          }
          case 'addToSession': {
            const keyPackage = (await this.hub.claimKeyPackages([device!]))[0]!.key_package
            await this.do(d => d.addToSession(group!, device!, keyPackage, this.now()))
            break
          }
          case 'foundSession': {
            const others = (this.roles?.humans ?? []).filter(h => !same(h, this.device_id))
            const claimed = others.length ? await this.hub.claimKeyPackages(others) : []
            await this.do(d => d.foundSession(device!, [...claimed.map(c => c.key_package), step.keyPackage!], this.now()))
            break
          }
          case 'takeOver': {
            // (a helper session's new opener comes with a KeyPackage claimed at the hub; the main session's with the invite's)
            const keyPackage = step.keyPackage ?? (await this.hub.claimKeyPackages([device!]))[0]!.key_package
            await this.do(d => d.cleanSession(group!, step.cuts, { device: device!, keyPackage }, this.now()))
            break
          }
          case 'checkHelpers': {
            // 5.3.1 (c): the hub's list of that session's helper sessions, after the Welcomes still waiting were taken
            await this.serial(() => this.joinWelcomes(null))
            const helpers = (await this.hub.roomGroups()).filter(g => g.live && g.kind === 'helper' && g.parent && step.session && same(g.parent, step.session)).map(g => g.group)
            await this.do(d => d.inviteChecked(id, helpers))
            break
          }
        }
      } catch (e) {
        if (this.isLocal(e)) throw e
        this.owing = true
      }
    }
    // what is left now (the core drops an invite that has nothing left); a newcomer that only waits to be added
    // to sessions counts as in
    let left = steps
    if (steps.length) {
      try { left = await this.serial(() => this.call(d => d.inviteSteps())) } catch { /* the list of before */ }
      if (left.length) { this.owing = true; this.later(this.timing.heal_delay * 5, () => this.keepSoon(0)) }
    }
    this.emit('invites', { open: [...new Set(left.filter(s => s.kind !== 'addToSession').map(s => hex(s.inviteId)))] })
    this.emit('batch', null)
    return left
  }
  /** What the core found while it processed Commits (a Cut that drops what was shown, a hub's void it cannot check). */
  private async tellFindings(): Promise<void> {
    const found = await this.call(d => d.findings()).catch(() => [])
    if (!found.length) return
    for (const f of found) this.alert(f.code, 'the core found something wrong in a group', f.group)
    await this.call(d => d.findingsRead()).catch(() => {})
  }
  /** Upkeep now, to its end: for the device that caused a gap (it added a human device, removed one). */
  async healNow(): Promise<void> {
    while (this.keeping) await this.keeping
    await this.keep()
  }
  /** The timed part: KeyPackages (14.2), the own-leaf update (5.2.9; the core says whether it is due), `heads` (9.0.7). */
  private async timed(): Promise<void> {
    if (!this.room_id) return
    const held = (await this.opts.meta.get('key-packages').catch(() => null)) as { unused: number } | null
    await this.do(d => d.keyPackagesToUpload(held?.unused ?? 0, this.now())).catch(() => {})
    if (!(await this.do(d => d.isOwner()).catch(() => true))) await this.serial(() => this.reopen()).catch(() => {})
    for (const g of this.groups) {
      if (g.archived || g.disallowed.length) continue
      if (this.is_human && !g.pending) await this.do(d => d.update(g.group, false, this.now())).catch(() => {})
      await this.do(async d => {
        const value = await d.headsDue(g.group, this.now())
        if (!value) return
        // `heads` is itself an envelope of this device's chain, so its own head has always moved since the last
        // one: written only when another sender's head changed (9.0.7), or every start would add an envelope
        const heads = JSON.parse(new TextDecoder().decode(value)) as Record<string, unknown>
        delete heads[this.core.base64urlEncode(this.device_id)]
        const others = canonical(heads), key = `heads/${hex(g.group)}`
        if ((await this.opts.meta.get(key).catch(() => null)) === others) return
        await d.seal({ kind: 'register', group: g.group, name: 'heads', value }, null, [], this.now())
        await this.opts.meta.set(key, others).catch(() => {})
      }).catch(() => {})
    }
    this.later(this.timing.upkeep_every, () => this.keepSoon(0))
  }

  // ---- life

  /** Starts the pump, catches up, opens the stream (`stream: false`: a caller that pulls with `catchUp`). Resolves
   *  after the first catch-up was tried; a hub that is not there is no failure, the stream keeps trying. */
  async start({ stream = true }: { stream?: boolean } = {}): Promise<void> {
    if (this.running || this.over) return
    this.running = true
    this.halted = false
    this.kick()
    this.setConnection('connecting')
    await this.catchUp().catch(() => {})
    if (!this.running) return
    if (stream) this.openStream()
    this.keepSoon(0)
  }
  /** Waits until nothing is left to do: the outbox is empty, the hub's order is taken, upkeep is through. Rejects
   *  with `chain-halted` when the pump is blocked and with `timeout`. */
  async settle(timeout_ms = 10_000): Promise<void> {
    const until = this.now() + timeout_ms
    for (let quiet = 0; this.now() < until;) {
      if (this.blocked) throw new EngineError('chain-halted', `sending is halted: the hub refused an envelope (${this.blocked.code})`)
      this.kick()
      if (this.pumping) await Promise.race([this.pumping, this.sleep(100)])
      if (this.keeping) { await Promise.race([this.keeping, this.sleep(Math.max(1, until - this.now()))]); quiet = 0; continue }
      const before = this.position
      await this.catchUp().catch(() => {})
      if ((await this.outbox()).length || this.keeping || this.position !== before) { quiet = 0; continue }
      if (this.owing || this.rescanDue || this.learnDue) { quiet = 0; await this.sleep(50); continue }
      if (++quiet >= 2) return
    }
    throw new EngineError('timeout', 'the outbox did not settle in time')
  }
  /**
   * The hub no longer takes this device: it answered `not-member`, or signed the key in as `removed`. The hub's word
   * alone wipes nothing. The device asks for the Commits that removed it (hub-api.md 42: the room group's, after
   * `after=0` in pages, the ones it has taken already passed over) and processes them itself: only when the core
   * says this device is out (`removed`, through `processed`) is it told as removed, and the app wipes it. A key the
   * hub signs in as anything else, a key it gives no token, a page or a Commit that does not hold: `unreachable`,
   * everything kept (a reload tries again).
   */
  private lost(): void {
    if (this.over || this.losing) return
    const run = this.losing = this.checkRemoval().catch(() => { this.end('unreachable') }).finally(() => { if (this.losing === run) this.losing = null })
  }
  private losing: Promise<void> | null = null
  private async checkRemoval(): Promise<void> {
    // nothing else is asked of the hub meanwhile: no stream, no pump, no upkeep
    this.halt()
    if (this.hub.role !== 'removed') {
      // (the token in hand may be from before: a sign-in now says what the key is to the hub today)
      this.hub.forgetToken()
      try { await this.hub.signIn() } catch { return this.end('unreachable') }
    }
    if (this.over) return
    if (this.hub.role !== 'removed' || !this.room_id) return this.end('unreachable')
    const group = this.core.roomGroupId(this.room_id)
    try {
      for (let after = 0; !this.over;) {
        const page = await this.hub.removal(group, after)
        await this.serial(async () => {
          for (const item of page.items) {
            if (this.over) return
            if (item.change <= this.position) continue
            const done = await this.process(item)
            if (done) await this.processed(item, done)
          }
          this.emit('batch', null)
        })
        const last = page.items.at(-1)?.n ?? after
        if (!page.more || last <= after) break
        after = last
      }
    } catch { /* the hub's word alone: below */ }
    this.end('unreachable')
  }
  private end(code: 'removed' | 'device-closed' | 'unreachable'): void {
    if (this.over) return
    this.over = true
    this.emit('closed', { code })
    this.halt()
  }
  private halt(): void {
    this.running = false
    this.halted = true
    this.closeStream?.()
    this.closeStream = null
    this.streamLive = false
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    for (const wake of [...this.sleepers]) wake()
    for (const [id, waiter] of this.waiters) { this.waiters.delete(id); waiter('stopped') }
  }
  /** Stops everything and closes the device (its store with it). What is in the outbox stays stored. */
  async stop(): Promise<void> {
    this.halt()
    await Promise.allSettled([this.pumping, this.catching, this.keeping])
    await this.tail
    this.setConnection('offline')
    await this.device.close().catch(() => {})
  }
  private later(ms: number, fn: () => void): void {
    if (!this.running) return
    const t = setTimeout(() => { this.timers.delete(t); if (this.running) fn() }, ms)
    this.timers.add(t)
  }
  /** Sleeps; ends early when the engine stops or the stream comes live. */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const done = (): void => { clearTimeout(t); this.timers.delete(t); this.sleepers.delete(done); resolve() }
      const t = setTimeout(done, ms)
      this.timers.add(t)
      this.sleepers.add(done)
    })
  }
}
