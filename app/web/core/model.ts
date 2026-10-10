// model.ts: the builder of the board model (core/README.md "The model" is the contract with the views; the shapes
// are types.ts). No crypto, no I/O, no rules of its own: under protocol v2 the signature, the sender's chain, who may
// write what, an object's state (spec/v1.md 9.2.1), which register value is the current one (9.3.2) and the command
// gate are the Rust core's. This file PROJECTS what the core accepted into the one model the views read, and marks
// in a `change` what it touched. The engine calls it in the hub's order:
//
//   applyEnvelope(model, received, change, ctx)   one stored item as the core took it (core-api.ts ReceivedEnvelope)
//   applyGroups(model, groups, roles, change)     the device's groups: members and sessions
//   applyCommit(model, facts, change, opts)       what a Commit did, as far as a human is told
//   applyPresence(model, reports, change, now)    who is connected, an agent's link report
//   applyWorkTrail(model, session, step, n, change)   one step of a running turn (7.3)
//   applyStrokePiece(model, piece, change, ctx)   the points of a stroke still being drawn (7.2)
//   echo… / confirmEcho / rollbackEcho            own sends, shown at once ("Human actions" in the README)
//   project(model, change, now)                   the stack, open permission requests, each session's card lists
//   cacheRecords / modelFromCache                 the model's records to and from the app's local cache
//
// How protocol v2 fills the fields whose meaning changed (everything else is as the README says):
//   envelope_number (everywhere)   the hub's change number under which the envelope arrived
//   room.key_epoch                 the room group's epoch
//   room.last_envelope_number      the device's cursor (the engine sets it)
//   member.added_entry_number,     the room group's epoch in which this device first saw the member, and the one in
//     removed_entry_number         which it was gone (only their order is shown)
//   member.device_role             'agent' also for a helper device
//   session.session_id             the session id of the group's extension; the session IS that group
//   session.agent_device_ids       the group's leaves that are no human device
//   session.agent_device_id        main session: its agent device; helper session: its first helper device, else its opener
//   session.agent_session_id       the first 16 hex of agent_device_id
//   session.session_key_epoch      the session group's epoch
//   session.parent_session_id      a helper session's main session, a signed fact of its group; also given as
//                                  profile.parent_session, with profile.is_main for a main session
//   session.creator_device_id      a helper session's opener; created_by_agent is always false
//   session.is_active              the group is not archived and has an agent device
//   card.agent_device_id           the object's owner now, as the core says (9.2): it moves when the owner leaves
//   card.version_hash, answer.envelope_hash, note.version_hash   the envelope hash, hex
//   item.sender_sequence           the sender's `seq`; a shape's id is `<sender hex>/<seq>/<index>` (base64url on the wire)
//   human.scribble_snapshots       by 'desk/<board hex>', from the register board_snapshot/<board>
//   note.causal, register causal   kept for display; the core says which write is current
//   permission_state 'withdrawn'   has no source any more; 'expired' is set by project() when the clock passed expires_at
// Gone, with nothing in v2 behind them and no view reading them: room.last_entry_number, room.agent_session_id,
// member.agent_session_id, session.ever_agent_ids, epoch_agent_ids, with_history, desk_goals, card.refused_head,
// timeline.newest_human_envelope_number / newest_agent_envelope_number, the registers room_snapshot and session_history/.
import { ANSWER_ACTIONS, BOARD_CONTENT_TYPES, CARD_CONTENT_FIELDS, CARD_TYPES, decodeBody, decodePiece } from './codec.ts'
import type { BodyKind, Fields } from './codec.ts'
import type { CommitSummary, GroupSummary, ReceivedEnvelope, ReceivedMessage, RoomRoles, Sealed } from './core-api.ts'
import { hex } from './ids.ts'
import { emptyModel, emptyChange, emptyNewer } from './model-shape.ts'
import { stepEnvelope } from './work.ts'
import type {
  Alert, Answer, Body, Card, CardOption, Causal, Change, ContentState, HumanRegister, ItemState, Link, Linked, LinkState, Member, Model, Note,
  ObjectState, PermissionRequest, Published, Session, SessionSettings, StackKey, Timeline, TimelineItem, WorkEnvelope,
} from './types.ts'

export { emptyModel, emptyChange }
const ALERTS_MAX = 200
const URGENCY_RANK: Record<string, number> = { critical: 3, high: 2, normal: 1, low: 0 }
type Obj = Record<string, any>
const isObject = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
/** A live message's JSON as text ('' for bytes that are no UTF-8: no body reads it). */
const text = (bytes: Uint8Array): string => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return '' } }

// ---- what the builder keeps for itself -----------------------------------------------------------------------------

/** An own send shown before the hub confirmed it, and what undoes it. */
type Echo =
  | { kind: 'item'; timeline_key: string }
  | { kind: 'registers'; before: Map<string, HumanRegister | undefined>; open: Set<string> }
  | { kind: 'answer'; object_id: string; state: ObjectState; version_hash: string | null; saved: Pick<Card, 'answer' | 'object_state' | 'closed_how'> }
  | { kind: 'note'; key: string }
interface Turn { timeline_key: string; session_id: string; sender: string; started_at: number; last: number }
interface Projection { keys: Map<string, StackKey>; sorted: string[]; nextPermExpiry: number; stackDirty: boolean; permsDirty: boolean; nextWake: number }
interface Builder {
  proj: Projection | null
  /** Each device's own register `device/<id>`: its name, platform, folder, host. */
  device_registers: Map<string, Obj>
  echoes: Map<string, Echo>
  /** Envelope hash of a sealed own send -> its local id. */
  by_hash: Map<string, string>
  /** Running turns, by turn id. */
  turns: Map<string, Turn>
}
function builder(model: Model): Builder {
  return (model._builder ??= { proj: null, device_registers: new Map(), echoes: new Map(), by_hash: new Map(), turns: new Map() }) as Builder
}

// ---- small things the client and the views' seam use ---------------------------------------------------------------

const NEWER_WHAT_MAX = 16
/** Something only a newer Trommi understands was met: counted in model.newer, so the app says so once. */
export function noteNewer(model: Model, change: Change, what: string, at: { envelope_number?: number | null } | null | undefined): void {
  const n = (model.newer ??= emptyNewer())
  n.count++
  if (!n.what.includes(what)) { n.what.push(what); if (n.what.length > NEWER_WHAT_MAX) n.what.shift() }
  n.envelope_number = Math.max(n.envelope_number, at?.envelope_number ?? 0)
  change.room = true
}
/** Whether this version can show and act on a card (false: a placeholder, no answer from here). */
export const cardSupported = (card: { unsupported?: unknown } | null | undefined): boolean => !card?.unsupported
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

let alertSeq = 0
export interface AlertInput { code: string; message?: string; envelope_number?: number | null; sender_device_id?: string | null; source?: 'local' | 'agent'; at?: number }
export function pushAlert(model: Model, change: Change, { code, message = '', envelope_number = null, sender_device_id = null, source = 'local', at = Date.now() }: AlertInput): Alert {
  const alert: Alert = { alert_id: `${at.toString(36)}-${(alertSeq++).toString(36)}`, code, message, envelope_number, sender_device_id, at, source }
  model.alerts.push(alert)
  if (model.alerts.length > ALERTS_MAX) model.alerts.splice(0, model.alerts.length - ALERTS_MAX)
  change.alerts = true
  return alert
}

export const GOALS_LINES = 20, GOALS_LINE_MAX = 200
/** A desk's goals as they are kept: at most GOALS_LINES lines of at most GOALS_LINE_MAX characters, no blank lines. */
export function cleanGoals(text: unknown): string {
  return String(text ?? '').split(/\r?\n/).map(l => l.trim().slice(0, GOALS_LINE_MAX)).filter(Boolean).slice(0, GOALS_LINES).join('\n')
}
/** Every choice is an option the agent marked final (and there is at least one): the answer alone ends the matter. */
export function choicesFinal(card: { options?: (CardOption | null | undefined)[] | null } | null | undefined, choices: unknown): boolean {
  const final = new Set((card?.options ?? []).filter(o => o?.final === true).map(o => o!.key))
  return Array.isArray(choices) && choices.length > 0 && choices.every(k => final.has(k))
}

// ---- the link: whether an agent's session can hear the human and speak to him ----------------------------
//
// More than is_online ("its connector has a stream"). The connector reports it to the hub (spec 13.7), the hub
// serves it and pushes every change (stream event `presence`):
//   link = { hears: 'live' | 'oncall', attached, last_call_at, working, cut_since?, exit?: { reason, claude } }
//     hears        'live': Claude Code shows board events at once; 'oncall': events wait in the connector and go out
//                  with the agent's next tool call
//     attached     an agent's MCP session stands behind the key (false: the process holds the key and nobody listens)
//     last_call_at the agent's last tool call through the connector: the one sign that the AGENT is alive
//     cut_since    a Claude Code session of the folder lives while its connector is gone (seen by this connector)
//     exit         the connector's last word before its stream closed: why, and whether its Claude Code process lived
//                  on ('alive'), ended ('gone') or was still being looked at ('checking')
// The five states, from the hub's two facts (is_online, offline_since) and the report:
//   gone     no stream, and no word that Claude Code lives on
//   cut      no stream but its Claude Code lives (exit.claude 'alive'); or a stream, and a session of its folder lost
//            its connector (cut_since); or a stream with nobody attached
//   live     hears at once (also: an agent that reports nothing)
//   oncall   hears on its next tool call
//   asleep   oncall, and no tool call for ASLEEP_MS
/** No tool call for this long, in a session that hears only on its next one: it is not listening. */
export const ASLEEP_MS = 10 * 60_000
const HEARS: readonly unknown[] = ['live', 'oncall'], CLAUDE: readonly unknown[] = ['alive', 'gone', 'checking']
const stamp = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null)
/** A link report as the model keeps it: known fields of the right type only, null when there is none. */
export function cleanLink(report: unknown): Link | null {
  if (!isObject(report) || !HEARS.includes(report['hears'])) return null
  const l = report
  const exit = isObject(l['exit']) ? { reason: String(l['exit']['reason'] ?? '').slice(0, 40), claude: CLAUDE.includes(l['exit']['claude']) ? l['exit']['claude'] : 'gone' } : null
  return { hears: l['hears'], attached: l['attached'] !== false, last_call_at: stamp(l['last_call_at']), working: l['working'] === true, since: stamp(l['since']), cut_since: stamp(l['cut_since']), exit }
}
/**
 * The state of a member's or a session's link (both carry is_online, offline_since, link):
 * { state: 'live' | 'oncall' | 'asleep' | 'cut' | 'gone', since, idle_ms, reason }.
 *   since    when it was cut off or went (null: not known); for asleep, its last tool call
 *   idle_ms  oncall and asleep: how long ago its last tool call was
 *   reason   gone and cut: the connector's exit reason ('' when it left without a word), or 'folder' / 'detached'
 */
export function linkState(subject: Linked | null | undefined, now: number = Date.now(), { asleep_ms = ASLEEP_MS }: { asleep_ms?: number } = {}): LinkState {
  const l = subject?.link ?? null
  if (!subject?.is_online) return { state: l?.exit?.claude === 'alive' ? 'cut' : 'gone', since: subject?.offline_since ?? null, idle_ms: null, reason: l?.exit?.reason ?? '' }
  if (l?.cut_since) return { state: 'cut', since: l.cut_since, idle_ms: null, reason: 'folder' }
  if (l && !l.attached) return { state: 'cut', since: l.since, idle_ms: null, reason: 'detached' }
  if (!l || l.hears !== 'oncall') return { state: 'live', since: null, idle_ms: null, reason: '' }
  const last = l.last_call_at ?? l.since
  const idle_ms = last ? Math.max(0, now - last) : null
  return { state: idle_ms != null && idle_ms >= asleep_ms ? 'asleep' : 'oncall', since: last, idle_ms, reason: '' }
}

// ---- the receipt: what the agent has been handed ------------------------------------------------------------
// The connector writes the session register `heard` = { up_to, at } when it really hands the human's commands to the
// agent: every command of this session up to envelope number up_to is with the agent. heard_up_to null: nothing is known.
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

// ---- members and sessions ------------------------------------------------------------------------------------------

const fingerprintOf = (device_id: string): string => device_id.slice(0, 16).match(/.{4}/g)!.join(' ')
/** A session: one session group, its agent device, its cards and Chat. Keyed by session_id. */
export function sessionOf(model: Model, session_id: string): Session {
  let s = model.sessions.get(session_id)
  if (!s) {
    s = { session_id, group_id: null, agent_device_ids: [], agent_device_id: null, agent_session_id: null, device_name: '', is_active: true, stale: false, group_archived: false,
      is_online: false, offline_since: null, link: null, heard_up_to: null, heard_at: null, session_key_epoch: 0, created_by_agent: false, creator_device_id: null, parent_session_id: null,
      profile: null, status_lines: [], agent_alerts: [], registers: new Map(), settings: null, card_ids: [], open_card_ids: [],
      timeline_key: timelineKey('chat', `session/${session_id}`), last_activity_at: 0 }
    model.sessions.set(session_id, s)
  }
  return s
}
/** The session's profile as the views read it: the agent's register, with the parent and "is a main session" from the group. */
function composeProfile(s: Session): void {
  const raw = s.registers.get('profile')?.value
  if (!isObject(raw) && s.group_id == null) { s.profile = null; return }
  const { parent_session: _p, is_main: _m, ...own } = isObject(raw) ? raw : {}
  s.profile = { ...own, ...(s.parent_session_id ? { parent_session: s.parent_session_id } : {}), ...(s.group_id != null ? { is_main: s.parent_session_id == null } : {}) }
}
/** Copy the speaking device's facts onto its session; a helper session without a device of its own shows its opener's. */
function syncSessionAgent(model: Model, s: Session): void {
  const m = s.agent_device_id ? model.members.get(s.agent_device_id) : undefined
  const opener = s.creator_device_id && s.creator_device_id !== s.agent_device_id ? model.members.get(s.creator_device_id) : undefined
  s.agent_session_id = s.agent_device_id?.slice(0, 16) ?? null
  s.device_name = m?.device_name || opener?.device_name || ''
  s.is_online = Boolean(m?.is_online || opener?.is_online)
  s.offline_since = s.is_online ? null : m?.offline_since ?? opener?.offline_since ?? null
  s.link = (m?.is_online || !opener?.is_online ? m?.link : null) ?? opener?.link ?? null
}
function touchAgent(model: Model, device_id: string, change: Change): void {
  for (const s of model.sessions.values()) if (s.agent_device_id === device_id || s.creator_device_id === device_id) { syncSessionAgent(model, s); change.sessions.add(s.session_id) }
}
function memberOf(model: Model, device_id: string, device_role: Member['device_role'], epoch: number): Member {
  let m = model.members.get(device_id)
  if (!m) {
    const reg = builder(model).device_registers.get(device_id)
    m = { device_id, device_role, fingerprint: fingerprintOf(device_id), device_name: String(reg?.['device_name'] ?? ''), platform: reg?.['platform'] ?? null, folder: reg?.['folder'] ?? null, host: reg?.['host'] ?? null,
      is_active: true, added_entry_number: epoch, removed_entry_number: null, is_me: device_id === model.room.my_device_id, is_online: false, offline_since: null, link: null }
    model.members.set(device_id, m)
  }
  return m
}

/**
 * The device's groups as the core holds them now (Device.groups(), Device.room_roles()): replaces the members and
 * the sessions' facts. Human devices are the room's, agent devices the roles', and every other leaf of a session
 * group is a helper device (shown as an agent). A device that is no longer among them stays in model.members as
 * removed, so its old messages keep their name. Call it after every processed Commit and after joining a group.
 */
export function applyGroups(model: Model, groups: readonly GroupSummary[], roles: RoomRoles | null, change: Change): void {
  const room = groups.find(g => g.session === null)
  const epoch = roles?.epoch ?? room?.epoch ?? model.room.key_epoch
  if (model.room.key_epoch !== epoch) { model.room.key_epoch = epoch; change.room = true }
  const humans = new Set((roles?.humans ?? room?.leaves ?? []).map(hex))
  const agents = new Set((roles?.agents ?? []).map(hex))
  const now = new Map<string, Member['device_role']>()
  for (const d of humans) now.set(d, 'human')
  for (const d of agents) now.set(d, 'agent')
  const live = new Set<string>()
  for (const g of groups) {
    if (!g.session) continue
    const s = sessionOf(model, hex(g.session.sessionId))
    live.add(s.session_id)
    const others = g.leaves.map(hex).filter(d => !humans.has(d))
    for (const d of others) if (!now.has(d)) now.set(d, 'agent')
    s.group_id = hex(g.group)
    s.parent_session_id = refHex(g.session.parent)
    // A helper session's opener is its main session's agent device, a leaf of both groups (5.2.3); its other leaves
    // that are no human device are helper devices.
    const opener = s.parent_session_id ? others.find(d => agents.has(d)) ?? null : null
    s.creator_device_id = opener
    s.agent_device_ids = others
    const speaker = s.parent_session_id ? others.find(d => d !== opener) ?? others[0] : others.find(d => agents.has(d)) ?? others[0]
    s.agent_device_id = speaker ?? s.agent_device_id       // an empty seat keeps showing who sat there
    s.stale = g.disallowed.length > 0
    s.group_archived = g.archived
    s.session_key_epoch = g.epoch
    s.is_active = !g.archived && speaker !== undefined
  }
  for (const s of model.sessions.values()) {
    if (s.group_id != null && !live.has(s.session_id)) s.is_active = false     // its group is gone from this device
    change.sessions.add(s.session_id)
  }
  for (const [device_id, role] of now) {
    const m = memberOf(model, device_id, role, epoch)
    m.device_role = role; m.is_active = true; m.removed_entry_number = null; m.is_me = device_id === model.room.my_device_id
  }
  for (const m of model.members.values()) if (!now.has(m.device_id) && m.is_active) { m.is_active = false; m.removed_entry_number = epoch }
  for (const s of model.sessions.values()) { composeProfile(s); syncSessionAgent(model, s) }
  change.members = true
  change.stack = true
}

/**
 * What a processed Commit did, as far as a human is told (core-api.ts Processed.commit; its `epoch` is the one it
 * builds on). The lists themselves come with the next applyGroups; this marks removed devices at once and raises
 * the alerts: `by_recovery` (a join from outside into the room group with the recovery code: CommitSummary.external
 * and the entry's recoveryAuth): every human device says that a device came in with the code; `removed_me`
 * (Processed.removed): this device was removed.
 */
export function applyCommit(model: Model, facts: CommitSummary, change: Change, { by_recovery = false, removed_me = false, now = Date.now() }: { by_recovery?: boolean; removed_me?: boolean; now?: number } = {}): void {
  const group = hex(facts.group)
  const session = [...model.sessions.values()].find(s => s.group_id === group)
  const removed = facts.removes.map(hex)
  if (session) {
    session.session_key_epoch = facts.epoch + 1
    session.agent_device_ids = session.agent_device_ids.filter(d => !removed.includes(d))
    change.sessions.add(session.session_id)
  } else for (const id of removed) {       // the room group: the device is no member any more
    const m = model.members.get(id)
    if (!m || !m.is_active) continue
    m.is_active = false; m.removed_entry_number = facts.epoch + 1
    change.members = true
    touchAgent(model, id, change)
  }
  if (by_recovery) pushAlert(model, change, { code: 'recovery-add', message: 'a device was added with the recovery code: if that was not you, remove it and make a new recovery code', sender_device_id: hex(facts.committer), at: now })
  if (removed_me) pushAlert(model, change, { code: 'removed', message: 'this device was removed from the room', sender_device_id: hex(facts.committer), at: now })
}

/** What the hub says of a device (GET, and the stream's `presence` event): ids as the model's hex. */
export interface DeviceReport { device_id: string; is_online?: boolean; offline_since?: number | null; link?: unknown }
/** Who is connected, and each agent's link report. A device that stopped working, or went, ends its running turns. */
export function applyPresence(model: Model, reports: Iterable<DeviceReport>, change: Change, now: number = Date.now()): void {
  for (const d of reports) {
    const m = model.members.get(d.device_id)
    if (!m) continue
    m.is_online = !!d.is_online
    m.offline_since = m.is_online ? null : d.offline_since ?? null
    m.link = cleanLink(d.link)
    if (m.device_role === 'agent') {
      touchAgent(model, d.device_id, change)
      if (!m.is_online || (m.link && !m.link.working)) endTurns(model, t => t.sender === d.device_id, now, change)
    }
    change.members = true
  }
}

/** Who holds an object now (whom a human addresses an answer or a verdict to): its owner while that device is a
 *  leaf of the session's group, else the session's agent device (a helper session: its opener), as spec 9.2 says. */
export function holderOf(model: Model, obj: { agent_device_id: string; session_id?: string | null } | null | undefined): string | null {
  if (!obj) return null
  const s = obj.session_id ? model.sessions.get(obj.session_id) : undefined
  if (!s || !s.agent_device_ids.length || s.agent_device_ids.includes(obj.agent_device_id)) return obj.agent_device_id
  return recipientOf(model, s.session_id)
}
/** Whom a human addresses a Chat message of a session to: its agent device; in a helper session its opener (9.2). */
export function recipientOf(model: Model, session_id: string): string | null {
  const s = model.sessions.get(session_id)
  return !s ? null : s.parent_session_id ? s.creator_device_id : s.agent_device_id
}
/** A helper session's main session, if this device knows it. */
export const parentSessionOf = (model: Model, s: Session | null | undefined): string | null => (s?.parent_session_id && model.sessions.has(s.parent_session_id) ? s.parent_session_id : null)
/** Whether a device writes as a human: by the member list; a device this model never saw as a member is one when it
 *  addressed someone (a human's items name their agent, an agent's name nobody). */
const isHuman = (model: Model, device_id: string, recipient: string | null): boolean => { const m = model.members.get(device_id); return m ? m.device_role === 'human' : recipient != null }

// ---- timelines -------------------------------------------------------------------------------------------------------

export function timelineOf(model: Model, key: string): Timeline {
  let t = model.timelines.get(key)
  if (!t) {
    const p = parseTimelineKey(key)
    t = { timeline_key: key, timeline_kind: p.timeline_kind, timeline_id: p.timeline_id, object_id: p.scope_id, item_count: 0, newest_envelope_number: 0,
      items: new Map(), loaded_down_to: Infinity, has_more: false, window_open: false }
    model.timelines.set(key, t)
  }
  return t
}
const KEPT_STATES: readonly unknown[] = ['pruned', 'undecryptable', 'newer_schema']
/** A timeline item's content type this version knows (an item without one counts as a message). */
export const contentTypeKnown = (content: Body | null | undefined): boolean => content?.['content_type'] == null || content['content_type'] === 'message' || content['content_type'] === 'stroke_piece' || BOARD_CONTENT_TYPES.includes(content['content_type'] as string)
/** A timeline item's state from its body and content_state: loaded, unsupported (a content type of a newer version),
 *  newer_schema, pruned, undecryptable, or header (the body not here yet). */
export const itemStateOf = (content: Body | null | undefined, content_state: ContentState | string | null | undefined): ItemState => (content ? (content_state !== 'ok' ? content_state as ItemState : contentTypeKnown(content) ? 'loaded' : 'unsupported')
  : KEPT_STATES.includes(content_state) ? content_state as ItemState : 'header')
/** item_state values that mean "a newer client wrote this": the views show the update placeholder. */
export const itemNeedsUpdate = (item: Pick<TimelineItem, 'item_state'> | null | undefined): boolean => item?.item_state === 'unsupported' || item?.item_state === 'newer_schema'

// ---- one received envelope ---------------------------------------------------------------------------------------------

/** What the engine knows beside the envelope: the clock (for alerts). */
export interface ApplyContext { now: number }
/** Whether the envelope changed what the model shows, and the code of a finding it raised. */
export interface ApplyResult { applied: boolean; refused?: string }
/** Codes under which an envelope took its place in its sender's chain with a body that cannot be read here; its
 *  header still counts (9.2.1) and its place shows a placeholder. */
const UNREAD_STATE: Readonly<Record<string, ContentState>> = { pruned: 'pruned', 'newer-version': 'newer_schema', 'no-key': 'undecryptable', 'decrypt-failed': 'undecryptable', 'bad-format': 'undecryptable' }
/** Findings a human is not told: an envelope met twice, a body the hub pruned, one whose key this device never held. */
const QUIET: readonly unknown[] = ['replay', 'pruned', 'no-key', 'newer-version']

function finding(model: Model, change: Change, r: ReceivedEnvelope, ctx: ApplyContext, what: string): ApplyResult {
  const code = r.code ?? r.outcome
  if (!QUIET.includes(code)) pushAlert(model, change, { code, message: what, envelope_number: r.change, sender_device_id: hex(r.header.sender), at: ctx.now })
  return { applied: false, refused: code }
}
/** A body as the model reads it, or why it is not read. */
function bodyOf(r: ReceivedEnvelope, kind: BodyKind): { content: Fields | null; state: ContentState } {
  if ((r.outcome === 'applied' || r.outcome === 'provisional') && r.payload != null) {
    const d = decodeBody(kind, r.payload)
    return d === 'newer_schema' ? { content: null, state: 'newer_schema' } : d === 'bad' ? { content: null, state: 'undecryptable' } : { content: d, state: 'ok' }
  }
  return { content: null, state: UNREAD_STATE[r.code ?? ''] ?? 'header' }
}
const zeroHash = (h: string | null | undefined): boolean => !h || /^0*$/.test(h)
const refHex = (id: Uint8Array | null | undefined): string | null => { const h = id ? hex(id) : null; return zeroHash(h) ? null : h }

/**
 * One envelope as the core took it, in the hub's order (or out of order: a page of a Chat, an object, the Desk).
 *   applied      it passed every check: its body is read and takes effect
 *   chained      it stands in its sender's chain but its body is not applied: with `pruned`, `newer-version`,
 *                `no-key`, `decrypt-failed` or `bad-format` its header still counts (an object's state, an item's
 *                place: a placeholder, "needs a newer Trommi"); with `forbidden` or `wrong-epoch` it counts for nothing
 *   void         the hub's void record: nothing; an own echo of it is rolled back
 *   provisional  shown (an item in its window, a version's or an answer's content), and it sets an object's state
 *                only where the model knows nothing newer; the chain confirms it later under the same hash
 *   refused      it consumed nothing: an alert, unless it is only met twice
 */
export function applyEnvelope(model: Model, r: ReceivedEnvelope, change: Change, ctx: ApplyContext = { now: Date.now() }): ApplyResult {
  const h = r.header
  const hash = hex(r.envelopeHash)
  const B = builder(model)
  const local_id = B.by_hash.get(hash) ?? null
  if (r.outcome === 'refused') return finding(model, change, r, ctx, `an envelope was refused (${r.code ?? 'no reason'})`)
  if (r.outcome === 'void') {
    if (local_id) rollbackEcho(model, local_id, change)
    return finding(model, change, r, ctx, `the hub holds envelope #${h.seq} of this sender as void (${r.code ?? 'no reason'})`)
  }
  const ordered = r.outcome !== 'provisional'
  if (r.outcome === 'chained' && !(r.code! in UNREAD_STATE)) {
    if (local_id) rollbackEcho(model, local_id, change)
    return finding(model, change, r, ctx, `envelope #${h.seq} of this sender does not count (${r.code ?? 'no reason'})`)
  }
  if (r.code === 'newer-version') noteNewer(model, change, 'body format', { envelope_number: r.change })
  if (ordered && h.sessionId) {
    const s = sessionOf(model, hex(h.sessionId))
    s.last_activity_at = Math.max(s.last_activity_at, h.time)
    change.sessions.add(s.session_id)
  }
  switch (h.kind) {
    case 'item': return applyItem(model, r, change, hash, local_id, ordered)
    case 'register': return applyRegister(model, r, change, ctx, hash, local_id, ordered)
    case 'reserved': noteNewer(model, change, 'envelope kind', { envelope_number: r.change }); return { applied: false, refused: 'needs-update' }
    default: return applyObject(model, r, change, ctx, hash, local_id, ordered)
  }
}

// ---- items: Chat messages and board items -------------------------------------------------------------------------

function applyItem(model: Model, r: ReceivedEnvelope, change: Change, hash: string, local_id: string | null, ordered: boolean): ApplyResult {
  const h = r.header, tl = h.timeline
  if (!tl) return { applied: false }
  const board = tl.kind === 'board'
  const onCard = tl.kind === 'cardChat'
  const key = board ? timelineKey('scribble', `desk/${hex(tl.id)}`) : timelineKey('chat', `${onCard ? 'card' : 'session'}/${hex(tl.id)}`)
  const sender = hex(h.sender), recipient = h.recipient ? hex(h.recipient) : null
  const { content, state } = bodyOf(r, board ? 'board_item' : 'message')
  const t = timelineOf(model, key)
  if (ordered && r.change > t.newest_envelope_number) { t.item_count++; t.newest_envelope_number = r.change }
  const B = builder(model)
  const item: TimelineItem = {
    envelope_number: r.change, local_id, pending: false, envelope_hash: hash, sender_device_id: sender, sender_sequence: h.seq, recipient_device_id: recipient, sent_at: h.time,
    item_state: itemStateOf(content, state), content_type: (content?.['content_type'] as string | undefined) ?? null, content, ...(ordered ? {} : { provisional: true }),
  }
  if (item.item_state === 'unsupported') noteNewer(model, change, `content_type ${String(content?.['content_type'])}`, { envelope_number: r.change })
  // The window holds what has a body, what an opened timeline counts, and an own echo's place: replaced in place.
  // A board's window holds every item: an open board has to learn of one it cannot read (it then writes no snapshot).
  const had = t.items.get(r.change)
  if (local_id) { t.items.delete(local_id); B.echoes.delete(local_id); B.by_hash.delete(hash) }
  if ((content || t.window_open || had || local_id || board) && !(had && !had.provisional && !ordered && had.content)) {
    t.items.set(r.change, item)
    addItem(change, key, item)
  }
  change.timelines.add(key)
  if (!ordered) return { applied: true }
  if (board) {
    // The finished form of a stroke replaces what was shown of its pieces.
    for (const e of content?.['content_type'] === 'strokes' ? content['strokes'] as Obj[] : []) if (e['live']) t.items.delete(`live:${sender}/${e['live']}`)
    return { applied: true }
  }
  const human = isHuman(model, sender, recipient)
  if (onCard) {
    const card = model.cards.get(hex(tl.id))
    if (card) {
      // In revision until the agent's next version or a message with present_card. Only an open card goes back to its
      // agent; an own answer still in flight (echo) does not count yet: the hub may order it after this message.
      if (content?.['present_card']) card.in_revision = null
      else if (human && content && (content['hand_back'] || content['explain']) && (card.object_state === 'open' || card.answer?.pending)) card.in_revision = { by: content['hand_back'] ? 'hand_back' : 'explain', envelope_number: r.change }
      change.cards.add(card.object_id)
      if (card.session_id) change.sessions.add(card.session_id)
    }
  } else {
    change.sessions.add(hex(tl.id))
    // The agent's final text of a turn ends the trail of what it did.
    if (!human && content?.['terminal'] === 'answer') endTurns(model, turn => turn.timeline_key === key && turn.sender === sender, h.time, change)
  }
  return { applied: true }
}

// ---- objects: cards, Notes, permission requests, Artifacts ------------------------------------------------------------

function applyObject(model: Model, r: ReceivedEnvelope, change: Change, ctx: ApplyContext, hash: string, local_id: string | null, ordered: boolean): ApplyResult {
  const o = r.header.object
  if (!o) return { applied: false }
  // In the hub's order only what the core's replay of headers counted moves an object (9.2.1).
  if (ordered && !r.objectAfter) {
    if (local_id) rollbackEcho(model, local_id, change)
    return finding(model, change, r, ctx, `envelope #${r.header.seq} of this sender did not change its object`)
  }
  switch (o.objectType) {
    case 'card': return applyCard(model, r, change, hash, local_id, ordered)
    case 'note': return applyNote(model, r, change, hash, local_id)
    case 'request': return applyRequest(model, r, change, hash)
    case 'artifact': return applyArtifact(model, r, change, hash)
    default: noteNewer(model, change, `object type ${String(o.objectType)}`, { envelope_number: r.change }); return { applied: false, refused: 'needs-update' }
  }
}
/** The state the envelope leaves its object in: the core's replay, else (out of order) the header's own word. */
const stateAfter = (r: ReceivedEnvelope): ObjectState => r.objectAfter?.objectState ?? r.header.object!.objectState

function newCard(object_id: string, owner: string, r: ReceivedEnvelope): Card {
  const h = r.header
  return {
    object_id, agent_device_id: owner, object_state: 'open', urgency: 'normal', card_type: 'decision', title: '', teaser: null, body: null, options: [], sections: null, html: null,
    allows_multiple: false, recommended: null, urgency_reason: null, attachments: [], change_note: null, close_summary: null, withdraw_reason: null,
    merged_into_object_id: null, merged_from_object_ids: null, object_version: 0, version_hash: null, envelope_number: 0, first_envelope_number: r.change, created_at: h.time,
    session_id: h.sessionId ? hex(h.sessionId) : null, updated_at: h.time, versions: [], answer: null, answers: [], closed_how: null,
    in_revision: null, timeline_key: timelineKey('chat', `card/${object_id}`), content_state: 'header', state_envelope_number: 0,
  }
}
function defaultOf(f: string): [] | false | 'decision' | '' | null {
  if (f === 'options' || f === 'attachments') return []
  if (f === 'allows_multiple') return false
  if (f === 'card_type') return 'decision'
  if (f === 'title') return ''
  return null
}
/** Put a record into a list kept ascending by envelope_number. */
function insertByNumber<T extends { envelope_number: number | null }>(list: T[], x: T): void {
  let at = list.length
  while (at > 0 && (list[at - 1]!.envelope_number ?? Infinity) > (x.envelope_number ?? Infinity)) at--
  list.splice(at, 0, x)
}
/** How a card that its current version closed was closed. */
const versionClosedHow = (card: Card): Card['closed_how'] =>
  (card.merged_into_object_id ? 'merged' : card.withdraw_reason ? 'withdrawn' : card.answer?.answer_action === 'read' ? 'read' : card.answer?.answer_action === 'shred' ? 'shredded' : 'closed')
/** How an answer left its card. */
const answerClosedHow = (card: Card, a: Answer): Card['closed_how'] =>
  (a.answer_action === 'read' ? 'read' : a.answer_action === 'shred' ? 'shredded' : card.object_state === 'closed' ? (a.unsupported || a['no_body'] ? 'closed' : 'settled') : 'answered')

function applyCard(model: Model, r: ReceivedEnvelope, change: Change, hash: string, local_id: string | null, ordered: boolean): ApplyResult {
  const h = r.header, o = h.object!, n = r.change
  const object_id = hex(o.objectId)
  let card = model.cards.get(object_id)
  const touched = () => { change.cards.add(object_id); if (card?.session_id) change.sessions.add(card.session_id); change.stack = true }
  const state = stateAfter(r)
  if (h.kind === 'version') {
    const { content, state: content_state } = bodyOf(r, 'card')
    const B = builder(model)
    if (!card) {
      card = newCard(object_id, hex(r.objectAfter?.owner ?? h.sender), r)
      model.cards.set(object_id, card)
      if (card.session_id) {       // kept sorted by created_at (project does not sort it)
        const l = sessionOf(model, card.session_id).card_ids
        let at = l.length
        while (at > 0 && (model.cards.get(l[at - 1]!)?.created_at ?? 0) > card.created_at) at--
        l.splice(at, 0, object_id)
      }
    }
    if (r.objectAfter) card.agent_device_id = hex(r.objectAfter.owner)
    const first = refHex(o.objectRef) === null
    // Its first version came after a later one (out of order): its place in every list is worked out again.
    if (first && (n < card.first_envelope_number || card.created_at !== h.time)) { card.first_envelope_number = Math.min(card.first_envelope_number, n); card.created_at = h.time; B.proj = null }
    let v = card.versions.find(x => x.version_hash === hash)
    if (!v) {
      v = { object_version: 0, version_hash: hash, previous_version_hash: refHex(o.objectRef), envelope_number: n, sent_at: h.time, object_state: state, urgency: o.urgency, content: content as Body | null }
      insertByNumber(card.versions, v)
      v.object_version = Number.isInteger(content?.['object_version']) ? content!['object_version'] as number : card.versions.indexOf(v) + 1
    } else if (content && !v.content) {
      v.content = content as Body
      if (Number.isInteger(content['object_version'])) v.object_version = content['object_version'] as number
    }
    if (n >= card.envelope_number) {      // the newest version this device knows: the card's own fields
      card.envelope_number = n
      card.version_hash = hash
      card.object_version = v.object_version
      card.urgency = o.urgency
      if (v.content) { for (const f of CARD_CONTENT_FIELDS) (card as Obj)[f] = (v.content as Obj)[f] ?? defaultOf(f); card.content_state = 'ok' }
      else card.content_state = content_state
      card.unsupported = card.content_state === 'newer_schema' ? 'newer_schema' : card.content_state === 'ok' && !CARD_TYPES.includes(card.card_type) ? 'card_type' : null
      if (card.unsupported === 'card_type') noteNewer(model, change, `card_type ${card.card_type}`, { envelope_number: n })
      if (ordered) card.in_revision = null      // a new version from the agent ends "in revision"
    }
    if (n >= card.state_envelope_number) {
      const wasOpen = card.object_state === 'open'
      card.state_envelope_number = n
      card.object_state = state
      card.updated_at = h.time
      if (state === 'open') { card.closed_how = null; if (!wasOpen && card.answer && !card.answer.pending) card.answer = null }
      else card.closed_how = state === 'closed' ? versionClosedHow(card) : 'answered'
    } else if (card.version_hash === hash && card.object_state === 'closed' && card.closed_how === 'closed') card.closed_how = versionClosedHow(card)   // its body came after its header
    touched()
    return { applied: true }
  }
  if (!card) return { applied: false }       // an answer or a take back of a card this device holds no version of
  if (h.kind === 'answer') {
    // The hub's copy of an own answer: the echo goes first, the real one is put in as it counted.
    if (local_id) rollbackEcho(model, local_id, change)
    const { content, state: content_state } = bodyOf(r, 'answer')
    const bind = r.bind?.kind === 'answer' ? r.bind : null
    const bound = bind?.versionHash ? hex(bind.versionHash) : refHex(o.objectRef)
    const action = typeof content?.['answer_action'] === 'string' ? content['answer_action'] : 'answer'
    const newer = content_state === 'newer_schema' || !ANSWER_ACTIONS.includes(action)
    if (content && !ANSWER_ACTIONS.includes(action)) noteNewer(model, change, `answer_action ${action}`, { envelope_number: n })
    const fields = {
      answer_action: action, choices: (content?.['choices'] as string[] | undefined) ?? bind?.choices ?? [], note: (content?.['note'] as string | undefined) ?? null, option_notes: (content?.['option_notes'] as Record<string, string> | undefined) ?? {},
      attachments: (content?.['attachments'] as Answer['attachments'] | undefined) ?? [], marks: (content?.['marks'] as unknown[] | undefined) ?? [], trusted: !!content?.['trusted'],
    }
    let a = card.answers.find(x => x.envelope_hash === hash)
    if (!a) {
      a = { ...fields, bound_version_hash: bound, bound_object_version: card.versions.find(v => v.version_hash === bound)?.object_version ?? card.object_version,
        envelope_number: n, envelope_hash: hash, by_device_id: hex(h.sender), answered_at: o.answeredAt || h.time, taken_back_at: null, taken_back_sent_at: null, pending: false,
        ...(newer ? { unsupported: true as const } : {}), ...(content ? {} : { no_body: true }) }
      insertByNumber(card.answers, a)
    } else if (content && a['no_body']) { Object.assign(a, fields); delete a['no_body'] }
    if (n >= card.state_envelope_number && a.taken_back_at == null) {
      card.state_envelope_number = n
      card.object_state = state === 'open' ? 'answered' : state
      card.answer = a
      card.closed_how = answerClosedHow(card, a)
      card.updated_at = h.time
      if (ordered) card.in_revision = null
    } else if (card.answer === a) card.closed_how = answerClosedHow(card, a)
    touched()
    return { applied: true }
  }
  if (h.kind === 'takeBack') {
    // The bind names the answer taken back; where only the header is left, it was the one in force before.
    const previous = r.bind?.kind === 'takeBack' && r.bind.previousHash ? hex(r.bind.previousHash) : null
    const a = (previous ? card.answers.find(x => x.envelope_hash === previous) : card.answers.findLast(x => (x.envelope_number ?? 0) < n && x.taken_back_at == null)) ?? null
    if (a && a.taken_back_at == null) { a.taken_back_at = n; a.taken_back_sent_at = h.time }
    if (n >= card.state_envelope_number) {
      card.state_envelope_number = n
      if (!card.answer?.pending) card.answer = null
      card.object_state = state
      card.closed_how = null
      card.updated_at = h.time
    }
    touched()
    return { applied: true }
  }
  return { applied: false }
}

/** A Note as the model holds it, from one version: the app's fields beside the core's. */
function noteOf(object_id: string, r: ReceivedEnvelope, hash: string, c: Obj | null, content_state: ContentState, old: Note | null | undefined): Note {
  const h = r.header
  const { schema_version: _sv, object_version: _ov, previous_version_hash: _pv, lamport: _l, ...extra } = c ?? {}
  const kept = c ? {} : Object.fromEntries(Object.entries(old ?? {}).filter(([k]) => !['pending', 'local_id', '_base'].includes(k)))    // a version that cannot be read keeps what was shown
  return { ...kept, ...extra, object_id, by_device_id: hex(h.sender), text: (c?.['text'] as string | undefined) ?? old?.text ?? '',
    object_version: Number.isInteger(c?.['object_version']) ? c!['object_version'] : (old?.object_version ?? 0) + 1, version_hash: hash,
    version_hashes: [...(old?.version_hashes ?? []).filter(x => x !== hash), hash], causal: causalOf(r, c), envelope_number: r.change, object_state: stateAfter(r), pending: false, unsupported: content_state === 'newer_schema' }
}
const causalOf = (r: ReceivedEnvelope, c: Obj | null): Causal => ({ sender_device_id: hex(r.header.sender), sender_sequence: r.header.seq, sent_at: r.header.time, lamport: typeof c?.['lamport'] === 'number' ? c['lamport'] : 0 })

function applyNote(model: Model, r: ReceivedEnvelope, change: Change, hash: string, local_id: string | null): ApplyResult {
  const h = r.header
  const object_id = hex(h.object!.objectId)
  const B = builder(model)
  const cur = model.notes.get(object_id)
  const mine = !!local_id && cur?.pending === true && cur.local_id === local_id       // the hub's copy of the echo in front
  const old = cur?.pending ? cur._base : cur
  const { content, state } = bodyOf(r, 'note')
  // Any human device writes a version on any other; which one is current is the core's word (9.2.1, 9.3.2). Out of
  // order, a version counts where the model holds none, or an older one.
  const current = r.objectAfter ? hex(r.objectAfter.current) === hash : !old || r.change >= (old.envelope_number ?? 0)
  if (local_id) { B.echoes.delete(local_id); B.by_hash.delete(hash) }
  change.notes.add(object_id)
  if (!current) {
    if (old && !old.version_hashes.includes(hash)) old.version_hashes.push(hash)
    if (mine) { if (old) model.notes.set(object_id, old); else model.notes.delete(object_id) }      // the own echo lost: show the winner
    return { applied: false }
  }
  const again = old?.version_hash === hash
  if (again && !content) { if (mine) model.notes.set(object_id, old); return { applied: false } }
  const note = noteOf(object_id, r, hash, content, state, old)
  if (again && !Number.isInteger(content?.['object_version'])) note.object_version = old.object_version      // the same version, now with its body
  if (state === 'newer_schema') noteNewer(model, change, 'note', { envelope_number: r.change })
  // An own newer echo stays in front until its version comes back; it keeps the confirmed note as its base.
  if (cur?.pending && !mine) cur._base = note
  else model.notes.set(object_id, note)
  return { applied: true }
}

function applyRequest(model: Model, r: ReceivedEnvelope, change: Change, hash: string): ApplyResult {
  const h = r.header, o = h.object!, n = r.change
  const object_id = hex(o.objectId)
  let p = model.permissions.get(object_id)
  const touched = () => { change.permissions.add(object_id); if (p?.session_id) change.sessions.add(p.session_id); change.stack = true }
  if (h.kind === 'request') {
    const { content } = bodyOf(r, 'request')
    const bind = r.bind?.kind === 'request' ? r.bind : null
    if (!p) {
      p = { object_id, agent_device_id: hex(r.objectAfter?.owner ?? h.sender), session_id: h.sessionId ? hex(h.sessionId) : null, tool_name: '', description: '', input_preview: '',
        expires_at: 0, version_hash: hash, envelope_number: n, sent_at: h.time, permission_state: stateAfter(r) === 'open' ? 'pending' : 'denied', verdict: null, withdraw_reason: null }
      model.permissions.set(object_id, p)
    } else if (p.version_hash !== hash) return { applied: false }
    if (bind) p.expires_at = bind.expiresAt
    if (content) { p.tool_name = String(content['tool_name'] ?? ''); p.description = String(content['description'] ?? ''); p.input_preview = String(content['input_preview'] ?? '') }
    touched()
    return { applied: true }
  }
  if (h.kind === 'verdict' && p) {
    // The verdict stands in the bind, inside the body: of a pruned one only "closed" is left, shown as not allowed.
    const bind = r.bind?.kind === 'verdict' ? r.bind : null
    if (bind) p.verdict = { allow: bind.allow, by_device_id: hex(h.sender), envelope_number: n }
    p.permission_state = bind?.allow ? 'allowed' : 'denied'
    touched()
    return { applied: true }
  }
  return { applied: false }
}

function applyArtifact(model: Model, r: ReceivedEnvelope, change: Change, hash: string): ApplyResult {
  const h = r.header, o = h.object!, n = r.change
  const object_id = hex(o.objectId)
  const old = model.published.get(object_id)
  const { content, state } = bodyOf(r, 'artifact')
  const first = refHex(o.objectRef) === null
  const newest = !old || n >= old.envelope_number
  if (old && !newest && !(first && old.sent_at !== h.time)) return { applied: false }
  const c = newest ? content : null
  const next: Published = {
    object_id, agent_device_id: r.objectAfter && newest ? hex(r.objectAfter.owner) : old?.agent_device_id ?? hex(h.sender), session_id: old?.session_id ?? (h.sessionId ? hex(h.sessionId) : null),
    attachments: (c?.['attachments'] as Published['attachments'] | undefined) ?? old?.attachments ?? [], title: (c?.['title'] as string | undefined) ?? old?.title ?? '',
    note: c ? (c['note'] as string | undefined) ?? null : old?.note ?? null, released_until: c ? (c['released_until'] as number | undefined) ?? null : old?.released_until ?? null,
    artifact_type: (c?.['artifact_type'] as string | undefined) ?? old?.artifact_type ?? null,
    object_version: !newest ? old!.object_version : old?.version_hash === hash ? old.object_version : Number.isInteger(c?.['object_version']) ? c!['object_version'] as number : (old?.object_version ?? 0) + 1,
    version_hash: newest ? hash : old!.version_hash, envelope_number: newest ? n : old!.envelope_number, sent_at: first ? h.time : old?.sent_at ?? h.time,
    object_state: newest ? stateAfter(r) : old!.object_state, content_state: !newest ? old!.content_state : c ? 'ok' : old?.version_hash === hash ? old.content_state : state,
  }
  model.published.set(object_id, next)
  change.published.add(object_id)
  if (next.session_id) change.sessions.add(next.session_id)
  return { applied: true }
}

// ---- registers (9.3) ------------------------------------------------------------------------------------------------

/** What a human register write carries (an envelope, an own echo, or a stored raw value read back). */
export interface RegisterWrite { envelope_number?: number | null; sender_device_id?: string | null; pending?: boolean; causal?: Causal | null | undefined }

/** Put one room register into model.human: its raw entry, and the map the views read it from. A delete stays in
 *  `raw` as `value: null`. */
export function setHumanRegister(model: Model, key: string, value: unknown, w: RegisterWrite, change: Change): void {
  const h = model.human
  h.raw.set(key, { value: value ?? null, envelope_number: w.envelope_number ?? null, by_device_id: w.sender_device_id ?? null, pending: !!w.pending, causal: w.causal ?? null })
  const slash = key.indexOf('/')
  const prefix = slash < 0 ? key : key.slice(0, slash), id = slash < 0 ? '' : key.slice(slash + 1)
  const put = <V>(map: Map<string, V>, v: unknown) => (v === null || v === undefined ? map.delete(id) : map.set(id, v as V))
  switch (prefix) {
    case 'draft': put(h.drafts, value); change.cards.add(id); break
    case 'snooze': put(h.snoozes, value); change.cards.add(id); change.stack = true; break
    case 'duck': put(h.ducks, value); change.cards.add(id); break
    case 'crown': h.crown = value ?? null; break
    case 'desk': put(h.desks, value); break
    case 'session': {
      put(h.session_settings, value)
      const s = sessionOf(model, id); s.settings = (value as SessionSettings | null | undefined) ?? null; change.sessions.add(id); change.stack = true; break
    }
    case 'scribble_snapshot': put(h.scribble_snapshots, value); change.timelines.add(timelineKey('scribble', id)); break
  }
  change.registers.add(key)
}

/** A device's own register `device/<id>`: its name and where it runs, shown on its member and its sessions. */
function setDeviceRegister(model: Model, device_id: string, value: unknown, change: Change): void {
  const v = isObject(value) ? value : {}
  builder(model).device_registers.set(device_id, v)
  const m = model.members.get(device_id)
  if (m) {
    m.device_name = String(v['device_name'] ?? ''); m.platform = v['platform'] ?? null; m.folder = v['folder'] ?? null; m.host = v['host'] ?? null
    change.members = true
    touchAgent(model, device_id, change)
  }
}

/** A register of a session group: kept raw, and what the views read of it (profile, status lines, the receipt, alerts). */
function setSessionRegister(model: Model, s: Session, key: string, value: any, r: ReceivedEnvelope, causal: Causal, change: Change, ctx: ApplyContext, ordered: boolean): void {
  const h = r.header
  s.registers.set(key, { value: value ?? null, envelope_number: r.change, sender_sequence: h.seq, causal })
  if (key === 'profile') composeProfile(s)
  else if (key === 'heard') {
    // The mark only rises: a receipt is never taken back.
    const up_to = Number.isSafeInteger(value?.up_to) && value.up_to >= 0 ? value.up_to as number : null
    if (up_to != null && up_to >= (s.heard_up_to ?? -1)) { s.heard_up_to = up_to; s.heard_at = stamp(value.at) ?? h.time }
  } else if (key.startsWith('status_line/')) {
    const id = key.slice('status_line/'.length)
    const at = s.status_lines.findIndex(l => l.id === id)
    if (value === null || value === undefined) { if (at >= 0) s.status_lines.splice(at, 1) }
    else {
      const line = { id, label: value.label ?? id, state: value.state ?? null, detail: value.detail ?? null, object_id: value.object_id ?? null, envelope_number: r.change, updated_at: h.time }
      if (at >= 0) s.status_lines[at] = line; else s.status_lines.push(line)
    }
  } else if (key.startsWith('alert/')) {
    const at = s.agent_alerts.findIndex(a => a.key === key)
    if (value === null || value === undefined) { if (at >= 0) s.agent_alerts.splice(at, 1) }
    else {
      const a = { key, value, envelope_number: r.change }
      if (at >= 0) s.agent_alerts[at] = a; else s.agent_alerts.push(a)
      // (told once, when it arrives in the hub's order: not again with every Desk a start fetches)
      if (ordered && at < 0) pushAlert(model, change, { code: value?.code ?? 'agent-alert', message: value?.message ?? '', envelope_number: r.change, sender_device_id: hex(h.sender), source: 'agent', at: ctx.now })
    }
  }
  change.sessions.add(s.session_id)
  change.registers.add(key)
}

function applyRegister(model: Model, r: ReceivedEnvelope, change: Change, ctx: ApplyContext, hash: string, local_id: string | null, ordered: boolean): ApplyResult {
  const h = r.header
  const B = builder(model)
  const d = r.payload != null && r.outcome !== 'chained' ? decodeBody('register', r.payload) : null
  if (local_id) B.by_hash.delete(hash)
  const echo = local_id ? B.echoes.get(local_id) : undefined
  if (!isObject(d)) {       // not readable here: an own echo of it cannot be told from its key, so it is taken back
    if (local_id) rollbackEcho(model, local_id, change)
    return { applied: false }
  }
  const key = d['key'] as string, value = d['value']
  const sender = hex(h.sender)
  const causal: Causal = { sender_device_id: sender, sender_sequence: h.seq, sent_at: h.time, lamport: d['lamport'] as number }
  const current = r.register?.current === true
  const done = () => { if (echo?.kind === 'registers') { echo.open.delete(key); if (!echo.open.size) B.echoes.delete(local_id!) } }
  if (key === 'heads') return { applied: false }       // the chains' heads (9.0.7): the core's own
  if (key.startsWith('device/')) {
    if (current && key === `device/${sender}`) { setDeviceRegister(model, sender, value, change); change.registers.add(key) }
    return { applied: current }
  }
  if (h.sessionId) {
    if (current) setSessionRegister(model, sessionOf(model, hex(h.sessionId)), key, value, r, causal, change, ctx, ordered)
    return { applied: current }
  }
  const write: RegisterWrite = { envelope_number: r.change, sender_device_id: sender, causal }
  if (echo?.kind === 'registers' && echo.open.has(key)) {
    // The hub's copy of an own write: it stands if it is the current value, else what won comes back.
    const before = echo.before.get(key)
    const newer = [...B.echoes.values()].find(e => e !== echo && e.kind === 'registers' && e.open.has(key))
    if (newer?.kind === 'registers') { if (current) newer.before.set(key, { value: value ?? null, envelope_number: r.change, by_device_id: sender, pending: false, causal }) }   // a later own echo stays in front
    else if (current) setHumanRegister(model, key, value, write, change)
    else setHumanRegister(model, key, before?.value ?? null, { envelope_number: before?.envelope_number ?? null, sender_device_id: before?.by_device_id ?? null, causal: before?.causal }, change)
    done()
    return { applied: current }
  }
  if (!current) return { applied: false }
  // Another device's write under an own echo still in flight: the echo stays in front, and falls back to this.
  if (model.human.raw.get(key)?.pending) {
    for (const e of B.echoes.values()) if (e.kind === 'registers' && e.open.has(key)) { e.before.set(key, { value: value ?? null, envelope_number: r.change, by_device_id: sender, pending: false, causal }); return { applied: true } }
  }
  setHumanRegister(model, key, value, write, change)
  return { applied: true }
}

// ---- live messages: a turn's work trail (7.3), a stroke in progress (7.2) ---------------------------------------------

/** End running turns: their last step says so (the views' fold takes the state of the newest step). */
function endTurns(model: Model, which: (turn: Turn) => boolean, at: number, change: Change): void {
  const B = builder(model)
  for (const [id, turn] of B.turns) {
    if (!which(turn)) continue
    B.turns.delete(id)
    const item = model.timelines.get(turn.timeline_key)?.items.get(turn.last)
    const work = (item?.content as { work?: WorkEnvelope } | null)?.work
    if (!item || !work) continue
    item.content = { ...item.content, work: { ...work, state: 'done', ended_at: Math.max(at, turn.started_at) } } as Body
    addItem(change, turn.timeline_key, item)
    change.timelines.add(turn.timeline_key)
  }
}

/**
 * One step of a running turn (core-api.ts ReceivedMessage of kind 'workTrail'), `change_number` the hub's change number of its
 * log entry. It stands in the session's Chat as an item of its own under that number (never counted: it is no
 * stored content), in the form the views fold into one block per turn (work.ts). A turn runs until its agent's
 * final answer arrives, it begins another turn, stops working or goes. False for a step that is not readable.
 */
export function applyWorkTrail(model: Model, session_id: string, trail: Pick<ReceivedMessage, 'from' | 'turn' | 'number' | 'time' | 'payload'>, change_number: number, change: Change): boolean {
  const B = builder(model)
  if (!trail.turn || !trail.from) return false
  const turn_id = hex(trail.turn), sender = hex(trail.from)
  const key = timelineKey('chat', `session/${session_id}`)
  const t = timelineOf(model, key)
  let turn = B.turns.get(turn_id)
  // A turn the model holds steps of but no longer counts as running (it was thought ended): it began with those.
  let started = turn?.started_at ?? trail.time
  if (!turn) for (const it of t.items.values()) { const w = (it.content as { work?: WorkEnvelope } | null)?.work; if (w?.turn === turn_id) started = Math.min(started, w.started_at) }
  const env = stepEnvelope(turn_id, trail.number, trail.time, text(trail.payload), started)
  if (!env) return false
  if (!turn) {
    endTurns(model, x => x.sender === sender && x.timeline_key === key, trail.time, change)
    B.turns.set(turn_id, turn = { timeline_key: key, session_id, sender, started_at: started, last: change_number })
  }
  turn.last = Math.max(turn.last, change_number)
  const item: TimelineItem = { envelope_number: change_number, local_id: null, pending: false, envelope_hash: null, sender_device_id: sender, sender_sequence: null, recipient_device_id: null, sent_at: trail.time,
    item_state: 'loaded', content_type: 'message', content: { content_type: 'message', terminal: 'work', work: env } }
  t.items.set(change_number, item)
  addItem(change, key, item)
  change.timelines.add(key)
  const s = sessionOf(model, session_id)
  s.last_activity_at = Math.max(s.last_activity_at, trail.time)
  change.sessions.add(session_id)
  return true
}

/**
 * The points of a stroke someone is still drawing (core-api.ts ReceivedMessage of kind 'strokePiece'): an item of the board's
 * window under `live:<sender>/<stroke>`, content_type 'stroke_piece', never counted and never stored. Each piece
 * replaces the one before it in the window and is named in change.items, where the open board adds its points up
 * (scribble.ts CanvasState). The finished stroke arrives as a board item that names the stroke and takes its place.
 */
export function applyStrokePiece(model: Model, piece: Pick<ReceivedMessage, 'from' | 'board' | 'payload'>, change: Change, ctx: ApplyContext = { now: Date.now() }): boolean {
  const content = piece.from && piece.board ? decodePiece(text(piece.payload)) : null
  if (!content || !piece.from || !piece.board) return false
  const sender = hex(piece.from)
  const key = timelineKey('scribble', `desk/${hex(piece.board)}`)
  const t = timelineOf(model, key)
  const id = `live:${sender}/${content.stroke}`
  // One stroke at a time per device: a new one means the one before was dropped or is on its way as an item.
  for (const k of [...t.items.keys()]) if (typeof k === 'string' && k !== id && k.startsWith(`live:${sender}/`)) t.items.delete(k)
  const item: TimelineItem = { envelope_number: null, local_id: id, pending: false, envelope_hash: null, sender_device_id: sender, sender_sequence: null, recipient_device_id: null, sent_at: ctx.now,
    item_state: 'loaded', content_type: 'stroke_piece', content: { ...content } }
  t.items.set(id, item)
  addItem(change, key, item)
  change.timelines.add(key)
  return true
}

// ---- optimistic echoes: own sends, shown at once ----------------------------------------------------------------------
//
// The engine calls echo…(…, local_id) before it seals, confirmEcho(local_id, sealed) once the envelope is in the
// outbox (several times for one echo that became several envelopes), and rollbackEcho(local_id) when sealing or the
// hub refused it. When the hub's copy comes back through applyEnvelope, the echo is replaced in place: the item
// under its envelope number with the same local_id, the answer and the register as they counted, the note as the
// version it became. Call project() after each of them.

/** A message or a board item, pending in its timeline's window under its local id. */
export function echoTimelineItem(model: Model, e: { local_id: string; timeline_key: string; content: Fields; recipient_device_id?: string | null; object_id?: string | null; now?: number }, change: Change): TimelineItem {
  const t = timelineOf(model, e.timeline_key)
  const item: TimelineItem = { envelope_number: null, local_id: e.local_id, pending: true, envelope_hash: null, sender_device_id: model.room.my_device_id ?? '', sender_sequence: null,
    recipient_device_id: e.recipient_device_id ?? null, sent_at: e.now ?? Date.now(), item_state: 'loaded', content_type: (e.content['content_type'] as string | undefined) ?? 'message', content: e.content as Body }
  t.items.set(e.local_id, item)
  builder(model).echoes.set(e.local_id, { kind: 'item', timeline_key: e.timeline_key })
  change.timelines.add(e.timeline_key)
  addItem(change, e.timeline_key, item)
  if (e.object_id) change.cards.add(e.object_id)
  return item
}
/** Room registers, each value at once (`pending: true` in human.raw); null deletes. */
export function echoRegisters(model: Model, e: { local_id: string; values: Record<string, unknown> }, change: Change): void {
  const before = new Map<string, HumanRegister | undefined>()
  for (const [key, value] of Object.entries(e.values)) {
    const had = model.human.raw.get(key)
    before.set(key, had?.pending ? pendingBase(model, key) : had)
    setHumanRegister(model, key, value, { envelope_number: null, sender_device_id: model.room.my_device_id, pending: true }, change)
  }
  builder(model).echoes.set(e.local_id, { kind: 'registers', before, open: new Set(before.keys()) })
}
/** What an older echo of the same key would fall back to: the confirmed value under both. */
function pendingBase(model: Model, key: string): HumanRegister | undefined {
  for (const e of builder(model).echoes.values()) if (e.kind === 'registers' && e.open.has(key)) return e.before.get(key)
  return undefined
}
/** An answer as card.answer with `pending: true`, the card in the state the answer leaves it. False without the card. */
export function echoAnswer(model: Model, e: { local_id: string; object_id: string; answer: Omit<Answer, 'pending'>; object_state: ObjectState }, change: Change): boolean {
  const card = model.cards.get(e.object_id)
  if (!card) return false
  builder(model).echoes.set(e.local_id, { kind: 'answer', object_id: e.object_id, state: e.object_state, version_hash: card.version_hash, saved: { answer: card.answer, object_state: card.object_state, closed_how: card.closed_how } })
  card.answer = { ...e.answer, pending: true, local_id: e.local_id } as unknown as Answer
  card.object_state = e.object_state
  if (e.object_state === 'closed' && e.answer.answer_action === 'answer') card.closed_how = 'settled'
  change.cards.add(e.object_id)
  if (card.session_id) change.sessions.add(card.session_id)
  change.stack = true
  return true
}
/** A new note or a new version of one, at once: `pending: true`, the confirmed note kept under it (`_base`). A new
 *  note stands under its local id until confirmEcho gives it its object id. Returns its key in model.notes. */
export function echoNote(model: Model, e: { local_id: string; object_id?: string | null; fields: Fields; closed?: boolean }, change: Change): string {
  const key = e.object_id ?? e.local_id
  const prev = model.notes.get(key)
  const base = prev?.pending ? prev._base ?? null : prev ?? null
  model.notes.set(key, { ...(base ?? {}), ...(prev?.pending ? prev : {}), ...e.fields, object_id: key, local_id: e.local_id, pending: true, _base: base, object_state: e.closed ? 'closed' : 'open', by_device_id: model.room.my_device_id ?? '' } as Note)
  builder(model).echoes.set(e.local_id, { kind: 'note', key })
  change.notes.add(key)
  return key
}
/** The envelope of an echo is sealed: its hash will name the hub's copy; an item learns its number in the sender's
 *  chain (a shape's id needs it), a new note its object id. */
export function confirmEcho(model: Model, local_id: string, sealed: Sealed, change: Change): void {
  const B = builder(model)
  const echo = B.echoes.get(local_id)
  if (!echo) return
  B.by_hash.set(hex(sealed.envelopeHash), local_id)
  if (echo.kind === 'item') {
    const item = model.timelines.get(echo.timeline_key)?.items.get(local_id)
    if (item) { item.sender_sequence = sealed.seq; item.envelope_hash = hex(sealed.envelopeHash); addItem(change, echo.timeline_key, item); change.timelines.add(echo.timeline_key) }
  } else if (echo.kind === 'note' && sealed.objectId) {
    const id = hex(sealed.objectId)
    const note = model.notes.get(echo.key)
    if (note && echo.key !== id) {
      model.notes.delete(echo.key)
      model.notes.set(id, { ...note, object_id: id })
      change.notes.add(echo.key); change.notes.add(id)
      echo.key = id
    }
  }
}
/** Take an echo back (sealing failed, the hub refused it, its void record came): what it showed is as it was before. */
export function rollbackEcho(model: Model, local_id: string, change: Change): void {
  const B = builder(model)
  const echo = B.echoes.get(local_id)
  if (!echo) return
  B.echoes.delete(local_id)
  for (const [hash, id] of B.by_hash) if (id === local_id) B.by_hash.delete(hash)
  if (echo.kind === 'item') {
    if (model.timelines.get(echo.timeline_key)?.items.delete(local_id)) change.timelines.add(echo.timeline_key)
  } else if (echo.kind === 'registers') {
    for (const key of echo.open) {
      const old = echo.before.get(key)
      setHumanRegister(model, key, old?.value ?? null, { envelope_number: old?.envelope_number ?? null, sender_device_id: old?.by_device_id ?? null, causal: old?.causal }, change)
    }
  } else if (echo.kind === 'answer') {
    // Only what the echo itself set; a newer state that arrived meanwhile (the agent closed or revised the card) stays.
    const card = model.cards.get(echo.object_id)
    if (!card) return
    if (card.answer?.['local_id'] === local_id) card.answer = echo.saved.answer
    if (card.object_state === echo.state && card.version_hash === echo.version_hash && card.answer === echo.saved.answer) { card.object_state = echo.saved.object_state; card.closed_how = echo.saved.closed_how }
    change.cards.add(card.object_id)
    if (card.session_id) change.sessions.add(card.session_id)
    change.stack = true
  } else {
    const cur = model.notes.get(echo.key)
    if (cur?.pending && cur.local_id === local_id) { if (cur._base) model.notes.set(echo.key, cur._base); else model.notes.delete(echo.key); change.notes.add(echo.key) }
  }
}

// ---- projections ----------------------------------------------------------------------------

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const stackKey = (c: Card): StackKey => [URGENCY_RANK[c.urgency] ?? 1, c.created_at, c.agent_device_id ?? '', c.object_id]
const cmpKey = (x: StackKey, y: StackKey) => (y[0] - x[0]) || (x[1] - y[1]) || cmpStr(x[2], y[2]) || cmpStr(x[3], y[3])
function bisect(arr: string[], key: StackKey, keyOf: (id: string) => StackKey): number { let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (cmpKey(keyOf(arr[mid]!), key) < 0) lo = mid + 1; else hi = mid } return lo }
const byCreated = (model: Model) => (a: string, b: string) => (model.cards.get(a)?.created_at ?? 0) - (model.cards.get(b)?.created_at ?? 0) || cmpStr(a, b)

/**
 * Stack, per-session card lists, open permissions. Incremental: the open cards are kept sorted (with each card's
 * sort key), and only the cards and sessions a change touched are looked at; the first call after a bulk load, and
 * after a card was filed, builds the lists once. The stack then filters snoozed cards and archived sessions out of
 * the sorted list (no sorting), and only when a change names a card, a session, a snooze or a session register, or
 * the clock passed the end of a snooze: a chat message, a stroke or a status line costs nothing here. A pending
 * permission request whose time has run out becomes 'expired'.
 */
export function project(model: Model, change: Change, now: number = Date.now()): void {
  const before = model.stack, beforePerm = model.open_permission_ids
  const B = builder(model)
  let P = B.proj
  if (!P) {
    const p: Projection = B.proj = { keys: new Map(), sorted: [], nextPermExpiry: Infinity, stackDirty: true, nextWake: Infinity, permsDirty: true }
    P = p
    for (const s of model.sessions.values()) { s.card_ids.sort(byCreated(model)); s.open_card_ids = s.card_ids.filter(id => model.cards.get(id)?.object_state === 'open') }
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
    const pending: PermissionRequest[] = []
    for (const p of model.permissions.values()) {
      if (p.permission_state !== 'pending') continue
      if (p.expires_at && now > p.expires_at) { p.permission_state = 'expired'; change.permissions.add(p.object_id); if (p.session_id) change.sessions.add(p.session_id) }
      else pending.push(p)
    }
    P.nextPermExpiry = Math.min(Infinity, ...pending.filter(p => p.expires_at).map(p => p.expires_at))
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

// ---- the app's local cache: records <-> model (README "Incremental persistence") ------------------------------------
//
// One record per card, session, permission request, note, Artifact, room register and timeline (its counters), one
// per timeline item, and four small ones (room, members, device registers, alerts). Every value is plain JSON-able
// data. cacheRecords gives exactly the records a change names, for one Cache.setMany; modelFromCache builds the
// model a warm start shows before the hub answers. Timeline items are not read back into the model: their windows
// are read on demand (cacheItemKey, a range over `tl/<timeline_key>/`). Not cached: invites and the outbox (the
// engine's), pending echoes, live strokes, the projections.

const pad = (n: number): string => String(n).padStart(12, '0')
/** The cache key of a timeline item: ordered by envelope number within its timeline. */
export const cacheItemKey = (timeline_key: string, envelope_number: number): string => `tl/${timeline_key}/${pad(envelope_number)}`
/** A card at rest, without what it holds twice: the newest version's content is the card's own fields again, and
 *  `answer` is the last of `answers`. expandCard gives the same card back. */
const AT_REST = '$card'
export function compactCard(c: Card): Record<string, unknown> {
  let out: Record<string, unknown> = c
  const lv = c.versions.at(-1)
  if (lv?.content && typeof lv.content === 'object') {
    const own: string[] = [], rest: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(lv.content)) { if (k in c && JSON.stringify(c[k]) === JSON.stringify(v)) own.push(k); else rest[k] = v }
    if (own.length) out = { ...c, versions: [...c.versions.slice(0, -1), { ...lv, content: { [AT_REST]: own, rest, keys: Object.keys(lv.content) } }] }
  }
  if (c.answer && !c.answer.pending && c.answers.at(-1) === c.answer) out = { ...out, answer: AT_REST }
  else if (c.answer?.pending) out = { ...out, answer: null }
  return out
}
export function expandCard(stored: unknown): Card {
  const v = structuredClone(stored) as Obj
  const lv = v['versions']?.at(-1)
  if (lv?.content?.[AT_REST]) {
    const { [AT_REST]: own, rest, keys } = lv.content
    const content: Record<string, unknown> = {}
    for (const k of keys as string[]) content[k] = own.includes(k) ? v[k] : rest[k]
    lv.content = content
  }
  if (v['answer'] === AT_REST) v['answer'] = v['answers']?.at(-1) ?? null
  return v as Card
}
const storedTimeline = (t: Timeline): Record<string, unknown> => { const { items: _items, ...rest } = t; return { ...rest, loaded_down_to: null, window_open: false } }
const storedNote = (n: Note): Note | undefined => { const kept = n.pending ? n._base ?? undefined : n; if (!kept) return undefined; const { _base: _b, ...rest } = kept; return rest as Note }
const ROOM_KEPT = ['room_id', 'hub_url', 'my_device_id', 'my_role', 'key_epoch', 'last_envelope_number'] as const

/** The records a change names, as entries for one Cache.setMany (undefined deletes). */
export function cacheRecords(model: Model, change: Change): [key: string, value: unknown | undefined][] {
  const out = new Map<string, unknown>()
  for (const id of change.cards) { const c = model.cards.get(id); out.set(`card/${id}`, c ? compactCard(c) : undefined) }
  for (const id of change.sessions) { const s = model.sessions.get(id); out.set(`session/${id}`, s ? { ...s, registers: [...s.registers] } : undefined) }
  for (const id of change.permissions) out.set(`perm/${id}`, model.permissions.get(id))
  for (const id of change.notes) { const n = model.notes.get(id); out.set(`note/${id}`, n ? storedNote(n) : undefined) }
  for (const id of change.published) out.set(`pub/${id}`, model.published.get(id))
  for (const key of change.timelines) { const t = model.timelines.get(key); if (t) out.set(`tlmeta/${key}`, storedTimeline(t)) }
  for (const key of change.registers) {
    const raw = model.human.raw.get(key)
    if (raw && !raw.pending) out.set(`reg/${key}`, raw)
    else if (key.startsWith('device/')) out.set('devregs', [...builder(model).device_registers])
  }
  for (const [key, items] of change.items) for (const it of items) if (it.envelope_number != null && !it.pending) out.set(cacheItemKey(key, it.envelope_number), it)
  if (change.members) { out.set('members', [...model.members.values()]); out.set('devregs', [...builder(model).device_registers]) }
  if (change.room) { out.set('room', Object.fromEntries(ROOM_KEPT.map(k => [k, model.room[k]]))); out.set('newer', model.newer) }
  if (change.alerts) out.set('alerts', model.alerts)
  return [...out]
}
/** Every record of a model (a first write, or a rewrite after the model was built anew). */
export function cacheAll(model: Model): [key: string, value: unknown | undefined][] {
  const all = emptyChange()
  for (const id of model.cards.keys()) all.cards.add(id)
  for (const id of model.sessions.keys()) all.sessions.add(id)
  for (const id of model.permissions.keys()) all.permissions.add(id)
  for (const id of model.notes.keys()) all.notes.add(id)
  for (const id of model.published.keys()) all.published.add(id)
  for (const key of model.timelines.keys()) all.timelines.add(key)
  for (const key of model.human.raw.keys()) all.registers.add(key)
  all.members = all.room = all.alerts = true
  return cacheRecords(model, all)
}
/** The model a cache holds (entries as Cache.range gives them; values as they came back from JSON or IndexedDB).
 *  Timeline windows are empty and nothing is connected; call project() on it. */
export function modelFromCache(entries: Iterable<readonly [string, unknown]>): Model {
  const m = emptyModel()
  const B = builder(m)
  const quiet = emptyChange()
  const registers: [string, HumanRegister][] = []
  for (const [key, raw] of entries) {
    if (raw === undefined || raw === null) continue
    const at = key.indexOf('/'), kind = at < 0 ? key : key.slice(0, at), id = key.slice(at + 1)
    const v = raw as Obj
    switch (kind) {
      case 'card': m.cards.set(id, expandCard(v)); break
      case 'session': { const s = structuredClone(v); m.sessions.set(id, { ...s, registers: new Map(s['registers'] ?? []) } as Session); break }
      case 'perm': m.permissions.set(id, structuredClone(v) as PermissionRequest); break
      case 'note': m.notes.set(id, structuredClone(v) as Note); break
      case 'pub': m.published.set(id, structuredClone(v) as Published); break
      case 'tlmeta': m.timelines.set(id, { ...structuredClone(v), items: new Map(), loaded_down_to: Infinity, window_open: false } as Timeline); break
      case 'reg': registers.push([id, structuredClone(v) as HumanRegister]); break
      case 'members': for (const x of v as Member[]) m.members.set(x.device_id, { ...x }); break
      case 'devregs': for (const [device, value] of v as [string, Obj][]) B.device_registers.set(device, value); break
      case 'room': Object.assign(m.room, v); break
      case 'newer': m.newer = structuredClone(v) as Model['newer']; break
      case 'alerts': m.alerts = structuredClone(v) as Alert[]; break
    }
  }
  // (after the sessions: a session's settings are its register's value, the same object)
  for (const [key, r] of registers) setHumanRegister(m, key, r.value, { envelope_number: r.envelope_number, sender_device_id: r.by_device_id, causal: r.causal }, quiet)
  return m
}
