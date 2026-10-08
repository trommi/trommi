// model.ts: the board model and its reducer (shared/README.md "The model" is the contract; the shapes are types.ts).
// No crypto, no I/O. The sync engine hands in verified, decoded records in hub order;
// every client (human or agent) applies the same rules and so arrives at the same board.
import { OBJECT_STATE_NAME, URGENCY_NAME, URGENCY, KIND, CARD_CONTENT_FIELDS, CONTENT_TYPES, OBJECT_TYPES, CARD_TYPES, ANSWER_ACTIONS } from './codec.ts'
import type {
  Alert, Answer, AnswerBody, ApplyResult, Body, Card, CardBody, CardOption, Causal, Change, ContentState, HumanRegisters, ItemState, Link, Linked, LinkState,
  Model, Newer, Note, ObjectState, PermissionRequest, Rec, Session, SessionSettings, StackKey, Timeline, TimelineItem, Urgency,
} from './types.ts'

export const ALERTS_MAX = 200
const URGENCY_RANK: Record<string, number> = { critical: 3, high: 2, normal: 1, low: 0 }
const isZeroHash = (h: string) => /^0*$/.test(h)
type Obj = Record<string, any>

/** R2's signed facts of a write (Causal), as far as they are known. */
export type CausalLike = Pick<Causal, 'sender_device_id' | 'sender_sequence'> & { lamport?: number | null | undefined; sent_at?: number }

/**
 * R2: the one order of writes to a register or note, the same on every device whatever the hub's delivery order (a
 * strict total order, lexicographic, so the winner does not depend on the order of comparisons and there are no
 * cycles): (lamport, sender_device_id, sender_sequence). `lamport` is signed inside the body: the writer's counter,
 * one above every lamport it had seen, so a write made after seeing another always sorts after it. Writes without one
 * (older clients) count as lamport 0. The sender-chosen `sent_at` takes no part (review 3: with it, two writes of one
 * sender at an equal lamport made a cycle a2 > a1 > b > a2).
 * causal = { sender_device_id, sender_sequence, sent_at, lamport }.
 */
export function compareWrites(x: CausalLike, y: CausalLike): number {
  return ((x.lamport ?? 0) - (y.lamport ?? 0)) || (x.sender_device_id < y.sender_device_id ? -1 : x.sender_device_id > y.sender_device_id ? 1 : 0) ||
    (x.sender_sequence - y.sender_sequence)
}
/** Does write X win over write Y (compareWrites)? */
export function causallyAfter(x: CausalLike | null | undefined, y: CausalLike | null | undefined): boolean {
  if (!y) return true
  if (!x) return false
  return compareWrites(x, y) > 0
}
/** A body's lamport, if it is a sane integer (at most LAMPORT_MAX). */
export const LAMPORT_MAX = 2 ** 48
export const lamportOf = (c: { lamport?: unknown } | null | undefined): number => (typeof c?.lamport === 'number' && Number.isSafeInteger(c.lamport) && c.lamport > 0 && c.lamport <= LAMPORT_MAX ? c.lamport : 0)
/**
 * Review 3 (lamport inflation): an honest writer's lamport is one above the largest it has seen, and everything it saw
 * the hub ordered before its write, so a reader that applies in hub order has seen nearly as much. A lamport more than
 * LAMPORT_STEP above the largest this device has seen is refused (counts as 0, is not adopted, alert): one signed write
 * can no longer jump the counter to 2^53 and pin a register for good. The bound leaves room for writes this device
 * cannot read (other sessions' statuses).
 */
export const LAMPORT_STEP = 2 ** 24
export const lamportAccepted = (lamport: number, seen: number | null | undefined): boolean => lamport > 0 && lamport <= (seen ?? 0) + LAMPORT_STEP

export function emptyModel(): Model {
  return {
    room: { room_id: null, hub_url: null, my_device_id: null, my_role: null, key_epoch: 0, last_entry_number: -1, last_envelope_number: 0, connection: 'offline', agent_session_id: null, outbox_blocked: null },
    members: new Map(), sessions: new Map(), cards: new Map(), permissions: new Map(), notes: new Map(), published: new Map(),
    timelines: new Map(), human: emptyHuman(), invites: new Map(), alerts: [], outbox: [],
    stack: [], open_permission_ids: [], newer: emptyNewer(),
  }
}
const emptyNewer = (): Newer => ({ count: 0, what: [], envelope_number: 0 })

// ---- forward compatibility: what a newer client wrote ---------------------------------------------------------------
//
// Records this version cannot read (an envelope kind, object type, card type, content type, answer action or timeline
// kind it does not know, or a body of a newer schema_version) were verified like any other: they never break a chain
// and are never applied as something they are not. Each is counted in model.newer = { count, what: [up to 16 names],
// envelope_number: the newest }; change.room is set, so the app can say once "this needs a newer Trommi" (codec
// UPDATE_MESSAGE). Where a record has a place (a card, a timeline item, a note), that place shows a placeholder:
// card.unsupported, item_state 'unsupported' / 'newer_schema', note.unsupported.
export const NEWER_WHAT_MAX = 16
export function noteNewer(model: Model, change: Change, what: string, rec: { envelope_number?: number | null } | null | undefined): void {
  const n = (model.newer ??= emptyNewer())
  n.count++
  if (!n.what.includes(what)) { n.what.push(what); if (n.what.length > NEWER_WHAT_MAX) n.what.shift() }
  n.envelope_number = Math.max(n.envelope_number, rec?.envelope_number ?? 0)
  change.room = true
}
const needsUpdate = (model: Model, change: Change, rec: Rec, what: string): ApplyResult => { noteNewer(model, change, what, rec); return { applied: false, refused: 'needs-update' } }
/** Whether this version can show and act on a card (false: a placeholder, no answer from here). */
export const cardSupported = (card: { unsupported?: unknown } | null | undefined): boolean => !card?.unsupported
function emptyHuman(): HumanRegisters {
  return { drafts: new Map(), snoozes: new Map(), ducks: new Map(), crown: null, desks: new Map(), session_settings: new Map(), scribble_snapshots: new Map(), raw: new Map() }
}

/** A change record: what a batch touched. Every field always present. */
export function emptyChange(): Change {
  return { cards: new Set(), sessions: new Set(), permissions: new Set(), notes: new Set(), published: new Set(), timelines: new Set(), registers: new Set(),
    members: false, invites: new Set(), alerts: false, outbox: false, stack: false, room: false, items: new Map() }
}
/** change.items: Map<timeline_key, TimelineItem[]> added or replaced in this batch. */
export function addItem(change: Change, key: string, item: TimelineItem): void { let l = change.items.get(key); if (!l) change.items.set(key, l = []); l.push(item) }
const CHANGE_SETS = ['cards', 'sessions', 'permissions', 'notes', 'published', 'timelines', 'registers', 'invites'] as const
export function changeIsEmpty(c: Change): boolean {
  return c.items.size === 0 && !c.members && !c.alerts && !c.outbox && !c.stack && !c.room && CHANGE_SETS.every(k => c[k].size === 0)
}
export const timelineKey = (timeline_kind: string, timeline_id: string): string => `${timeline_kind}:${timeline_id}`
export interface TimelineKeyParts { timeline_kind: string; timeline_id: string; scope: string; scope_id: string }
export function parseTimelineKey(key: string): TimelineKeyParts {
  const at = key.indexOf(':')
  const timeline_kind = key.slice(0, at), timeline_id = key.slice(at + 1)
  const slash = timeline_id.indexOf('/')
  return { timeline_kind, timeline_id, scope: timeline_id.slice(0, slash), scope_id: timeline_id.slice(slash + 1) }
}

// ---- members and sessions -------------------------------------------------------------

/** A member of a verified member-list state (client membersOf). */
export interface LogMember { device_id: string; device_role: 'human' | 'agent'; is_active: boolean; added_entry_number: number; removed_entry_number: number | null }
/** What GET devices says of a device. */
export interface DeviceReport { device_id: string; is_online?: boolean; offline_since?: number | null; link?: unknown; agent_session_id?: string | null }

/** Rebuild model.members from a verified member-list state (zcrypto state) plus what GET devices said. */
export function applyMembers(model: Model, members: Iterable<LogMember>, change: Change): void {
  const seen = new Set<string>()
  for (const m of members) {
    seen.add(m.device_id)
    const old = model.members.get(m.device_id)
    const reg = model._device_registers?.get(m.device_id) ?? null
    const next = { device_id: m.device_id, device_role: m.device_role, fingerprint: m.device_id.slice(0, 16).match(/.{4}/g)!.join(' '), device_name: reg?.device_name ?? old?.device_name ?? '', platform: reg?.platform ?? null, folder: reg?.folder ?? null, host: reg?.host ?? null,
      is_active: m.is_active, added_entry_number: m.added_entry_number, removed_entry_number: m.removed_entry_number, is_me: m.device_id === model.room.my_device_id,
      is_online: old?.is_online ?? false, offline_since: old?.offline_since ?? null, link: old?.link ?? null, agent_session_id: old?.agent_session_id ?? null }
    model.members.set(m.device_id, next)
    if (m.device_role === 'agent') touchAgent(model, m.device_id, change)
  }
  change.members = true
}
export function applyDevices(model: Model, devices: Iterable<DeviceReport>, change: Change): void {
  for (const d of devices) {
    const m = model.members.get(d.device_id)
    if (!m) continue
    m.is_online = !!d.is_online
    m.offline_since = m.is_online ? null : d.offline_since ?? null
    m.link = cleanLink(d.link)
    if (d.agent_session_id) m.agent_session_id = d.agent_session_id
    if (m.device_role === 'agent') touchAgent(model, d.device_id, change)
  }
  change.members = true
}

// ---- the link: whether an agent's session can hear the human and speak to him ----------------------------
//
// More than is_online ("its connector has a stream"). The connector reports it to the hub (POST agent_link, README
// "The link"), the hub serves it with the device list and pushes every change (stream event `presence`):
//   link = { hears: 'live' | 'oncall', attached, last_call_at, working, cut_since?, exit?: { reason, claude } }
//     hears        'live': Claude Code shows board events at once (the channel flag, or the plugin's monitor wakes it);
//                  'oncall': events wait in the connector and go out with the agent's next tool call
//     attached     an agent's MCP session stands behind the key (false: the process holds the key and nobody listens)
//     last_call_at the agent's last tool call through the connector: the one sign that the AGENT is alive
//     cut_since    a Claude Code session of the folder lives while its connector is gone (seen by this connector)
//     exit         the connector's last word before its stream closed: why, and whether its Claude Code process lived
//                  on ('alive'), ended ('gone') or was still being looked at ('checking')
// The five states, from the hub's two facts (is_online, offline_since) and the report:
//   gone     no stream, and no word that Claude Code lives on: the process ended, was killed, or is off the network
//   cut      no stream but its Claude Code lives (exit.claude 'alive'); or a stream, and a session of its folder lost
//            its connector (cut_since); or a stream with nobody attached. Its tools are dead: it cannot hear or speak
//   live     hears at once (also: an agent that reports nothing, an older connector)
//   oncall   hears on its next tool call
//   asleep   oncall, and no tool call for ASLEEP_MS
/** No tool call for this long, in a session that hears only on its next one: it is not listening. */
export const ASLEEP_MS = 10 * 60_000
const HEARS: readonly unknown[] = ['live', 'oncall'], CLAUDE: readonly unknown[] = ['alive', 'gone', 'checking']
const stamp = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null)
/** A link report as the model keeps it: known fields of the right type only, null when there is none. */
export function cleanLink(report: unknown): Link | null {
  if (!report || typeof report !== 'object') return null
  const l = report as Obj
  if (!HEARS.includes(l['hears'])) return null
  const exit = l['exit'] && typeof l['exit'] === 'object' ? { reason: String(l['exit'].reason ?? '').slice(0, 40), claude: CLAUDE.includes(l['exit'].claude) ? l['exit'].claude : 'gone' } : null
  return { hears: l['hears'], attached: l['attached'] !== false, last_call_at: stamp(l['last_call_at']), working: l['working'] === true, since: stamp(l['since']), cut_since: stamp(l['cut_since']), exit }
}
/**
 * The state of a member's or a session's link (both carry is_online, offline_since, link):
 * { state: 'live' | 'oncall' | 'asleep' | 'cut' | 'gone', since, idle_ms, reason }.
 *   since    when it was cut off or went (null: not known, e.g. after a hub restart); for asleep, its last tool call
 *   idle_ms  oncall and asleep: how long ago its last tool call was
 *   reason   gone and cut: the connector's exit reason ('' when it left without a word), or 'folder' / 'detached'
 */
export function linkState(subject: Linked | null | undefined, now: number = Date.now(), { asleep_ms = ASLEEP_MS }: { asleep_ms?: number } = {}): LinkState {
  const l = subject?.link ?? null
  if (!subject?.is_online) {
    const since = subject?.offline_since ?? null
    return { state: l?.exit?.claude === 'alive' ? 'cut' : 'gone', since, idle_ms: null, reason: l?.exit?.reason ?? '' }
  }
  if (l?.cut_since) return { state: 'cut', since: l.cut_since, idle_ms: null, reason: 'folder' }
  if (l && !l.attached) return { state: 'cut', since: l.since, idle_ms: null, reason: 'detached' }
  if (!l || l.hears !== 'oncall') return { state: 'live', since: null, idle_ms: null, reason: '' }
  const last = l.last_call_at ?? l.since
  const idle_ms = last ? Math.max(0, now - last) : null
  return { state: idle_ms != null && idle_ms >= asleep_ms ? 'asleep' : 'oncall', since: last, idle_ms, reason: '' }
}

// ---- the receipt: what the agent has been handed ------------------------------------------------------------
//
// The connector writes the agent register `heard` = { up_to, at } into a session when it really hands the human's
// commands to the agent (a channel event Claude Code shows, or the text of a tool result): every command of this
// session up to envelope number up_to is with the agent. One mark per session, not one receipt per command: commands of
// a session are handed over in order. End to end like every register. heard_up_to null: this session's connector
// writes no receipts (an older one), nothing is known.
/** Whether the session's agent was handed the envelope: true, false, or null when its connector writes no receipts. */
export const heardBy = (session: { heard_up_to?: number | null } | null | undefined, envelope_number: unknown): boolean | null =>
  (session?.heard_up_to == null || !Number.isInteger(envelope_number) ? null : (envelope_number as number) <= session.heard_up_to)
/** What the agent has to hear of a card: the human's answer in force, else the message that handed it back. Null: nothing. */
export const cardWaitsOn = (card: Pick<Card, 'answer' | 'in_revision'> | null | undefined): number | null =>
  (card?.answer && !card.answer.pending ? card.answer.envelope_number : card?.in_revision?.envelope_number) ?? null
/** Whether the card's agent has the human's last word on it (answer or hand-back): true, false, null (nothing to hear, or not known). */
export function cardHeard(model: Model, card: Card): boolean | null {
  const n = cardWaitsOn(card)
  return n == null ? null : heardBy(card.session_id ? model.sessions.get(card.session_id) : undefined, n)
}

/** A session (R6): its own key, its agents (assigned by grants), its cards and chat. Keyed by session_id. */
export function sessionOf(model: Model, session_id: string): Session {
  let s = model.sessions.get(session_id)
  if (!s) {
    s = { session_id, agent_device_ids: [], ever_agent_ids: [], epoch_agent_ids: {}, agent_device_id: null, agent_session_id: null, device_name: '', is_active: true, is_online: false, offline_since: null, link: null, heard_up_to: null, heard_at: null,
      session_key_epoch: 0, with_history: false, profile: null, status_lines: [], agent_alerts: [], registers: new Map(),
      settings: null, card_ids: [], open_card_ids: [], timeline_key: timelineKey('chat', `session/${session_id}`), last_activity_at: 0 }
    model.sessions.set(session_id, s)
  }
  return s
}
/** Copy the current agent's member facts onto its session. */
function syncSessionAgent(model: Model, s: Session): void {
  const m = s.agent_device_id ? model.members.get(s.agent_device_id) : null
  if (m) { s.agent_session_id = m.agent_session_id ?? m.device_id.slice(0, 16); s.device_name = m.device_name; s.is_active = m.is_active; s.is_online = m.is_online; s.offline_since = m.offline_since ?? null; s.link = m.link ?? null }
}
function touchAgent(model: Model, agent_device_id: string, change: Change): void {
  for (const s of model.sessions.values()) if (s.agent_device_ids.includes(agent_device_id) || s.agent_device_id === agent_device_id) { syncSessionAgent(model, s); change.sessions.add(s.session_id) }
}
/** A verified grant chain state (shared/crypto/session-grants.mjs) for one session, ids as hex. */
export interface GrantState { sessionId: string; agentIds: Iterable<string>; epoch: number; withHistory?: boolean; createdByAgent?: boolean; creatorId?: string | null }
/** A verified grant chain state (shared/crypto/session-grants.mjs) for one session. */
export function applySessionGrant(model: Model, sessionState: GrantState, change: Change, everAgentIds: Iterable<string> = [], epochAgentIds: Record<number, string[]> | null = null): Session {
  const s = sessionOf(model, sessionState.sessionId)
  if (epochAgentIds) s.epoch_agent_ids = epochAgentIds
  s.agent_device_ids = [...sessionState.agentIds]
  for (const a of everAgentIds) if (!s.ever_agent_ids.includes(a)) s.ever_agent_ids.push(a)
  for (const a of s.agent_device_ids) if (!s.ever_agent_ids.includes(a)) s.ever_agent_ids.push(a)
  s.agent_device_id = s.agent_device_ids[0] ?? s.agent_device_id
  s.session_key_epoch = sessionState.epoch
  s.with_history = !!sessionState.withHistory
  // A child session an agent opened itself (its first grant signed by that agent): its parent must be a session of the same agent.
  s.created_by_agent = !!sessionState.createdByAgent
  s.creator_device_id = sessionState.creatorId ?? null
  syncSessionAgent(model, s)
  change.sessions.add(s.session_id)
  change.stack = true
  return s
}
/**
 * The parent a session names in its profile (parent_session: a session id, or an older board id), if it may: a child
 * session an agent opened itself counts only under a session that agent is assigned to, or the agent a human's grant
 * handed the child to (a continued session keeps its helpers); others as before (display only).
 */
export function parentSessionOf(model: Model, s: Session | null | undefined): string | null {
  const want = s?.profile?.parent_session
  if (!s || !want || typeof want !== 'string') return null
  const parent = model.sessions.get(want) ?? null
  if (s.created_by_agent) return parent && parent !== s && childOf(parent, s) ? parent.session_id : null
  return parent ? parent.session_id : want
}
/** A child an agent opened hangs under `parent` if its creator, or an agent a human handed the child to, is assigned to the parent. */
export const childOf = (parent: Pick<Session, 'agent_device_ids'>, s: Pick<Session, 'creator_device_id' | 'agent_device_ids'>): boolean =>
  (parent.agent_device_ids ?? []).some(a => a === s.creator_device_id || (s.agent_device_ids ?? []).includes(a))
const everAgent = (model: Model, sid: string | null | undefined, device: string | null | undefined): boolean => !!sid && (model.sessions.get(sid)?.ever_agent_ids.includes(device as string) ?? false)
/**
 * B03/A7: may this agent write into session `sid` with this record? It must be among the agents the grants gave the
 * session key epoch the record was sealed in (rec._epoch). Dropping an agent always starts a new epoch, so this is
 * "assigned when it wrote", the same for history and live. Records without a known epoch fall back to "ever assigned".
 */
const agentAt = (model: Model, sid: string | null | undefined, device: string | null | undefined, rec: Rec | null | undefined): boolean => {
  const s = sid ? model.sessions.get(sid) : null
  if (!s) return false
  const at = rec?.session_id === sid && rec?._epoch != null ? s.epoch_agent_ids?.[rec._epoch] : null
  return at ? at.includes(device as string) : s.ever_agent_ids.includes(device as string)
}

/** What holds an object: its creator and its session. */
type Held = { agent_device_id: string; session_id?: string | null }
/**
 * R1: who holds an object of a session, judged for one record. Its creator; and once the grants no longer assign the
 * creator to the object's session at the record's session key epoch (a human handed the session on, or let another
 * connector continue it), the agents they assign then. Only a human's grant moves it, and the same on every device.
 */
const holdsAt = (model: Model, obj: Held | null | undefined, device: string | null | undefined, rec: Rec): boolean => !!obj && !!device && (device === obj.agent_device_id
  || (!!obj.session_id && rec?.session_id === obj.session_id && rec._epoch != null && agentAt(model, obj.session_id, device, rec) && !agentAt(model, obj.session_id, obj.agent_device_id, rec)))
/** Who holds an object now (whom a human addresses, who may revise or close it): its creator while assigned, else the session's agent. */
export function holderOf(model: Model, obj: Held | null | undefined): string | null {
  const now = obj?.session_id ? model.sessions.get(obj.session_id)?.agent_device_ids ?? [] : []
  return !obj ? null : !now.length || now.includes(obj.agent_device_id) ? obj.agent_device_id : now[0]!
}

// ---- alerts ---------------------------------------------------------------------------------

let alertSeq = 0
export interface AlertInput { code: string; message?: string; envelope_number?: number | null; sender_device_id?: string | null; source?: 'local' | 'agent' }
export function pushAlert(model: Model, change: Change, { code, message = '', envelope_number = null, sender_device_id = null, source = 'local' }: AlertInput): Alert {
  if (globalThis.process?.env?.['CORE_DEBUG']) console.error('[alert]', code, message, new Error().stack?.split('\n').slice(2, 5).join(' | '))
  const alert: Alert = { alert_id: `${Date.now().toString(36)}-${(alertSeq++).toString(36)}`, code, message, envelope_number, sender_device_id, at: Date.now(), source }
  model.alerts.push(alert)
  if (model.alerts.length > ALERTS_MAX) model.alerts.splice(0, model.alerts.length - ALERTS_MAX)
  change.alerts = true
  return alert
}

// ---- the reducer --------------------------------------------------------------------------

/**
 * rec = { envelope_number, envelope_hash, sender_device_id, sender_role, recipient_device_id | null, sent_at, kind, is_head,
 *         object: { object_id, object_state, urgency, answered_at } | null, timeline_kind, timeline_id,
 *         content: object | null, content_state, bind: decoded (hex) | null }
 * Returns { applied: boolean, refused?: code } so the agent side can tell what counted.
 */
export function applyRecord(model: Model, rec: Rec, change: Change): ApplyResult {
  // R6: an agent holds only its own sessions. Records of another session (the hub serves their headers, e.g. pruned
  // after retention) build nothing on an agent: not even a header-only card or answer (fuzz isolation finding).
  if (rec.session_id && model.room.my_role === 'agent' && rec.sender_device_id !== model.room.my_device_id && !everAgent(model, rec.session_id, model.room.my_device_id)) return { applied: false }
  if (rec.session_id) {
    const s = sessionOf(model, rec.session_id)
    s.last_activity_at = Math.max(s.last_activity_at, rec.sent_at)
    change.sessions.add(rec.session_id)
  }
  // A body of a newer schema: the head counts by its signed header alone (as a pruned one), its content is not read.
  // Timeline items keep it (item_state 'newer_schema' shows the placeholder in place).
  if (rec.content_state === 'newer_schema') {
    noteNewer(model, change, rec.content ? `schema_version ${String(rec.content['schema_version'])}` : 'body format', rec)
    if (rec.kind !== KIND.timeline_item) rec = { ...rec, newer_content: rec.content, content: null }
  }
  switch (rec.kind) {
    case KIND.timeline_item: return applyTimelineItem(model, rec, change)
    case KIND.object_version: return applyObjectVersion(model, rec, change)
    case KIND.answer: return applyAnswer(model, rec, change)
    case KIND.permission_request: return applyPermissionRequest(model, rec, change)
    case KIND.verdict: return applyVerdict(model, rec, change)
    case KIND.status: return applyStatus(model, rec, change)
    case KIND.decide_again: return applyDecideAgain(model, rec, change)
    default: return needsUpdate(model, change, rec, `envelope kind ${rec.kind}`)   // a kind of a newer format (verified, chain whole)
  }
}

const refuse = (model: Model, change: Change, rec: Rec, code: string, message: string): ApplyResult => {
  pushAlert(model, change, { code, message, envelope_number: rec.envelope_number, sender_device_id: rec.sender_device_id })
  return { applied: false, refused: code }
}

// ---- timelines -------------------------------------------------------------------------------

export function timelineOf(model: Model, key: string): Timeline {
  let t = model.timelines.get(key)
  if (!t) {
    const p = parseTimelineKey(key)
    t = { timeline_key: key, timeline_kind: p.timeline_kind, timeline_id: p.timeline_id, object_id: p.scope_id, item_count: 0, newest_envelope_number: 0,
      newest_human_envelope_number: 0, newest_agent_envelope_number: 0, items: new Map(), loaded_down_to: Infinity, has_more: false, window_open: false }
    model.timelines.set(key, t)
  }
  return t
}

/** Item shape from a record (header + content when known). */
export function itemFromRecord(rec: Rec): TimelineItem {
  return {
    envelope_number: rec.envelope_number, local_id: rec.local_id ?? null, pending: false, envelope_hash: rec.envelope_hash, sender_device_id: rec.sender_device_id, sender_sequence: rec.sender_sequence ?? null,
    recipient_device_id: rec.recipient_device_id, sent_at: rec.sent_at,
    item_state: itemStateOf(rec.content, rec.content_state),
    content_type: (rec.content?.['content_type'] as string | undefined) ?? null, content: rec.content ?? null,
  }
}
const KEPT_STATES: readonly unknown[] = ['pruned', 'undecryptable', 'newer_schema']
/** A timeline item's state from its body and content_state: loaded, unsupported (a content type of a newer version),
 *  newer_schema, pruned, undecryptable, or header (the body not fetched yet). */
export const itemStateOf = (content: Body | null | undefined, content_state: ContentState | string | null | undefined): ItemState => (content ? (content_state !== 'ok' ? content_state as ItemState : contentTypeKnown(content) ? 'loaded' : 'unsupported')
  : KEPT_STATES.includes(content_state) ? content_state as ItemState : 'header')
/** A timeline item's content type this version knows (an item without one counts as a message). */
export const contentTypeKnown = (content: Body | null | undefined): boolean => content?.['content_type'] == null || CONTENT_TYPES.includes(content['content_type'] as string)
/** item_state values that mean "a newer client wrote this": the views show the update placeholder. */
export const itemNeedsUpdate = (item: Pick<TimelineItem, 'item_state'> | null | undefined): boolean => item?.item_state === 'unsupported' || item?.item_state === 'newer_schema'

/** R1: who may write into which timeline. Returns null if allowed, else a refusal code. */
export function timelineRefusal(model: Model, rec: Rec): string | null {
  const p = parseTimelineKey(timelineKey(String(rec.timeline_kind), String(rec.timeline_id)))
  const human = rec.sender_role === 'human'
  if (p.timeline_kind === 'chat') {
    if (p.scope === 'session') {
      if (rec.session_id && rec.session_id !== p.scope_id) return 'not-allowed'
      return agentAt(model, p.scope_id, rec.sender_device_id, rec) || (human && everAgent(model, p.scope_id, rec.recipient_device_id)) ? null : 'not-allowed'
    }
    if (p.scope === 'card') {
      const card = model.cards.get(p.scope_id)
      if (!card) return 'card-mismatch'
      return holdsAt(model, card, rec.sender_device_id, rec) || (human && holdsAt(model, card, rec.recipient_device_id, rec)) ? null : 'not-allowed'
    }
    return 'not-allowed'
  }
  if (p.timeline_kind === 'scribble') {
    if (p.scope === 'desk') return human ? null : 'not-allowed'
    if (p.scope === 'session') return human || agentAt(model, p.scope_id, rec.sender_device_id, rec) ? null : 'not-allowed'
    if (p.scope === 'card') return human || holdsAt(model, model.cards.get(p.scope_id), rec.sender_device_id, rec) ? null : 'not-allowed'
    return 'not-allowed'
  }
  return null   // a timeline kind this client does not know yet: count it, show nothing
}

function applyTimelineItem(model: Model, rec: Rec, change: Change): ApplyResult {
  const why = timelineRefusal(model, rec)
  if (why) return refuse(model, change, rec, why, `not allowed in ${rec.timeline_id}`)
  const key = timelineKey(String(rec.timeline_kind), String(rec.timeline_id))
  if (rec.timeline_kind !== 'chat' && rec.timeline_kind !== 'scribble') noteNewer(model, change, `timeline kind ${rec.timeline_kind}`, rec)
  else if (rec.content && rec.content_state === 'ok' && !contentTypeKnown(rec.content)) noteNewer(model, change, `content_type ${String(rec.content['content_type'])}`, rec)
  const t = timelineOf(model, key)
  t.item_count++
  t.newest_envelope_number = Math.max(t.newest_envelope_number, rec.envelope_number)
  if (rec.sender_role === 'human') t.newest_human_envelope_number = rec.envelope_number
  else t.newest_agent_envelope_number = rec.envelope_number
  // The window holds live items (they come in full) and items of opened timelines; replace an own pending echo in place.
  if (rec.content || t.window_open) {
    const item = itemFromRecord(rec)
    if (rec.local_id && t.items.has(rec.local_id)) t.items.delete(rec.local_id)
    t.items.set(rec.envelope_number, item)
    addItem(change, key, item)
  }
  change.timelines.add(key)
  const p = parseTimelineKey(key)
  if (p.timeline_kind === 'chat' && p.scope === 'card') {
    const card = model.cards.get(p.scope_id)
    if (card) {
      const c = rec.content as Obj | null
      // README: in revision until the agent's next version or a message with present_card (the agent presents it again,
      // or a human takes the hand-back back).
      // F2: only an open card goes back to its agent (as the mock room does): a hand-back on an answered or closed card
      // changes nothing, so a device that settles it later from the conversation (client._resolveRevisions) agrees. An own
      // answer still in flight (echo) does not count yet: the hub may order it after this message or refuse it.
      if (c?.['present_card']) card.in_revision = null
      else if (rec.sender_role === 'human' && c && (c['hand_back'] || c['explain']) && (card.object_state === 'open' || card.answer?.pending)) card.in_revision = { by: c['hand_back'] ? 'hand_back' : 'explain', envelope_number: rec.envelope_number }
      change.cards.add(card.object_id)
      if (card.session_id) change.sessions.add(card.session_id)
    }
  } else if (p.scope === 'session') change.sessions.add(p.scope_id)
  return { applied: true }
}

// ---- objects -------------------------------------------------------------------------------

function newCard(object_id: string, agent_device_id: string, rec: Rec): Card {
  return {
    object_id, agent_device_id, object_state: 'open', urgency: 'normal', card_type: 'decision', title: '', teaser: null, body: null, options: [], sections: null, html: null,
    allows_multiple: false, recommended: null, urgency_reason: null, attachments: [], change_note: null, close_summary: null, withdraw_reason: null,
    merged_into_object_id: null, merged_from_object_ids: null, object_version: 0, version_hash: null, envelope_number: rec.envelope_number,
    first_envelope_number: rec.envelope_number, created_at: rec.sent_at, session_id: rec.session_id ?? null, updated_at: rec.sent_at, versions: [], answer: null, answers: [], closed_how: null,
    in_revision: null, timeline_key: timelineKey('chat', `card/${object_id}`), content_state: 'ok',
  }
}
const stateOf = (rec: Rec): { object_state: ObjectState; urgency: Urgency } => ({ object_state: OBJECT_STATE_NAME[rec.object?.object_state as number] ?? 'open', urgency: URGENCY_NAME[rec.object?.urgency as number] ?? 'normal' })

function applyObjectVersion(model: Model, rec: Rec, change: Change): ApplyResult {
  const object_id = rec.object?.object_id
  if (!object_id) return refuse(model, change, rec, 'bad-object', 'object version without object id')
  const c = rec.content as CardBody | null
  const type = ((c ?? rec.newer_content)?.['object_type'] as string | undefined) ?? (model.notes.has(object_id) || rec.sender_role === 'human' ? 'note' : model.published.has(object_id) ? 'published' : 'card')
  if (!c && rec.content_state === 'undecryptable' && model.room.my_role === 'agent' && rec.sender_role === 'human') return { applied: false }   // room scope: not for agents
  if (!OBJECT_TYPES.includes(type)) return needsUpdate(model, change, rec, `object_type ${type}`)
  if (type === 'note') return applyNote(model, rec, change)
  if (type === 'published') return applyPublished(model, rec, change)
  let card = model.cards.get(object_id)
  if (rec.sender_role !== 'agent') return refuse(model, change, rec, 'not-creator', 'cards come from agents')
  const fresh = !card
  if (card && !holdsAt(model, card, rec.sender_device_id, rec)) return refuse(model, change, rec, 'not-creator', 'a card version from someone else than its creator')
  if (rec.session_id && !agentAt(model, rec.session_id, rec.sender_device_id, rec)) return refuse(model, change, rec, 'not-allowed', 'a card in a session this agent is not assigned to')
  if (card && card.session_id !== (rec.session_id ?? null)) return refuse(model, change, rec, 'not-allowed', 'a card version in another session')
  if (fresh && rec.object_id_ok === false) return refuse(model, change, rec, 'bad-object-id', 'object id is not H(creator, sequence of version 1)')
  if (c) {
    const expected = (card?.object_version ?? 0) + 1
    if (c.object_version !== expected) return refuse(model, change, rec, 'bad-version', `card version ${c.object_version}, expected ${expected}`)
    if (expected > 1 && c.previous_version_hash !== card!.version_hash) return refuse(model, change, rec, 'bad-version', 'previous_version_hash does not name the current version')
    if (expected === 1 && c.previous_version_hash && !isZeroHash(c.previous_version_hash)) return refuse(model, change, rec, 'bad-version', 'version 1 names a predecessor')
  }
  if (!card) {
    card = newCard(object_id, rec.sender_device_id, rec)
    model.cards.set(object_id, card)
    if (rec.session_id) {     // kept sorted by created_at (project no longer sorts it)
      const l = sessionOf(model, rec.session_id).card_ids
      let at = l.length
      while (at > 0 && (model.cards.get(l[at - 1]!)?.created_at ?? 0) > card.created_at) at--
      l.splice(at, 0, object_id)
    }
  }
  const st = stateOf(rec)
  const wasOpen = card.object_state === 'open'
  card.object_state = st.object_state
  card.urgency = st.urgency
  card.envelope_number = rec.envelope_number
  card.updated_at = rec.sent_at
  card.version_hash = rec.envelope_hash
  if (c && rec.content_state === 'ok') {
    for (const f of CARD_CONTENT_FIELDS) (card as Obj)[f] = c[f] ?? defaultOf(f)
    card.object_version = c.object_version
    card.content_state = 'ok'
  } else {
    card.object_version = (card.object_version ?? 0) + 1
    card.content_state = rec.content_state
  }
  // A card this version cannot show: a newer schema, or a card_type it does not know (a placeholder, no answer from here).
  card.unsupported = card.content_state === 'newer_schema' ? 'newer_schema' : card.content_state === 'ok' && !CARD_TYPES.includes(card.card_type) ? 'card_type' : null
  if (card.unsupported === 'card_type') noteNewer(model, change, `card_type ${card.card_type}`, rec)
  card.versions.push({ object_version: card.object_version, version_hash: rec.envelope_hash, previous_version_hash: c?.previous_version_hash ?? null,
    envelope_number: rec.envelope_number, sent_at: rec.sent_at, object_state: st.object_state, urgency: st.urgency, content: c ?? null })
  // A new version from the agent ends "in revision" (README projection).
  card.in_revision = null
  if (card.object_state === 'open') { card.closed_how = null; if (!wasOpen && card.answer) card.answer = null }
  else if (card.object_state === 'closed') {
    card.closed_how = card.merged_into_object_id ? 'merged' : card.withdraw_reason ? 'withdrawn' : card.answer?.answer_action === 'read' ? 'read' : card.answer?.answer_action === 'shred' ? 'shredded' : 'closed'
  } else if (card.object_state === 'answered') card.closed_how = 'answered'
  change.cards.add(object_id)
  if (card.session_id) change.sessions.add(card.session_id)
  change.stack = true
  return { applied: true }
}
function defaultOf(f: string): [] | false | 'decision' | '' | null {
  if (f === 'options' || f === 'attachments') return []
  if (f === 'allows_multiple') return false
  if (f === 'card_type') return 'decision'
  if (f === 'title') return ''
  return null
}

function applyNote(model: Model, rec: Rec, change: Change): ApplyResult {
  const object_id = rec.object!.object_id
  if (rec.sender_role !== 'human') return refuse(model, change, rec, 'not-creator', 'notes come from human devices')
  const c = (rec.content ?? {}) as Obj
  const cur = model.notes.get(object_id)
  const old = cur?.pending ? cur._base : cur          // an own optimistic echo is not a version
  if (!old && rec.object_id_ok === false) return refuse(model, change, rec, 'bad-object-id', 'object id is not H(creator, sequence of version 1)')
  // Any human device may write a version; two versions naming the same predecessor are settled by causal order (R2).
  if (old && rec.content && !old.version_hashes.includes(c['previous_version_hash'])) return refuse(model, change, rec, 'bad-version', 'note previous_version_hash names no known version')
  // Retention: a version whose body is gone (pruned, or held as header only) lost its lamport, which is signed inside
  // the body; counted as 0 it lost to the older version this device still held with its body, and a deleted note came
  // back open (fuzz night-srv-w7-98). Where either side has no body, the hub's order decides (the same on every device).
  const after = old && (!rec.content || old.causal?.no_body) ? rec.envelope_number > (old.envelope_number ?? 0) : causallyAfter(rec.causal, old?.causal)
  if (old && !after) {
    old.version_hashes.push(rec.envelope_hash)
    // Our own echo lost to a concurrent version: show the winner.
    if (cur?.pending && rec.local_id && rec.local_id === cur.local_id) { model.notes.set(object_id, old); change.notes.add(object_id) }
    return { applied: false }
  }
  // Our own newer echo stays in front until its version comes back; it keeps the confirmed note as its base.
  if (cur?.pending && rec.local_id !== cur.local_id) {
    cur._base = { ...noteOf(object_id, rec, c, old) }
    change.notes.add(object_id)
    return { applied: true }
  }
  model.notes.set(object_id, noteOf(object_id, rec, c, old))
  change.notes.add(object_id)
  return { applied: true }
}

function noteOf(object_id: string, rec: Rec, c: Obj, old: Note | null | undefined): Note {
  const { schema_version: _sv, object_type: _ot, object_version: _ov, previous_version_hash: _pv, lamport: _l, ...extra } = c
  return { ...extra, object_id, by_device_id: rec.sender_device_id, text: c['text'] ?? old?.text ?? '',
    object_version: c['object_version'] ?? (old?.object_version ?? 0) + 1, version_hash: rec.envelope_hash,
    version_hashes: [...(old?.version_hashes ?? []), rec.envelope_hash], causal: rec.content ? rec.causal as Causal | null : { ...rec.causal!, no_body: true }, envelope_number: rec.envelope_number, object_state: stateOf(rec).object_state, pending: false, unsupported: rec.content_state === 'newer_schema' }
}

function applyPublished(model: Model, rec: Rec, change: Change): ApplyResult {
  const object_id = rec.object!.object_id
  const old = model.published.get(object_id)
  if (rec.sender_role !== 'agent') return refuse(model, change, rec, 'not-creator', 'published objects come from agents')
  if (rec.session_id && !agentAt(model, rec.session_id, rec.sender_device_id, rec)) return refuse(model, change, rec, 'not-allowed', 'a published object in a session this agent is not assigned to')
  if (old && !holdsAt(model, old, rec.sender_device_id, rec)) return refuse(model, change, rec, 'not-creator', 'a published object from someone else than its creator')
  if (!old && rec.object_id_ok === false) return refuse(model, change, rec, 'bad-object-id', 'object id is not H(creator, sequence of version 1)')
  const c = (rec.content ?? {}) as Obj
  const expected = (old?.object_version ?? 0) + 1
  if (rec.content && c['object_version'] !== expected) return refuse(model, change, rec, 'bad-version', `published version ${c['object_version']}, expected ${expected}`)
  // N4: a later version names its predecessor (as cards do).
  if (rec.content && old && c['previous_version_hash'] && c['previous_version_hash'] !== old.version_hash) return refuse(model, change, rec, 'bad-version', 'previous_version_hash does not name the current version')
  model.published.set(object_id, { object_id, agent_device_id: old?.agent_device_id ?? rec.sender_device_id, session_id: rec.session_id ?? old?.session_id ?? null, attachments: c['attachments'] ?? old?.attachments ?? [], title: c['title'] ?? old?.title ?? '',
    note: c['note'] ?? null, released_until: c['released_until'] ?? null, object_version: expected, version_hash: rec.envelope_hash, envelope_number: rec.envelope_number, object_state: stateOf(rec).object_state })
  change.published.add(object_id)
  if (rec.session_id) change.sessions.add(rec.session_id)
  return { applied: true }
}

// ---- answers --------------------------------------------------------------------------------

/**
 * Whether an answer counts. The same rule on every client; the agent's authoriseCommand checks the same and more.
 * Returns null if it counts, else a refusal code.
 */
export function answerRefusal(model: Model, rec: Rec): string | null {
  const card = model.cards.get(rec.object?.object_id as string)
  if (rec.sender_role !== 'human') return 'not-human'
  if (!card) return 'card-mismatch'
  if (!holdsAt(model, card, rec.recipient_device_id, rec)) return 'not-for-owner'
  const b = rec.bind
  // F9: retention pruned it (no body, no bind): the signed header still says the card was answered or closed.
  if (!b && !rec.content && (rec.content_state === 'pruned' || rec.content_state === 'header')) return card.object_state === 'open' ? null : 'card-closed'
  if (!b || b.cardId !== card.object_id) return 'card-mismatch'
  if (card.object_state !== 'open') return 'card-closed'
  if ((b.versionHash ?? b.cardHash) !== card.version_hash) return 'answer-stale'
  const c = rec.content as AnswerBody | null
  if (!c) return null   // pruned: the hub kept the header only; it counted when it was sent
  // An answer action of a newer version: it counts by its signed header (answered or closed), as a pruned one does.
  if (typeof c.answer_action === 'string' && !ANSWER_ACTIONS.includes(c.answer_action)) return null
  if (!ANSWER_ACTIONS.includes(c.answer_action)) return 'bad-answer'
  // F24: this device holds only the card's header (retention; e.g. decided again after a prune): it cannot check the
  // choices against options it never saw. The bind names this version; the owner agent, which holds the card, checks the rest.
  if (card.content_state && card.content_state !== 'ok') return null
  const choices = c.choices ?? []
  // R7: the bind carries the whole list of choices (v1: only the first).
  const bound = b.choices ?? (b.choice ? [b.choice] : [])
  if (JSON.stringify(bound) !== JSON.stringify(b.choices ? choices : choices.slice(0, 1))) return 'bad-answer'
  if (c.answer_action === 'answer') {
    const keys = new Set((card.options ?? []).map(o => o.key))
    if (card.card_type === 'info') return 'bad-answer'
    // R7 / L2: "trusted" widens nothing: its choices are the agent's own recommendation, each one an option.
    if (c.trusted) {
      const rec = card.recommended == null ? [] : Array.isArray(card.recommended) ? card.recommended : [card.recommended]
      if (choices.some(k => !keys.has(k) || !rec.includes(k))) return 'bad-choice'
    } else if (!choices.length || choices.some(k => !keys.has(k))) return 'bad-choice'
    if (choices.length > 1 && !card.allows_multiple) return 'bad-choice'
    // A closed header on an answer settles the card: only where every choice is an option its agent marked final,
    // and never for a trusted answer (the agent still has to choose and say what it chose).
    if (stateOf(rec).object_state === 'closed' && (c.trusted || !choicesFinal(card, choices))) return 'bad-answer'
  }
  if (c.answer_action === 'read' && card.card_type !== 'info') return 'bad-answer'
  return null
}

/** Every choice is an option the agent marked final (and there is at least one): the answer alone ends the matter. */
export function choicesFinal(card: { options?: (CardOption | null | undefined)[] | null } | null | undefined, choices: unknown): boolean {
  const final = new Set((card?.options ?? []).filter(o => o?.final === true).map(o => o!.key))
  return Array.isArray(choices) && choices.length > 0 && choices.every(k => final.has(k))
}

function applyAnswer(model: Model, rec: Rec, change: Change): ApplyResult {
  const why = answerRefusal(model, rec)
  if (why) {
    // F15: the hub takes the object's state from this refused answer's header (closed) while the card stays open on every
    // client. Kept on the card (and stored with it), so the owner re-sends the card even after a crash or restart.
    const card = model.cards.get(rec.object?.object_id as string)
    if (card && rec.is_head !== false && stateOf(rec).object_state !== 'open' && rec.envelope_number > (card.refused_head ?? 0) && rec.envelope_number > card.envelope_number) { card.refused_head = rec.envelope_number; change.cards.add(card.object_id) }
    return refuse(model, change, rec, why, 'answer not counted')
  }
  const card = model.cards.get(rec.object!.object_id)!
  const c = (rec.content ?? {}) as AnswerBody
  const newerAction = typeof c.answer_action === 'string' && !ANSWER_ACTIONS.includes(c.answer_action)
  if (newerAction) noteNewer(model, change, `answer_action ${c.answer_action}`, rec)
  const answer: Answer = {
    answer_action: c.answer_action ?? 'answer', choices: c.choices ?? [], note: c.note ?? null, option_notes: c.option_notes ?? {}, attachments: c.attachments ?? [],
    marks: c.marks ?? [], trusted: !!c.trusted, bound_version_hash: rec.bind?.cardHash ?? null, bound_object_version: card.object_version,
    envelope_number: rec.envelope_number, envelope_hash: rec.envelope_hash, by_device_id: rec.sender_device_id, answered_at: rec.object!.answered_at || rec.sent_at,
    taken_back_at: null, taken_back_sent_at: null, pending: false, ...(newerAction || rec.newer_content ? { unsupported: true as const } : {}),
  }
  card.answer = answer
  card.answers.push(answer)
  const st = stateOf(rec)
  card.object_state = st.object_state === 'open' ? 'answered' : st.object_state
  // settled: an answer that closed the card itself (every choice a final option); the agent never has to close it.
  card.closed_how = answer.answer_action === 'read' ? 'read' : answer.answer_action === 'shred' ? 'shredded' : card.object_state === 'closed' && rec.content && !newerAction ? 'settled' : card.object_state === 'closed' ? 'closed' : 'answered'
  card.in_revision = null
  card.updated_at = rec.sent_at
  change.cards.add(card.object_id)
  if (card.session_id) change.sessions.add(card.session_id)
  change.stack = true
  return { applied: true }
}

/** F15: own open cards the hub holds as closed (a refused answer is their newest head): the owner re-sends them. */
export function cardsToReassert(model: Model, my_device_id: string): string[] {
  const out: string[] = []
  for (const c of model.cards.values()) if (holderOf(model, c) === my_device_id && c.object_state === 'open' && (c.refused_head ?? 0) > c.envelope_number) out.push(c.object_id)
  return out
}

/** F2: the newest envelope that changed whether the card is open (its version, an answer, a decide-again); a hand-back counts only after it. */
export function revisionCutoff(card: Pick<Card, 'envelope_number' | 'answers'>): number {
  let n = card.envelope_number
  for (const a of card.answers ?? []) n = Math.max(n, a.envelope_number ?? 0, a.taken_back_at ?? 0)
  return n
}

export function decideAgainRefusal(model: Model, rec: Rec): string | null {
  const card = model.cards.get(rec.object?.object_id as string)
  if (rec.sender_role !== 'human') return 'not-human'
  if (!card) return 'card-mismatch'
  if (!holdsAt(model, card, rec.recipient_device_id, rec)) return 'not-for-owner'
  if (!rec.bind || rec.bind.cardId !== card.object_id) return 'card-mismatch'
  if (!card.answer || card.answer.envelope_hash !== rec.bind.previousHash) return 'decision-mismatch'
  if (rec.bind.versionHash && rec.bind.versionHash !== card.version_hash) return 'card-changed'
  // What the human closed with an answer (read, shredded, settled by a final option) they may take back; what the
  // agent closed (done, withdrawn, merged) stays closed.
  if (card.object_state === 'closed' && ['closed', 'withdrawn', 'merged'].includes(card.closed_how as string)) return 'card-closed'
  return null
}
function applyDecideAgain(model: Model, rec: Rec, change: Change): ApplyResult {
  const why = decideAgainRefusal(model, rec)
  if (why) return refuse(model, change, rec, why, 'decide again not counted')
  const card = model.cards.get(rec.object!.object_id)!
  card.answer!.taken_back_at = rec.envelope_number
  card.answer!.taken_back_sent_at = rec.sent_at
  card.answer = null
  card.object_state = 'open'
  card.closed_how = null
  card.updated_at = rec.sent_at
  change.cards.add(card.object_id)
  if (card.session_id) change.sessions.add(card.session_id)
  change.stack = true
  return { applied: true }
}

// ---- permission requests -----------------------------------------------------------------

function applyPermissionRequest(model: Model, rec: Rec, change: Change): ApplyResult {
  const object_id = rec.object?.object_id
  if (rec.sender_role !== 'agent') return refuse(model, change, rec, 'not-creator', 'permission requests come from agents')
  if (rec.session_id && !agentAt(model, rec.session_id, rec.sender_device_id, rec)) return refuse(model, change, rec, 'not-allowed', 'a permission request in a session this agent is not assigned to')
  const known = object_id ? model.permissions.get(object_id) : null
  // A second head of the same object from its agent, closed: the agent withdraws its request (the prompt was answered
  // elsewhere). Only a pending request changes; one already answered keeps its verdict, quietly.
  if (known && known.agent_device_id === rec.sender_device_id && OBJECT_STATE_NAME[rec.object?.object_state as number] === 'closed') {
    if (known.permission_state !== 'pending') return { applied: false }
    known.permission_state = 'withdrawn'
    known.withdraw_reason = (rec.content?.['withdraw_reason'] as string | undefined) ?? ''
    change.permissions.add(known.object_id)
    if (known.session_id) change.sessions.add(known.session_id)
    change.stack = true
    return { applied: true }
  }
  if (!object_id || known) return refuse(model, change, rec, 'bad-object', 'permission request without a new object id')
  if (rec.bind && rec.bind.requestId !== object_id) return refuse(model, change, rec, 'bad-object', 'request id differs from object id')
  if (rec.object_id_ok === false) return refuse(model, change, rec, 'bad-object-id', 'object id is not H(creator, sequence)')
  const c = (rec.content ?? {}) as Obj
  const p: PermissionRequest = { object_id, agent_device_id: rec.sender_device_id, session_id: rec.session_id ?? null, tool_name: c['tool_name'] ?? '', description: c['description'] ?? '', input_preview: c['input_preview'] ?? '',
    expires_at: rec.bind?.expiresAt ?? 0, version_hash: rec.envelope_hash, envelope_number: rec.envelope_number, sent_at: rec.sent_at, permission_state: 'pending', verdict: null, withdraw_reason: null }
  model.permissions.set(object_id, p)
  change.permissions.add(object_id)
  if (rec.session_id) change.sessions.add(rec.session_id)
  change.stack = true
  return { applied: true }
}
export function verdictRefusal(model: Model, rec: Rec): string | null {
  const p = model.permissions.get((rec.object?.object_id ?? rec.bind?.requestId) as string)
  if (rec.sender_role !== 'human') return 'not-human'
  if (!p || !rec.bind || rec.bind.requestId !== p.object_id) return 'request-mismatch'
  if (rec.recipient_device_id !== p.agent_device_id) return 'not-for-owner'
  if (p.permission_state !== 'pending') return 'request-not-pending'
  if (rec.bind.requestHash !== p.version_hash || rec.bind.expiresAt !== p.expires_at) return 'request-changed'
  return null
}
function applyVerdict(model: Model, rec: Rec, change: Change): ApplyResult {
  const why = verdictRefusal(model, rec)
  if (why) return refuse(model, change, rec, why, 'verdict not counted')
  const p = model.permissions.get(rec.bind!.requestId!)!
  p.verdict = { allow: rec.bind!.allow as boolean, by_device_id: rec.sender_device_id, envelope_number: rec.envelope_number }
  p.permission_state = rec.bind!.allow ? 'allowed' : 'denied'
  change.permissions.add(p.object_id)
  if (p.session_id) change.sessions.add(p.session_id)
  change.stack = true
  return { applied: true }
}

// ---- registers ------------------------------------------------------------------------------

const HUMAN_PREFIXES = ['draft/', 'snooze/', 'duck/', 'desk/', 'session/', 'session_history/', 'scribble_snapshot/']
const isHumanKey = (k: string) => k === 'crown' || k === 'room_snapshot' || HUMAN_PREFIXES.some(p => k.startsWith(p))
const isAgentKey = (k: string) => k === 'profile' || k === 'heard' || k.startsWith('status_line/') || k.startsWith('alert/')

function applyStatus(model: Model, rec: Rec, change: Change): ApplyResult {
  const values = rec.content?.['values']
  if (!values || typeof values !== 'object') {
    if (rec.content_state === 'ok') return refuse(model, change, rec, 'bad-status', 'status without values')
    return { applied: false }
  }
  for (const [key, value] of Object.entries(values as Obj)) {
    if (key.startsWith('device/')) {
      if (key !== `device/${rec.sender_device_id}`) { refuse(model, change, rec, 'foreign-key', `${key} from another device`); continue }
      model._device_registers ??= new Map()
      model._device_registers.set(rec.sender_device_id, value)
      model._register_log ??= new Map()
      const m = model.members.get(rec.sender_device_id)
      if (m) {
        m.device_name = value?.device_name ?? ''; m.platform = value?.platform ?? null; m.folder = value?.folder ?? null; m.host = value?.host ?? null
        change.members = true
        if (m.device_role === 'agent') touchAgent(model, m.device_id, change)
      }
      change.registers.add(key)
    } else if (rec.sender_role === 'human' && isHumanKey(key)) {
      if (model.room.my_role === 'agent') continue   // agents ignore human keys
      setHumanRegister(model, key, value, rec, change)
    } else if (rec.sender_role === 'agent' && isAgentKey(key)) {
      if (!rec.session_id || !agentAt(model, rec.session_id, rec.sender_device_id, rec)) { refuse(model, change, rec, 'not-allowed', `${key} outside the agent's session`); continue }
      setAgentRegister(model, rec.session_id, key, value, rec, change)
    } else if (rec.sender_role === 'agent' && isHumanKey(key) || rec.sender_role === 'human' && isAgentKey(key)) {
      refuse(model, change, rec, 'foreign-key', `${key} is not a ${rec.sender_role} key`)
    } else if (rec.sender_role === 'agent') {
      if (rec.session_id && agentAt(model, rec.session_id, rec.sender_device_id, rec)) setAgentRegister(model, rec.session_id, key, value, rec, change)    // unknown agent keys are kept raw
    } else if (model.room.my_role !== 'agent') {
      setHumanRegister(model, key, value, rec, change)                           // unknown human keys are kept raw
    }
  }
  return { applied: true }
}

/** What a human register write carries (a record, an own echo, or a stored raw value read back). */
export interface RegisterWrite { envelope_number?: number | null; sender_device_id?: string | null; pending?: boolean; causal?: Causal | null | undefined }

export function setHumanRegister(model: Model, key: string, value: unknown, rec: RegisterWrite, change: Change): false | undefined {
  const h = model.human
  const old = h.raw.get(key)
  // R2: the causally latest write wins, whatever order the hub delivered them in. A delete stays as a tombstone (value null).
  if (!rec.pending && old && !old.pending && rec.causal && old.causal && !causallyAfter(rec.causal, old.causal)) return false
  h.raw.set(key, { value: value ?? null, envelope_number: rec.envelope_number as number | null, by_device_id: rec.sender_device_id as string | null, pending: !!rec.pending, causal: rec.causal ?? old?.causal ?? null })
  const slash = key.indexOf('/')
  const prefix = slash < 0 ? key : key.slice(0, slash), id = slash < 0 ? null : key.slice(slash + 1)
  const put = <V>(map: Map<string, V>, v: unknown) => (v === null || v === undefined ? map.delete(id as string) : map.set(id as string, v as V))
  switch (prefix) {
    case 'draft': put(h.drafts, value); change.cards.add(id as string); break
    case 'snooze': put(h.snoozes, value); change.cards.add(id as string); change.stack = true; break
    case 'duck': put(h.ducks, value); change.cards.add(id as string); break
    case 'crown': h.crown = value ?? null; break
    case 'desk': put(h.desks, value); break
    case 'session': {
      put(h.session_settings, value)
      const s = sessionOf(model, id as string); s.settings = (value as SessionSettings | null | undefined) ?? null; change.sessions.add(id as string); change.stack = true; break
    }
    case 'scribble_snapshot': put(h.scribble_snapshots, value); change.timelines.add(timelineKey('scribble', id as string)); break
  }
  change.registers.add(key)
  return undefined
}

function setAgentRegister(model: Model, session_id: string, key: string, value: any, rec: Rec, change: Change): void {
  const s = sessionOf(model, session_id)
  const agent = rec.sender_device_id
  const old = s.registers.get(key)
  // R2 as for human registers: one total order of writes; a delete stays as a tombstone (value null).
  if (old && rec.causal && old.causal ? !causallyAfter(rec.causal, old.causal) : old?.sender_sequence && rec.sender_sequence && rec.sender_sequence <= old.sender_sequence) return
  s.registers.set(key, { value: value ?? null, envelope_number: rec.envelope_number, sender_sequence: rec.sender_sequence, causal: rec.causal ?? null })
  if (key === 'profile') s.profile = value ?? null
  else if (key === 'heard') {
    // The mark only rises: a receipt is never taken back.
    const up_to = Number.isSafeInteger(value?.up_to) && value.up_to >= 0 ? value.up_to as number : null
    if (up_to != null && up_to >= (s.heard_up_to ?? -1)) { s.heard_up_to = up_to; s.heard_at = stamp(value.at) ?? rec.sent_at ?? null }
  }
  else if (key.startsWith('status_line/')) {
    const id = key.slice('status_line/'.length)
    const at = s.status_lines.findIndex(l => l.id === id)
    if (value === null || value === undefined) { if (at >= 0) s.status_lines.splice(at, 1) }
    else {
      const line = { id, label: value.label ?? id, state: value.state ?? null, detail: value.detail ?? null, object_id: value.object_id ?? null, envelope_number: rec.envelope_number, updated_at: rec.sent_at }
      if (at >= 0) s.status_lines[at] = line; else s.status_lines.push(line)
    }
  } else if (key.startsWith('alert/')) {
    const at = s.agent_alerts.findIndex(a => a.key === key)
    if (value === null || value === undefined) { if (at >= 0) s.agent_alerts.splice(at, 1) }
    else {
      const a = { key, value, envelope_number: rec.envelope_number }
      if (at >= 0) s.agent_alerts[at] = a; else s.agent_alerts.push(a)
      pushAlert(model, change, { code: value?.code ?? 'agent-alert', message: value?.message ?? '', envelope_number: rec.envelope_number, sender_device_id: agent, source: 'agent' })
    }
  }
  change.sessions.add(session_id)
  change.registers.add(key)
}

// ---- projections ----------------------------------------------------------------------------

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const stackKey = (c: Card): StackKey => [URGENCY_RANK[c.urgency] ?? 1, c.created_at, c.agent_device_id ?? '', c.object_id]
const cmpKey = (x: StackKey, y: StackKey) => (y[0] - x[0]) || (x[1] - y[1]) || cmpStr(x[2], y[2]) || cmpStr(x[3], y[3])
function bisect(arr: string[], key: StackKey, keyOf: (id: string) => StackKey): number { let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (cmpKey(keyOf(arr[mid]!), key) < 0) lo = mid + 1; else hi = mid } return lo }
const byCreated = (model: Model) => (a: string, b: string) => (model.cards.get(a)?.created_at ?? 0) - (model.cards.get(b)?.created_at ?? 0) || cmpStr(a, b)

/**
 * Stack, per-session card lists, open permissions. Incremental (perf, 4 Oct): the open cards are kept sorted
 * (model._proj.sorted, with each card's sort key), and only the cards and sessions a change touched are looked at;
 * the first call after a bulk load (model._proj unset) builds everything once. The stack then filters snoozed cards
 * and archived sessions out of the sorted list (O(open cards), no sorting), and only when a change names a card, a
 * session, a snooze or a session register, or the clock passed the end of a snooze: a chat message, a stroke or a
 * status line costs nothing here.
 */
export function project(model: Model, change: Change, now: number = Date.now()): void {
  const before = model.stack, beforePerm = model.open_permission_ids
  let P = model._proj
  const touchedSessions = new Set<string>()
  if (!P) {
    const p = model._proj = { keys: new Map<string, StackKey>(), sorted: [] as string[], nextPermExpiry: Infinity, stackDirty: true, nextWake: Infinity, permsDirty: true }
    P = p
    for (const s of model.sessions.values()) { s.card_ids.sort(byCreated(model)); touchedSessions.add(s.session_id) }
    for (const c of model.cards.values()) if (c.object_state === 'open') p.keys.set(c.object_id, stackKey(c))
    p.sorted = [...p.keys.keys()].sort((x, y) => cmpKey(p.keys.get(x)!, p.keys.get(y)!))
  } else {
    const p = P
    for (const id of change.cards) {
      const c = model.cards.get(id)
      const old = p.keys.get(id)
      // the card's session list of open cards, by edit (sorted by created_at like card_ids)
      const s = c?.session_id ? model.sessions.get(c.session_id) : null
      if (s && c) {
        const at = s.open_card_ids.indexOf(id)
        const open = c.object_state === 'open'
        if (open && at < 0) { let i = s.open_card_ids.length; while (i > 0 && (model.cards.get(s.open_card_ids[i - 1]!)?.created_at ?? 0) > c.created_at) i--; s.open_card_ids.splice(i, 0, id) }
        else if (!open && at >= 0) s.open_card_ids.splice(at, 1)
      }
      if (old) { const at = bisect(p.sorted, old, k => p.keys.get(k)!); if (p.sorted[at] === id) p.sorted.splice(at, 1); else p.sorted.splice(p.sorted.indexOf(id), 1); p.keys.delete(id) }
      if (c && c.object_state === 'open') { const key = stackKey(c); p.sorted.splice(bisect(p.sorted, key, k => p.keys.get(k)!), 0, id); p.keys.set(id, key) }
    }
    if (change.permissions.size || now > p.nextPermExpiry) p.permsDirty = true
    // The stack is filtered again only when something it depends on changed: a card, a session (archived), a snooze, or
    // the clock passed a snooze's end.
    if (change.cards.size || change.sessions.size || now >= p.nextWake) p.stackDirty = true
    else for (const k of change.registers) if (k.startsWith('snooze/') || k.startsWith('session/')) { p.stackDirty = true; break }
  }
  for (const sid of touchedSessions) {
    const s = model.sessions.get(sid)
    if (s) s.open_card_ids = s.card_ids.filter(id => model.cards.get(id)?.object_state === 'open')
  }
  if (P.stackDirty) {
    P.stackDirty = false
    const snoozes = model.human.snoozes
    const archived = new Set<string>()
    for (const s of model.sessions.values()) if (s.settings?.archived) archived.add(s.session_id)
    const stack: string[] = []
    let wake = Infinity
    for (const id of P.sorted) {
      if (snoozes.size) { const v = snoozes.get(id); if (v && (v.until == null || v.until > now)) { if (v.until != null && v.until < wake) wake = v.until; continue } }
      if (archived.size && archived.has(model.cards.get(id)?.session_id as string)) continue
      stack.push(id)
    }
    model.stack = stack
    P.nextWake = wake
  }
  if (P.permsDirty) {
    P.permsDirty = false
    const pending = [...model.permissions.values()].filter(p => p.permission_state === 'pending' && now <= p.expires_at)
    P.nextPermExpiry = Math.min(Infinity, ...pending.map(p => p.expires_at))
    model.open_permission_ids = pending.sort((a, b) => a.envelope_number - b.envelope_number).map(p => p.object_id)
  }
  const same = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i])
  if (!same(before, model.stack) || !same(beforePerm, model.open_permission_ids)) change.stack = true
}

/** The stack of one desk (desk_id), or of all (none). */
export function stackOf(model: Model, { desk_id }: { desk_id?: string | null } = {}): string[] {
  if (desk_id == null) return model.stack
  return model.stack.filter(id => (model.sessions.get(model.cards.get(id)?.session_id as string)?.settings?.desk ?? null) === desk_id)
}

// ---- persistence: records <-> model ------------------------------------------------------

const mapToObj = <V>(m: Map<string, V>): Record<string, V> => Object.fromEntries(m)
const objToMap = <V>(o: Record<string, V> | null | undefined): Map<string, V> => new Map(Object.entries(o ?? {}))

/** A session as stored: its registers as entries. */
export type StoredSession = Omit<Session, 'registers'> & { registers: [string, Session['registers'] extends Map<string, infer V> ? V : never][] }
export function serialiseSession(s: Session): StoredSession { return { ...s, registers: [...s.registers] } }
export function deserialiseSession(o: StoredSession): Session { return { ...o, registers: new Map(o.registers ?? []) } }
/** A timeline's metadata as stored: no items, no window. */
export type StoredTimelineMeta = Omit<Timeline, 'items' | 'loaded_down_to'> & { loaded_down_to: number | null }
export function serialiseTimelineMeta(t: Timeline): StoredTimelineMeta { const { items: _items, ...rest } = t; return { ...rest, loaded_down_to: Number.isFinite(t.loaded_down_to) ? t.loaded_down_to : null, window_open: false } }
// F8: the window is empty after a restart, so paging starts again from the newest item (a persisted low mark would skip it).
export function deserialiseTimelineMeta(o: StoredTimelineMeta): Timeline { return { ...o, items: new Map(), loaded_down_to: Infinity, window_open: false } }
/** Human registers are rebuilt from raw values (one source of truth). */
export function deserialiseHuman(model: Model, o: { raw?: Iterable<[string, { value: unknown; envelope_number: number | null; by_device_id: string | null; causal?: Causal | null }]> } | null | undefined): void {
  const change = emptyChange()
  for (const [key, v] of o?.raw ?? []) setHumanRegister(model, key, v.value, { envelope_number: v.envelope_number, sender_device_id: v.by_device_id, causal: v.causal }, change)
}
export { mapToObj, objToMap, URGENCY }

// ---- a card at rest (storage, the room snapshot): without what it holds twice ----------------------------------
// The newest version's content is the card's own fields again, and `answer` is the last of `answers`: stored once
// (a room's cards were ~4 KB each, most of a warm start's reading). compactCard keeps a field only where rebuilding
// gives exactly what was there; expandCard gives the same object back.
const AT_REST = '$card'
export function compactCard(c) {
  let out = c
  const lv = c.versions?.at(-1)
  if (lv?.content && typeof lv.content === 'object') {
    const own = [], rest = {}
    for (const [k, v] of Object.entries(lv.content)) { if (k in c && JSON.stringify(c[k]) === JSON.stringify(v)) own.push(k); else rest[k] = v }
    if (own.length) {
      const keys = Object.keys(lv.content)
      out = { ...c, versions: [...c.versions.slice(0, -1), { ...lv, content: { [AT_REST]: own, rest, keys } }] }
    }
  }
  if (c.answer && c.answers?.length && (c.answers.at(-1) === c.answer || JSON.stringify(c.answers.at(-1)) === JSON.stringify(c.answer))) out = { ...(out === c ? { ...c } : out), answer: AT_REST }
  return out
}
export function expandCard(v) {
  if (!v || typeof v !== 'object') return v
  const lv = v.versions?.at(-1)
  if (lv?.content?.[AT_REST]) {
    const { [AT_REST]: own, rest, keys } = lv.content
    const content = {}
    for (const k of keys) content[k] = own.includes(k) ? v[k] : rest[k]   // (shared, as the reducer shares them: a new version replaces fields, never edits them)
    v.versions[v.versions.length - 1] = { ...lv, content }
  }
  if (v.answer === AT_REST) v.answer = v.answers?.at(-1) ?? null
  return v
}
