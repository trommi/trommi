// model.mjs: the board model and its reducer (client/core/README.md "The model" is the contract).
// Pure JavaScript: no crypto, no I/O. The sync engine hands in verified, decoded records in hub order;
// every client (human or agent) applies the same rules and so arrives at the same board.
import { OBJECT_STATE_NAME, URGENCY_NAME, URGENCY, KIND, CARD_CONTENT_FIELDS } from './codec.mjs'

export const ALERTS_MAX = 200
const URGENCY_RANK = { critical: 3, high: 2, normal: 1, low: 0 }
const isZeroHash = h => /^0*$/.test(h)

/**
 * R2: the one order of writes to a register or memo, the same on every device whatever the hub's delivery order (a
 * total order, so the winner does not depend on the order of comparisons): (lamport, sent_at, sender_device_id,
 * sender_sequence). `lamport` is signed inside the body: the writer's counter, one above every lamport it had seen,
 * so a write made after seeing another always sorts after it. Writes without one (older clients) count as lamport 0.
 * causal = { sender_device_id, sender_sequence, sent_at, lamport }.
 */
export function compareWrites(x, y) {
  return ((x.lamport ?? 0) - (y.lamport ?? 0)) || (x.sender_device_id === y.sender_device_id ? x.sender_sequence - y.sender_sequence : 0) ||
    (x.sent_at - y.sent_at) || (x.sender_device_id < y.sender_device_id ? -1 : x.sender_device_id > y.sender_device_id ? 1 : 0) || (x.sender_sequence - y.sender_sequence)
}
/** Does write X win over write Y (compareWrites)? */
export function causallyAfter(x, y) {
  if (!y) return true
  if (!x) return false
  return compareWrites(x, y) > 0
}
/** A body's lamport, if it is a sane integer. */
export const lamportOf = c => (Number.isSafeInteger(c?.lamport) && c.lamport > 0 ? c.lamport : 0)

export function emptyModel() {
  return {
    room: { room_id: null, hub_url: null, my_device_id: null, my_role: null, key_epoch: 0, last_entry_number: -1, last_envelope_number: 0, connection: 'offline', agent_session_id: null, has_passphrase: null, outbox_blocked: null },
    members: new Map(), sessions: new Map(), cards: new Map(), permissions: new Map(), memos: new Map(), published: new Map(),
    timelines: new Map(), human: emptyHuman(), invites: new Map(), alerts: [], outbox: [],
    stack: [], open_permission_ids: [],
  }
}
function emptyHuman() {
  return { drafts: new Map(), snoozes: new Map(), ducks: new Map(), crown: null, desks: new Map(), session_settings: new Map(), read_up_to: new Map(), canvas_snapshots: new Map(), raw: new Map() }
}

/** A change record: what a batch touched. Every field always present. */
export function emptyChange() {
  return { cards: new Set(), sessions: new Set(), permissions: new Set(), memos: new Set(), published: new Set(), timelines: new Set(), registers: new Set(),
    members: false, invites: new Set(), alerts: false, outbox: false, stack: false, room: false, items: new Map() }
}
/** change.items: Map<timeline_key, TimelineItem[]> added or replaced in this batch. */
export function addItem(change, key, item) { let l = change.items.get(key); if (!l) change.items.set(key, l = []); l.push(item) }
export function changeIsEmpty(c) {
  return c.items.size === 0 && !c.members && !c.alerts && !c.outbox && !c.stack && !c.room && ['cards', 'sessions', 'permissions', 'memos', 'published', 'timelines', 'registers', 'invites'].every(k => c[k].size === 0)
}
export function mergeChange(into, c) {
  for (const k of ['cards', 'sessions', 'permissions', 'memos', 'published', 'timelines', 'registers', 'invites']) for (const v of c[k]) into[k].add(v)
  for (const k of ['members', 'alerts', 'outbox', 'stack', 'room']) into[k] ||= c[k]
  for (const [k, l] of c.items) for (const it of l) addItem(into, k, it)
  return into
}

export const timelineKey = (timeline_kind, timeline_id) => `${timeline_kind}:${timeline_id}`
export function parseTimelineKey(key) {
  const at = key.indexOf(':')
  const timeline_kind = key.slice(0, at), timeline_id = key.slice(at + 1)
  const slash = timeline_id.indexOf('/')
  return { timeline_kind, timeline_id, scope: timeline_id.slice(0, slash), scope_id: timeline_id.slice(slash + 1) }
}

// ---- members and sessions -------------------------------------------------------------

/** Rebuild model.members from a verified member-list state (zcrypto state) plus what GET devices said. */
export function applyMembers(model, members, change) {
  const seen = new Set()
  for (const m of members) {
    seen.add(m.device_id)
    const old = model.members.get(m.device_id)
    const reg = model._device_registers?.get(m.device_id) ?? null
    const next = { device_id: m.device_id, device_role: m.device_role, fingerprint: m.device_id.slice(0, 16).match(/.{4}/g).join(' '), device_name: reg?.device_name ?? old?.device_name ?? '', platform: reg?.platform ?? null, folder: reg?.folder ?? null, host: reg?.host ?? null,
      is_active: m.is_active, added_entry_number: m.added_entry_number, removed_entry_number: m.removed_entry_number, is_me: m.device_id === model.room.my_device_id,
      is_online: old?.is_online ?? false, agent_session_id: old?.agent_session_id ?? null }
    model.members.set(m.device_id, next)
    if (m.device_role === 'agent') touchAgent(model, m.device_id, change)
  }
  change.members = true
}
export function applyDevices(model, devices, change) {
  for (const d of devices) {
    const m = model.members.get(d.device_id)
    if (!m) continue
    m.is_online = !!d.is_online
    if (d.agent_session_id) m.agent_session_id = d.agent_session_id
    if (m.device_role === 'agent') touchAgent(model, d.device_id, change)
  }
  change.members = true
}

/** A session (R6): its own key, its agents (assigned by grants), its cards and chat. Keyed by session_id. */
export function sessionOf(model, session_id) {
  let s = model.sessions.get(session_id)
  if (!s) {
    s = { session_id, agent_device_ids: [], ever_agent_ids: [], agent_device_id: null, agent_session_id: null, device_name: '', is_active: true, is_online: false,
      session_key_epoch: 0, with_history: false, profile: null, status_lines: [], agent_alerts: [], registers: new Map(),
      settings: null, read_up_to: 0, card_ids: [], open_card_ids: [], timeline_key: timelineKey('chat', `session/${session_id}`), unread_count: 0, unread_numbers: [], last_activity_at: 0 }
    model.sessions.set(session_id, s)
  }
  return s
}
/** Copy the current agent's member facts onto its session. */
function syncSessionAgent(model, s) {
  const m = s.agent_device_id ? model.members.get(s.agent_device_id) : null
  if (m) { s.agent_session_id = m.agent_session_id ?? m.device_id.slice(0, 16); s.device_name = m.device_name; s.is_active = m.is_active; s.is_online = m.is_online }
}
function touchAgent(model, agent_device_id, change) {
  for (const s of model.sessions.values()) if (s.agent_device_ids.includes(agent_device_id) || s.agent_device_id === agent_device_id) { syncSessionAgent(model, s); change.sessions.add(s.session_id) }
}
/** A verified grant chain state (crypto/session-grants.mjs) for one session. */
export function applySessionGrant(model, sessionState, change, everAgentIds = []) {
  const s = sessionOf(model, sessionState.sessionId)
  s.agent_device_ids = [...sessionState.agentIds]
  for (const a of everAgentIds) if (!s.ever_agent_ids.includes(a)) s.ever_agent_ids.push(a)
  for (const a of s.agent_device_ids) if (!s.ever_agent_ids.includes(a)) s.ever_agent_ids.push(a)
  s.agent_device_id = s.agent_device_ids[0] ?? s.agent_device_id
  s.session_key_epoch = sessionState.epoch
  s.with_history = !!sessionState.withHistory
  syncSessionAgent(model, s)
  change.sessions.add(s.session_id)
  change.stack = true
  return s
}
const everAgent = (model, sid, device) => !!sid && (model.sessions.get(sid)?.ever_agent_ids.includes(device) ?? false)

// ---- alerts ---------------------------------------------------------------------------------

let alertSeq = 0
export function pushAlert(model, change, { code, message = '', envelope_number = null, sender_device_id = null, source = 'local' }) {
  if (globalThis.process?.env?.CORE_DEBUG) console.error('[alert]', code, message, new Error().stack.split('\n').slice(2, 5).join(' | '))
  const alert = { alert_id: `${Date.now().toString(36)}-${(alertSeq++).toString(36)}`, code, message, envelope_number, sender_device_id, at: Date.now(), source }
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
export function applyRecord(model, rec, change) {
  if (rec.session_id) {
    const s = sessionOf(model, rec.session_id)
    s.last_activity_at = Math.max(s.last_activity_at, rec.sent_at)
    change.sessions.add(rec.session_id)
  }
  switch (rec.kind) {
    case KIND.timeline_item: return applyTimelineItem(model, rec, change)
    case KIND.object_version: return applyObjectVersion(model, rec, change)
    case KIND.answer: return applyAnswer(model, rec, change)
    case KIND.permission_request: return applyPermissionRequest(model, rec, change)
    case KIND.verdict: return applyVerdict(model, rec, change)
    case KIND.status: return applyStatus(model, rec, change)
    case KIND.decide_again: return applyDecideAgain(model, rec, change)
    default: return { applied: false, refused: 'unknown-kind' }
  }
}

const refuse = (model, change, rec, code, message) => {
  pushAlert(model, change, { code, message, envelope_number: rec.envelope_number, sender_device_id: rec.sender_device_id })
  return { applied: false, refused: code }
}

// ---- timelines -------------------------------------------------------------------------------

export function timelineOf(model, key) {
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
export function itemFromRecord(rec) {
  return {
    envelope_number: rec.envelope_number, local_id: rec.local_id ?? null, pending: false, envelope_hash: rec.envelope_hash, sender_device_id: rec.sender_device_id, sender_sequence: rec.sender_sequence ?? null,
    recipient_device_id: rec.recipient_device_id, sent_at: rec.sent_at,
    item_state: rec.content ? (rec.content_state === 'ok' ? 'loaded' : rec.content_state) : rec.content_state === 'pruned' ? 'pruned' : rec.content_state === 'undecryptable' ? 'undecryptable' : 'header',
    content_type: rec.content?.content_type ?? null, content: rec.content ?? null,
  }
}

/** R1: who may write into which timeline. Returns null if allowed, else a refusal code. */
export function timelineRefusal(model, rec) {
  const p = parseTimelineKey(timelineKey(rec.timeline_kind, rec.timeline_id))
  const human = rec.sender_role === 'human'
  if (p.timeline_kind === 'chat') {
    if (p.scope === 'session') {
      if (rec.session_id && rec.session_id !== p.scope_id) return 'not-allowed'
      return everAgent(model, p.scope_id, rec.sender_device_id) || (human && everAgent(model, p.scope_id, rec.recipient_device_id)) ? null : 'not-allowed'
    }
    if (p.scope === 'card') {
      const card = model.cards.get(p.scope_id)
      if (!card) return 'card-mismatch'
      return rec.sender_device_id === card.agent_device_id || (human && rec.recipient_device_id === card.agent_device_id) ? null : 'not-allowed'
    }
    return 'not-allowed'
  }
  if (p.timeline_kind === 'canvas') {
    if (p.scope === 'desk') return human ? null : 'not-allowed'
    if (p.scope === 'session') return human || everAgent(model, p.scope_id, rec.sender_device_id) ? null : 'not-allowed'
    if (p.scope === 'card') return human || rec.sender_device_id === model.cards.get(p.scope_id)?.agent_device_id ? null : 'not-allowed'
    return 'not-allowed'
  }
  return null   // a timeline kind this client does not know yet: count it, show nothing
}

function applyTimelineItem(model, rec, change) {
  const why = timelineRefusal(model, rec)
  if (why) return refuse(model, change, rec, why, `not allowed in ${rec.timeline_id}`)
  const key = timelineKey(rec.timeline_kind, rec.timeline_id)
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
  if (p.timeline_kind === 'chat' && rec.sender_role === 'agent' && rec.session_id) {
    const s = sessionOf(model, rec.session_id)
    if (rec.envelope_number > s.read_up_to) { s.unread_numbers.push(rec.envelope_number); s.unread_count = s.unread_numbers.length }
  }
  if (p.timeline_kind === 'chat' && p.scope === 'card') {
    const card = model.cards.get(p.scope_id)
    if (card) {
      const c = rec.content
      // README: in revision until the agent's next version or a message with present_card (the agent presents it again,
      // or a human takes the hand-back back).
      if (c?.present_card) card.in_revision = null
      else if (rec.sender_role === 'human' && c && (c.hand_back || c.explain)) card.in_revision = { by: c.hand_back ? 'hand_back' : 'explain', envelope_number: rec.envelope_number }
      change.cards.add(card.object_id)
      if (card.session_id) change.sessions.add(card.session_id)
    }
  } else if (p.scope === 'session') change.sessions.add(p.scope_id)
  return { applied: true }
}

// ---- objects -------------------------------------------------------------------------------

function newCard(object_id, agent_device_id, rec) {
  return {
    object_id, agent_device_id, object_state: 'open', urgency: 'normal', card_type: 'decision', title: '', body: null, options: [], sections: null, html: null,
    allows_multiple: false, recommended: null, urgency_reason: null, attachments: [], change_note: null, close_summary: null, withdraw_reason: null,
    merged_into_object_id: null, merged_from_object_ids: null, object_version: 0, version_hash: null, envelope_number: rec.envelope_number,
    first_envelope_number: rec.envelope_number, created_at: rec.sent_at, session_id: rec.session_id ?? null, updated_at: rec.sent_at, versions: [], answer: null, answers: [], closed_how: null,
    in_revision: null, timeline_key: timelineKey('chat', `card/${object_id}`), content_state: 'ok',
  }
}
const stateOf = rec => ({ object_state: OBJECT_STATE_NAME[rec.object?.object_state] ?? 'open', urgency: URGENCY_NAME[rec.object?.urgency] ?? 'normal' })

function applyObjectVersion(model, rec, change) {
  const object_id = rec.object?.object_id
  if (!object_id) return refuse(model, change, rec, 'bad-object', 'object version without object id')
  const c = rec.content
  const type = c?.object_type ?? (model.memos.has(object_id) || rec.sender_role === 'human' ? 'memo' : model.published.has(object_id) ? 'published' : 'card')
  if (!c && rec.content_state === 'undecryptable' && model.room.my_role === 'agent' && rec.sender_role === 'human') return { applied: false }   // room scope: not for agents
  if (type === 'memo') return applyMemo(model, rec, change)
  if (type === 'published') return applyPublished(model, rec, change)
  if (type !== 'card') return refuse(model, change, rec, 'unknown-object-type', `object_type ${type}`)
  let card = model.cards.get(object_id)
  if (rec.sender_role !== 'agent') return refuse(model, change, rec, 'not-creator', 'cards come from agents')
  const fresh = !card
  if (card && card.agent_device_id !== rec.sender_device_id) return refuse(model, change, rec, 'not-creator', 'a card version from someone else than its creator')
  if (rec.session_id && !everAgent(model, rec.session_id, rec.sender_device_id)) return refuse(model, change, rec, 'not-allowed', 'a card in a session this agent was never assigned to')
  if (card && card.session_id !== (rec.session_id ?? null)) return refuse(model, change, rec, 'not-allowed', 'a card version in another session')
  if (fresh && rec.object_id_ok === false) return refuse(model, change, rec, 'bad-object-id', 'object id is not H(creator, sequence of version 1)')
  if (c) {
    const expected = (card?.object_version ?? 0) + 1
    if (c.object_version !== expected) return refuse(model, change, rec, 'bad-version', `card version ${c.object_version}, expected ${expected}`)
    if (expected > 1 && c.previous_version_hash !== card.version_hash) return refuse(model, change, rec, 'bad-version', 'previous_version_hash does not name the current version')
    if (expected === 1 && c.previous_version_hash && !isZeroHash(c.previous_version_hash)) return refuse(model, change, rec, 'bad-version', 'version 1 names a predecessor')
  }
  if (fresh) {
    card = newCard(object_id, rec.sender_device_id, rec)
    model.cards.set(object_id, card)
    if (rec.session_id) sessionOf(model, rec.session_id).card_ids.push(object_id)
  }
  const st = stateOf(rec)
  const wasOpen = card.object_state === 'open'
  card.object_state = st.object_state
  card.urgency = st.urgency
  card.envelope_number = rec.envelope_number
  card.updated_at = rec.sent_at
  card.version_hash = rec.envelope_hash
  if (c && rec.content_state === 'ok') {
    for (const f of CARD_CONTENT_FIELDS) card[f] = c[f] ?? defaultOf(f)
    card.object_version = c.object_version
    card.content_state = 'ok'
  } else {
    card.object_version = (card.object_version ?? 0) + 1
    card.content_state = rec.content_state
  }
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
function defaultOf(f) {
  if (f === 'options' || f === 'attachments') return []
  if (f === 'allows_multiple') return false
  if (f === 'card_type') return 'decision'
  if (f === 'title') return ''
  return null
}

function applyMemo(model, rec, change) {
  const object_id = rec.object.object_id
  if (rec.sender_role !== 'human') return refuse(model, change, rec, 'not-creator', 'memos come from human devices')
  const c = rec.content ?? {}
  const cur = model.memos.get(object_id)
  const old = cur?.pending ? cur._base : cur          // an own optimistic echo is not a version
  if (!old && rec.object_id_ok === false) return refuse(model, change, rec, 'bad-object-id', 'object id is not H(creator, sequence of version 1)')
  // Any human device may write a version; two versions naming the same predecessor are settled by causal order (R2).
  if (old && rec.content && !old.version_hashes.includes(c.previous_version_hash)) return refuse(model, change, rec, 'bad-version', 'memo previous_version_hash names no known version')
  if (old && !causallyAfter(rec.causal, old.causal)) {
    old.version_hashes.push(rec.envelope_hash)
    // Our own echo lost to a concurrent version: show the winner.
    if (cur?.pending && rec.local_id && rec.local_id === cur.local_id) { model.memos.set(object_id, old); change.memos.add(object_id) }
    return { applied: false }
  }
  // Our own newer echo stays in front until its version comes back; it keeps the confirmed memo as its base.
  if (cur?.pending && rec.local_id !== cur.local_id) {
    cur._base = { ...memoOf(object_id, rec, c, old) }
    change.memos.add(object_id)
    return { applied: true }
  }
  model.memos.set(object_id, memoOf(object_id, rec, c, old))
  change.memos.add(object_id)
  return { applied: true }
}
function memoOf(object_id, rec, c, old) {
  const { schema_version: _sv, object_type: _ot, object_version: _ov, previous_version_hash: _pv, lamport: _l, ...extra } = c
  return { ...extra, object_id, by_device_id: rec.sender_device_id, text: c.text ?? old?.text ?? '', x: c.x ?? old?.x ?? 0, y: c.y ?? old?.y ?? 0, color: c.color ?? old?.color ?? null,
    desk_id: c.desk_id ?? old?.desk_id ?? null, object_version: c.object_version ?? (old?.object_version ?? 0) + 1, version_hash: rec.envelope_hash,
    version_hashes: [...(old?.version_hashes ?? []), rec.envelope_hash], causal: rec.causal, envelope_number: rec.envelope_number, object_state: stateOf(rec).object_state, pending: false }
}

function applyPublished(model, rec, change) {
  const object_id = rec.object.object_id
  const old = model.published.get(object_id)
  if (old && old.agent_device_id !== rec.sender_device_id) return refuse(model, change, rec, 'not-creator', 'a published object from someone else than its creator')
  if (!old && rec.object_id_ok === false) return refuse(model, change, rec, 'bad-object-id', 'object id is not H(creator, sequence of version 1)')
  const c = rec.content ?? {}
  const expected = (old?.object_version ?? 0) + 1
  if (rec.content && c.object_version !== expected) return refuse(model, change, rec, 'bad-version', `published version ${c.object_version}, expected ${expected}`)
  // N4: a later version names its predecessor (as cards do).
  if (rec.content && old && c.previous_version_hash && c.previous_version_hash !== old.version_hash) return refuse(model, change, rec, 'bad-version', 'previous_version_hash does not name the current version')
  model.published.set(object_id, { object_id, agent_device_id: rec.sender_device_id, session_id: rec.session_id ?? old?.session_id ?? null, attachments: c.attachments ?? old?.attachments ?? [], title: c.title ?? old?.title ?? '',
    note: c.note ?? null, released_until: c.released_until ?? null, object_version: expected, version_hash: rec.envelope_hash, envelope_number: rec.envelope_number, object_state: stateOf(rec).object_state })
  change.published.add(object_id)
  if (rec.session_id) change.sessions.add(rec.session_id)
  return { applied: true }
}

// ---- answers --------------------------------------------------------------------------------

/**
 * Whether an answer counts. The same rule on every client; the agent's authoriseCommand checks the same and more.
 * Returns null if it counts, else a refusal code.
 */
export function answerRefusal(model, rec) {
  const card = model.cards.get(rec.object?.object_id)
  if (rec.sender_role !== 'human') return 'not-human'
  if (!card) return 'card-mismatch'
  if (rec.recipient_device_id !== card.agent_device_id) return 'not-for-owner'
  const b = rec.bind
  if (!b || b.cardId !== card.object_id) return 'card-mismatch'
  if (card.object_state !== 'open') return 'card-closed'
  if ((b.versionHash ?? b.cardHash) !== card.version_hash) return 'answer-stale'
  const c = rec.content
  if (!c) return null   // pruned: the hub kept the header only; it counted when it was sent
  if (!['answer', 'read', 'shred'].includes(c.answer_action)) return 'bad-answer'
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
  }
  if (c.answer_action === 'read' && card.card_type !== 'info') return 'bad-answer'
  return null
}

function applyAnswer(model, rec, change) {
  const why = answerRefusal(model, rec)
  if (why) return refuse(model, change, rec, why, 'answer not counted')
  const card = model.cards.get(rec.object.object_id)
  const c = rec.content ?? {}
  const answer = {
    answer_action: c.answer_action ?? 'answer', choices: c.choices ?? [], note: c.note ?? null, option_notes: c.option_notes ?? {}, attachments: c.attachments ?? [],
    marks: c.marks ?? [], trusted: !!c.trusted, bound_version_hash: rec.bind.cardHash, bound_object_version: card.object_version,
    envelope_number: rec.envelope_number, envelope_hash: rec.envelope_hash, by_device_id: rec.sender_device_id, answered_at: rec.object.answered_at || rec.sent_at,
    taken_back_at: null, pending: false,
  }
  card.answer = answer
  card.answers.push(answer)
  const st = stateOf(rec)
  card.object_state = st.object_state === 'open' ? 'answered' : st.object_state
  card.closed_how = answer.answer_action === 'read' ? 'read' : answer.answer_action === 'shred' ? 'shredded' : 'answered'
  card.in_revision = null
  card.updated_at = rec.sent_at
  change.cards.add(card.object_id)
  card.session_id && change.sessions.add(card.session_id)
  change.stack = true
  return { applied: true }
}

export function decideAgainRefusal(model, rec) {
  const card = model.cards.get(rec.object?.object_id)
  if (rec.sender_role !== 'human') return 'not-human'
  if (!card) return 'card-mismatch'
  if (rec.recipient_device_id !== card.agent_device_id) return 'not-for-owner'
  if (!rec.bind || rec.bind.cardId !== card.object_id) return 'card-mismatch'
  if (!card.answer || card.answer.envelope_hash !== rec.bind.previousHash) return 'decision-mismatch'
  if (rec.bind.versionHash && rec.bind.versionHash !== card.version_hash) return 'card-changed'
  if (card.object_state === 'closed' && card.closed_how !== 'read' && card.closed_how !== 'shredded') return 'card-closed'
  return null
}
function applyDecideAgain(model, rec, change) {
  const why = decideAgainRefusal(model, rec)
  if (why) return refuse(model, change, rec, why, 'decide again not counted')
  const card = model.cards.get(rec.object.object_id)
  card.answer.taken_back_at = rec.envelope_number
  card.answer = null
  card.object_state = 'open'
  card.closed_how = null
  card.updated_at = rec.sent_at
  change.cards.add(card.object_id)
  card.session_id && change.sessions.add(card.session_id)
  change.stack = true
  return { applied: true }
}

// ---- permission requests -----------------------------------------------------------------

function applyPermissionRequest(model, rec, change) {
  const object_id = rec.object?.object_id
  if (rec.sender_role !== 'agent') return refuse(model, change, rec, 'not-creator', 'permission requests come from agents')
  if (!object_id || model.permissions.has(object_id)) return refuse(model, change, rec, 'bad-object', 'permission request without a new object id')
  if (rec.bind && rec.bind.requestId !== object_id) return refuse(model, change, rec, 'bad-object', 'request id differs from object id')
  if (rec.object_id_ok === false) return refuse(model, change, rec, 'bad-object-id', 'object id is not H(creator, sequence)')
  const c = rec.content ?? {}
  model.permissions.set(object_id, { object_id, agent_device_id: rec.sender_device_id, session_id: rec.session_id ?? null, tool_name: c.tool_name ?? '', description: c.description ?? '', input_preview: c.input_preview ?? '',
    expires_at: rec.bind?.expiresAt ?? 0, version_hash: rec.envelope_hash, envelope_number: rec.envelope_number, sent_at: rec.sent_at, permission_state: 'pending', verdict: null })
  change.permissions.add(object_id)
  if (rec.session_id) change.sessions.add(rec.session_id)
  change.stack = true
  return { applied: true }
}
export function verdictRefusal(model, rec) {
  const p = model.permissions.get(rec.object?.object_id ?? rec.bind?.requestId)
  if (rec.sender_role !== 'human') return 'not-human'
  if (!p || !rec.bind || rec.bind.requestId !== p.object_id) return 'request-mismatch'
  if (rec.recipient_device_id !== p.agent_device_id) return 'not-for-owner'
  if (p.permission_state !== 'pending') return 'request-not-pending'
  if (rec.bind.requestHash !== p.version_hash || rec.bind.expiresAt !== p.expires_at) return 'request-changed'
  return null
}
function applyVerdict(model, rec, change) {
  const why = verdictRefusal(model, rec)
  if (why) return refuse(model, change, rec, why, 'verdict not counted')
  const p = model.permissions.get(rec.bind.requestId)
  p.verdict = { allow: rec.bind.allow, by_device_id: rec.sender_device_id, envelope_number: rec.envelope_number }
  p.permission_state = rec.bind.allow ? 'allowed' : 'denied'
  change.permissions.add(p.object_id)
  if (p.session_id) change.sessions.add(p.session_id)
  change.stack = true
  return { applied: true }
}
export const isExpired = (p, now = Date.now()) => p.permission_state === 'pending' && now > p.expires_at

// ---- registers ------------------------------------------------------------------------------

const HUMAN_PREFIXES = ['draft/', 'snooze/', 'duck/', 'desk/', 'session/', 'read_up_to/', 'canvas_snapshot/']
const isHumanKey = k => k === 'crown' || k === 'room_snapshot' || HUMAN_PREFIXES.some(p => k.startsWith(p))
const isAgentKey = k => k === 'profile' || k.startsWith('status_line/') || k.startsWith('alert/')

function applyStatus(model, rec, change) {
  const values = rec.content?.values
  if (!values || typeof values !== 'object') {
    if (rec.content_state === 'ok') return refuse(model, change, rec, 'bad-status', 'status without values')
    return { applied: false }
  }
  for (const [key, value] of Object.entries(values)) {
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
      if (!rec.session_id || !everAgent(model, rec.session_id, rec.sender_device_id)) { refuse(model, change, rec, 'not-allowed', `${key} outside the agent's session`); continue }
      setAgentRegister(model, rec.session_id, key, value, rec, change)
    } else if (rec.sender_role === 'agent' && isHumanKey(key) || rec.sender_role === 'human' && isAgentKey(key)) {
      refuse(model, change, rec, 'foreign-key', `${key} is not a ${rec.sender_role} key`)
    } else if (rec.sender_role === 'agent') {
      if (rec.session_id && everAgent(model, rec.session_id, rec.sender_device_id)) setAgentRegister(model, rec.session_id, key, value, rec, change)    // unknown agent keys are kept raw
    } else if (model.room.my_role !== 'agent') {
      setHumanRegister(model, key, value, rec, change)                           // unknown human keys are kept raw
    }
  }
  return { applied: true }
}

export function setHumanRegister(model, key, value, rec, change) {
  const h = model.human
  const old = h.raw.get(key)
  // R2: the causally latest write wins, whatever order the hub delivered them in. A delete stays as a tombstone (value null).
  if (!rec.pending && old && !old.pending && rec.causal && old.causal && !causallyAfter(rec.causal, old.causal)) return false
  h.raw.set(key, { value: value ?? null, envelope_number: rec.envelope_number, by_device_id: rec.sender_device_id, pending: !!rec.pending, causal: rec.causal ?? old?.causal ?? null })
  const slash = key.indexOf('/')
  const prefix = slash < 0 ? key : key.slice(0, slash), id = slash < 0 ? null : key.slice(slash + 1)
  const put = (map, v) => (v === null || v === undefined ? map.delete(id) : map.set(id, v))
  switch (prefix) {
    case 'draft': put(h.drafts, value); change.cards.add(id); break
    case 'snooze': put(h.snoozes, value); change.cards.add(id); change.stack = true; break
    case 'duck': put(h.ducks, value); change.cards.add(id); break
    case 'crown': h.crown = value ?? null; break
    case 'desk': put(h.desks, value); break
    case 'session': {
      put(h.session_settings, value)
      const s = sessionOf(model, id); s.settings = value ?? null; change.sessions.add(id); change.stack = true; break
    }
    case 'read_up_to': {
      put(h.read_up_to, value)
      const s = sessionOf(model, id); s.read_up_to = Number(value) || 0
      s.unread_numbers = s.unread_numbers.filter(n => n > s.read_up_to); s.unread_count = s.unread_numbers.length
      change.sessions.add(id); break
    }
    case 'canvas_snapshot': put(h.canvas_snapshots, value); change.timelines.add(timelineKey('canvas', id)); break
  }
  change.registers.add(key)
}

function setAgentRegister(model, session_id, key, value, rec, change) {
  const s = sessionOf(model, session_id)
  const agent = rec.sender_device_id
  const old = s.registers.get(key)
  // R2 as for human registers: one total order of writes; a delete stays as a tombstone (value null).
  if (old && rec.causal && old.causal ? !causallyAfter(rec.causal, old.causal) : old?.sender_sequence && rec.sender_sequence && rec.sender_sequence <= old.sender_sequence) return
  s.registers.set(key, { value: value ?? null, envelope_number: rec.envelope_number, sender_sequence: rec.sender_sequence, causal: rec.causal ?? null })
  if (key === 'profile') s.profile = value ?? null
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

/** Recompute stack, per-session card lists and unread counts. Cheap: one pass over cards and sessions. */
export function project(model, change, now = Date.now()) {
  const before = model.stack.join(',') + '|' + model.open_permission_ids.join(',')
  const snoozed = id => { const v = model.human.snoozes.get(id); return v && (v.until == null || v.until > now) }
  const archived = agent => !!model.sessions.get(agent)?.settings?.archived
  const open = []
  for (const s of model.sessions.values()) { s.open_card_ids = []; s.card_ids.sort((a, b) => (model.cards.get(a)?.created_at ?? 0) - (model.cards.get(b)?.created_at ?? 0)) }
  for (const c of model.cards.values()) {
    if (c.object_state !== 'open') continue
    if (c.session_id) sessionOf(model, c.session_id).open_card_ids.push(c.object_id)
    if (!snoozed(c.object_id) && !archived(c.session_id)) open.push(c)
  }
  open.sort((a, b) => URGENCY_RANK[b.urgency] - URGENCY_RANK[a.urgency] || a.created_at - b.created_at || (a.agent_device_id < b.agent_device_id ? -1 : a.agent_device_id > b.agent_device_id ? 1 : 0))
  model.stack = open.map(c => c.object_id)
  for (const s of model.sessions.values()) s.open_card_ids.sort((a, b) => model.cards.get(a).created_at - model.cards.get(b).created_at)
  model.open_permission_ids = [...model.permissions.values()].filter(p => p.permission_state === 'pending' && now <= p.expires_at).sort((a, b) => a.envelope_number - b.envelope_number).map(p => p.object_id)
  if (before !== model.stack.join(',') + '|' + model.open_permission_ids.join(',')) change.stack = true
}

/** Unread items: from the agent, in its session timeline and its cards' timelines, newer than read_up_to. Needs the unread index kept by the sync engine. */
export function stackOf(model, { desk_id } = {}) {
  if (desk_id == null) return model.stack
  return model.stack.filter(id => (model.sessions.get(model.cards.get(id)?.session_id)?.settings?.desk ?? null) === desk_id)
}

/** The items of a timeline window, sorted (pending echoes last). */
export function timelineItems(t) {
  return [...t.items.values()].sort((a, b) => (a.envelope_number ?? Infinity) - (b.envelope_number ?? Infinity) || (a.sent_at - b.sent_at))
}

/** For a card's conversation: timeline items merged with card versions and answers, sorted by envelope_number. */
export function timelineEvents(model, key) {
  const t = model.timelines.get(key)
  const out = t ? timelineItems(t).map(item => ({ event: 'item', envelope_number: item.envelope_number, item })) : []
  const p = parseTimelineKey(key)
  if (p.scope === 'card') {
    const card = model.cards.get(p.scope_id)
    if (card) {
      for (const v of card.versions) out.push({ event: v.object_version === 1 ? 'card_created' : 'card_version', envelope_number: v.envelope_number, version: v })
      for (const a of card.answers) {
        out.push({ event: 'answer', envelope_number: a.envelope_number, answer: a })
        if (a.taken_back_at) out.push({ event: 'decide_again', envelope_number: a.taken_back_at, answer: a })
      }
    }
  }
  return out.sort((a, b) => (a.envelope_number ?? Infinity) - (b.envelope_number ?? Infinity))
}

// ---- persistence: records <-> model ------------------------------------------------------

const mapToObj = m => Object.fromEntries(m)
const objToMap = o => new Map(Object.entries(o ?? {}))

export function serialiseSession(s) { return { ...s, registers: [...s.registers] } }
export function deserialiseSession(o) { return { ...o, registers: new Map(o.registers ?? []) } }
export function serialiseTimelineMeta(t) { const { items, ...rest } = t; return { ...rest, loaded_down_to: Number.isFinite(t.loaded_down_to) ? t.loaded_down_to : null, window_open: false } }
export function deserialiseTimelineMeta(o) { return { ...o, items: new Map(), loaded_down_to: o.loaded_down_to ?? Infinity, window_open: false } }
export function serialiseHuman(h) {
  return { raw: [...h.raw] }
}
/** Human registers are rebuilt from raw values (one source of truth). */
export function deserialiseHuman(model, o) {
  const change = emptyChange()
  for (const [key, v] of o?.raw ?? []) setHumanRegister(model, key, v.value, { envelope_number: v.envelope_number, sender_device_id: v.by_device_id, causal: v.causal }, change)
}
export { mapToObj, objToMap, URGENCY }
