// The mock room: the client core's API and model shape (core/README.md), without a hub and without crypto, fed from
// /demo/fixture.json (the repository's demo/data/, copied by the build: demo/README.md) or generated big
// (?mock=crazy). The other names (?mock=side, quiet, fresh, first, many, foot, reads, link) are variants built from the
// fixture's own sessions and cards: on a room without any they are the room as it is. Used with ?mock=1 for UI work;
// the real core is the default.
// Agents are simulated: they reply to messages, rework a card that was handed back, explain on "What??".
import { STATES } from '../gen/vendor/demo-screens.mjs'

const ZERO = () => ({ cards: new Set(), sessions: new Set(), permissions: new Set(), notes: new Set(), published: new Set(), timelines: new Set(), registers: new Set(), members: false, invites: new Set(), alerts: false, outbox: false, stack: false, room: false })
const URG = { critical: 0, high: 1, normal: 2, low: 3 }
const hex = n => [...crypto.getRandomValues(new Uint8Array(n / 2))].map(b => b.toString(16).padStart(2, '0')).join('')
const toMap = obj => new Map(Object.entries(obj ?? {}))
// A file's key and hash in the form a reference carries them (base64url of 32 bytes). The demo room decrypts
// nothing (a file's bytes come from its `url`), so every file gets this one; the Scribble Board's merge reads a
// picture's reference in the wire's form and takes none without them.
const NO_KEY = 'A'.repeat(43)
const keyed = a => ({ ...a, file_key: a.file_key || NO_KEY, sha256: a.sha256 || NO_KEY })

// The fixture's records as the model has them (app/web/core/types.ts): the fields the fixture does not write get
// the value they have in a room where nothing of that kind happened. A session's key is its agent's device id here,
// and that is its session id; what belongs to a session names it by both.
const sessionOf = s => ({
  session_id: s.agent_device_id, group_id: null, agent_device_ids: [s.agent_device_id], stale: false, group_archived: false, offline_since: null, link: null,
  heard_up_to: null, heard_at: null, session_key_epoch: 1, created_by_agent: false, creator_device_id: null, parent_session_id: null,
  ...s, agent_alerts: [], registers: new Map(), card_ids: [], open_card_ids: [], timeline_key: `chat:session/${s.agent_device_id}`, last_activity_at: 0,
})
const memberOf = ({ agent_session_id: _, ...m }) => ({ platform: null, folder: null, host: null, offline_since: null, link: null, fingerprint: m.device_id.slice(0, 16).match(/.{4}/g).join(' '), ...m })
const answerOf = a => Object.assign(a, { envelope_hash: a.envelope_hash ?? null, by_device_id: a.by_device_id ?? null, taken_back_at: a.taken_back_at ?? null, taken_back_sent_at: a.taken_back_sent_at ?? null, pending: false })
const cardOf = c => { for (const a of [c.answer, ...c.answers]) if (a) answerOf(a); return Object.assign(c, { session_id: c.session_id ?? c.agent_device_id, state_envelope_number: c.state_envelope_number ?? c.envelope_number ?? 0, unsupported: c.unsupported ?? null }) }
const requestOf = p => Object.assign(p, { session_id: p.session_id ?? p.agent_device_id })
const publishedOf = p => Object.assign(p, { session_id: p.session_id ?? p.agent_device_id, artifact_type: p.artifact_type ?? null, content_state: p.content_state ?? 'ok' })
const noteOf = n => Object.assign(n, { version_hashes: n.version_hashes ?? (n.version_hash ? [n.version_hash] : []), causal: n.causal ?? null, pending: false, unsupported: false })
/** A board's items with every picture's reference in the form the merge takes (see NO_KEY). */
const boardItems = items => items.map(it => (it.content?.content_type === 'strokes' && it.content.strokes?.some(e => e.attachment && !(e.attachment.file_key && e.attachment.sha256))
  ? { ...it, content: { ...it.content, strokes: it.content.strokes.map(e => (e.attachment ? { ...e, attachment: keyed(e.attachment) } : e)) } } : it))

export class MockClient {
  constructor(fixture, { simulate = true } = {}) {
    this.listeners = new Map()
    this.simulate = simulate
    this.store = new Map()          // timeline_key -> every item, oldest first (stands in for storage + hub)
    const f = fixture
    const { last_entry_number = 0, ...room } = f.room
    this.entries = last_entry_number   // counts the room's member changes (a member's added_entry_number)
    this.model = {
      room: { outbox_blocked: null, ...room },
      members: new Map(f.members.map(m => [m.device_id, memberOf(m)])),
      sessions: new Map(f.sessions.map(s => [s.agent_device_id, sessionOf(s)])),
      cards: new Map(f.cards.map(c => [c.object_id, cardOf(c)])),
      permissions: new Map((f.permissions ?? []).map(p => [p.object_id, requestOf(p)])),
      notes: new Map((f.notes ?? []).map(n => [n.object_id, noteOf(n)])),
      published: new Map((f.published ?? []).map(p => [p.object_id, publishedOf(p)])),
      timelines: new Map(),
      human: {
        drafts: toMap(f.human.drafts), snoozes: toMap(f.human.snoozes), ducks: toMap(f.human.ducks), crown: f.human.crown ?? null,
        desks: toMap(f.human.desks), session_settings: toMap(f.human.session_settings), scribble_snapshots: new Map(), raw: new Map(),
      },
      invites: new Map(), alerts: [], outbox: [], stack: [], open_permission_ids: [],
      newer: { count: 0, what: [], envelope_number: 0 },
    }
    const sessions = this.model.sessions
    for (const [key, items] of Object.entries(f.timelines ?? {})) this.store.set(key, key.startsWith('scribble:') ? boardItems(items) : items.map(i => ('sender_sequence' in i ? i : { ...i, sender_sequence: null })))
    for (const c of this.model.cards.values()) { this.timeline(c.timeline_key); this.ensureStore(c.timeline_key) }
    for (const s of sessions.values()) { this.timeline(s.timeline_key); this.ensureStore(s.timeline_key) }
    for (const [key, items] of this.store) { const t = this.timeline(key); t.item_count = items.length; t.newest_envelope_number = items.at(-1)?.envelope_number ?? 0; t.has_more = items.length > 0 }
    this.project()
  }
  ensureStore(key) { if (!this.store.has(key)) this.store.set(key, []) }
  timeline(key) {
    let t = this.model.timelines.get(key)
    if (!t) {
      const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
      t = { timeline_key: key, timeline_kind: kind, timeline_id: id, object_id: id.split('/')[1], item_count: 0, newest_envelope_number: 0, items: new Map(), loaded_down_to: Infinity, has_more: false, window_open: false }
      this.model.timelines.set(key, t)
    }
    return t
  }
  on(event, fn) { if (!this.listeners.has(event)) this.listeners.set(event, new Set()); this.listeners.get(event).add(fn); return () => this.listeners.get(event).delete(fn) }
  emit(event, value) { for (const fn of this.listeners.get(event) ?? []) { try { fn(value) } catch (err) { console.error(err) } } }
  changed(fill) { const c = ZERO(); fill(c); if (c.cards.size || c.registers.size || c.sessions.size || c.permissions.size || c.room) this.project(c); this.emit('change', c) }
  async start() { this.model.room.connection = 'live'; this.changed(c => { c.room = true }) }
  stop() {}
  next() { return ++this.model.room.last_envelope_number }

  // ---- projections ----
  project(change) {
    const m = this.model, now = Date.now()
    const archived = id => Boolean(m.human.session_settings.get(id)?.archived)
    const before = m.stack.join()
    m.stack = [...m.cards.values()].filter(c => c.object_state === 'open' && !(m.human.snoozes.get(c.object_id)?.until > now) && !archived(c.agent_device_id))
      .sort((a, b) => URG[a.urgency] - URG[b.urgency] || a.first_envelope_number - b.first_envelope_number).map(c => c.object_id)
    m.open_permission_ids = [...m.permissions.values()].filter(p => p.permission_state === 'pending').sort((a, b) => a.envelope_number - b.envelope_number).map(p => p.object_id)
    for (const s of m.sessions.values()) { s.card_ids = []; s.open_card_ids = [] }
    for (const c of [...m.cards.values()].sort((a, b) => a.first_envelope_number - b.first_envelope_number)) {
      const s = m.sessions.get(c.agent_device_id); if (!s) continue
      s.card_ids.push(c.object_id); if (c.object_state === 'open') s.open_card_ids.push(c.object_id)
    }
    if (change && before !== m.stack.join()) change.stack = true
  }

  // ---- timelines ----
  async loadTimeline(key, { limit = 50 } = {}) {
    const t = this.timeline(key), all = this.store.get(key) ?? []
    const older = all.filter(i => i.envelope_number != null && i.envelope_number < t.loaded_down_to).slice(-limit)
    for (const i of older) t.items.set(i.envelope_number, i)
    if (older.length) t.loaded_down_to = older[0].envelope_number
    t.has_more = all.some(i => i.envelope_number != null && i.envelope_number < t.loaded_down_to)
    if (!older.length && t.loaded_down_to === Infinity) t.loaded_down_to = 0
    this.changed(c => c.timelines.add(key))
    return { loaded: older.length, has_more: t.has_more }
  }
  addItem(key, item, change) {
    this.ensureStore(key)
    this.store.get(key).push(item)
    const t = this.timeline(key)
    t.items.set(item.envelope_number ?? item.local_id, item)
    t.item_count++
    if (item.envelope_number) t.newest_envelope_number = item.envelope_number
    change.timelines.add(key)
  }
  confirm(key, item) {
    const t = this.timeline(key)
    t.items.delete(item.local_id)
    item.envelope_number = this.next(); item.pending = false; item.envelope_hash = hex(64)
    t.items.set(item.envelope_number, item); t.newest_envelope_number = item.envelope_number
    this.changed(c => c.timelines.add(key))
  }
  sessionOfCard(id) { return this.model.cards.get(id)?.agent_device_id }

  // ---- human actions ----
  async sendMessage({ agent_device_id = null, session_id = null, object_id = null, ...content }) {
    agent_device_id ??= session_id   // (a session's id is its agent's device id in this room)
    const key = object_id ? `chat:card/${object_id}` : `chat:session/${agent_device_id}`
    const to = agent_device_id ?? this.sessionOfCard(object_id)
    const item = { envelope_number: null, local_id: `l-${hex(8)}`, pending: true, envelope_hash: null, sender_device_id: this.model.room.my_device_id, sender_sequence: null, recipient_device_id: to, sent_at: Date.now(), item_state: 'loaded', content_type: 'message', content }
    this.changed(c => {
      this.addItem(key, item, c)
      const card = object_id && this.model.cards.get(object_id)
      if (card && card.object_state === 'open' && (content.hand_back || content.explain)) { card.in_revision = { by: content.hand_back ? 'hand_back' : 'explain', envelope_number: this.model.room.last_envelope_number + 1 }; c.cards.add(object_id); c.stack = true }
      if (card && content.present_card) { card.in_revision = null; c.cards.add(object_id) }   // taken back: presented again
    })
    setTimeout(() => this.confirm(key, item), 60)
    if (this.simulate) this.agentAnswers(to, object_id, content)
  }
  answerWith(object_id, fields) {
    const card = this.model.cards.get(object_id)
    if (!card) throw Object.assign(new Error('unknown card'), { code: 'not-found' })
    if (card.object_state !== 'open') throw Object.assign(new Error('card already decided'), { code: 'bad-argument' })
    const answer = answerOf({ answer_action: 'answer', choices: [], note: '', option_notes: {}, attachments: [], marks: [], trusted: false, ...fields, bound_version_hash: card.version_hash, bound_object_version: card.object_version, envelope_number: this.next(), envelope_hash: hex(64), by_device_id: this.model.room.my_device_id, answered_at: Date.now(), taken_back_at: null })
    // (as the core: every choice a final option, nothing said beside it and not left to the agent: the answer settles the card)
    const plain = !String(answer.note ?? '').trim() && !Object.values(answer.option_notes ?? {}).some(Boolean) && !answer.attachments.length && !answer.marks.length
    const settled = answer.answer_action === 'answer' && !answer.trusted && plain && answer.choices.length > 0 && answer.choices.every(k => card.options.find(o => o.key === k)?.final === true)
    this.changed(c => {
      card.answer = answer; card.answers.push(answer)
      card.object_state = answer.answer_action === 'answer' && !settled ? 'answered' : 'closed'
      card.closed_how = answer.answer_action === 'shred' ? 'shredded' : answer.answer_action === 'read' ? 'read' : settled ? 'settled' : 'answered'
      card.in_revision = null; card.updated_at = answer.answered_at
      c.cards.add(object_id); c.stack = true
    })
  }
  async answer({ object_id, choices, note = '', option_notes = {}, attachments = [], marks = [] }) { this.answerWith(object_id, { choices, note, option_notes, attachments, marks }) }
  async trust({ object_id, note = '' }) { const card = this.model.cards.get(object_id); this.answerWith(object_id, { trusted: true, choices: [].concat(card?.recommended ?? []), note }) }
  async markRead({ object_id }) { this.answerWith(object_id, { answer_action: 'read' }) }
  async shred({ object_id, note = '', marks = [], attachments = [] }) { this.answerWith(object_id, { answer_action: 'shred', note, marks, attachments }) }
  async decideAgain({ object_id }) {
    const card = this.model.cards.get(object_id)
    if (!card?.answer) throw Object.assign(new Error('nothing to take back'), { code: 'bad-argument' })
    this.changed(c => { card.answer.taken_back_at = this.next(); card.answer.taken_back_sent_at = Date.now(); card.answer = null; card.object_state = 'open'; card.closed_how = null; c.cards.add(object_id); c.stack = true })
  }
  async verdict({ object_id, allow }) {
    const p = this.model.permissions.get(object_id)
    this.changed(c => { p.permission_state = allow ? 'allowed' : 'denied'; p.verdict = { allow, by_device_id: this.model.room.my_device_id, envelope_number: this.next() }; c.permissions.add(object_id); c.stack = true })
  }
  async setRegisters(values) {
    const h = this.model.human
    const MAPS = { draft: h.drafts, snooze: h.snoozes, duck: h.ducks, desk: h.desks, session: h.session_settings }
    this.changed(c => {
      for (const [key, value] of Object.entries(values)) {
        c.registers.add(key)
        if (key === 'crown') { h.crown = value; continue }
        const [kind, id] = [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)]
        const map = MAPS[kind]
        if (map) { if (value == null) map.delete(id); else map.set(id, value) }
        if (value == null) h.raw.delete(key); else h.raw.set(key, { value, envelope_number: this.model.room.last_envelope_number, by_device_id: this.model.room.my_device_id })
        if (kind === 'session') c.sessions.add(id)
        if (kind === 'snooze' || kind === 'session') c.stack = true
        if (kind === 'draft' || kind === 'snooze' || kind === 'duck') c.cards.add(id)
      }
    })
  }
  setDraft(id, v) { return this.setRegisters({ [`draft/${id}`]: v }) }
  snooze(id, until) { return this.setRegisters({ [`snooze/${id}`]: until == null ? null : { until, at: Date.now() } }) }
  duck(id, v) { return this.setRegisters({ [`duck/${id}`]: v }) }
  setCrown(v) { return this.setRegisters({ crown: v }) }
  setDesk(id, v) { return this.setRegisters({ [`desk/${id}`]: v }) }
  async saveNote({ object_id = hex(32), ...fields }) {
    const had = this.model.notes.get(object_id)
    const version_hash = hex(64)
    const note = noteOf({ object_id, by_device_id: this.model.room.my_device_id, text: '', ...had, ...fields, object_version: (had?.object_version ?? 0) + 1, version_hash, version_hashes: [...(had?.version_hashes ?? []), version_hash], envelope_number: this.next(), object_state: fields.object_state ?? had?.object_state ?? 'open' })
    this.changed(c => { this.model.notes.set(object_id, note); c.notes.add(object_id) })
    return object_id
  }
  deleteNote(object_id) { return this.saveNote({ object_id, object_state: 'closed' }) }
  async uploadAttachment(bytes, meta) {
    const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: meta.media_type })
    return { attachment_id: hex(32), file_key: NO_KEY, sha256: NO_KEY, total_size: blob.size, ...meta, url: URL.createObjectURL(blob) }
  }
  async attachmentBlob(ref) { return (await fetch(ref.url)).blob() }
  // Share links (Copy link on an artifact): kept in this tab, the form of the real link (the mock has no keys: stand-ins).
  async shareAttachment(ref, { expires_at = Date.now() + 30 * 86400000 - 60000, app_url = location.origin, keep_link = false } = {}) {
    const b64 = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const own = v => (v && v !== NO_KEY ? v : b64())
    const share_id = hex(32), link = `${app_url}/artifact/${share_id}#${b64()}.${own(ref.file_key)}.${own(ref.sha256)}`
    ;(this.shares ??= new Map()).set(share_id, { attachment_id: ref.attachment_id, expires_at, ...(keep_link ? { link, created_at: Date.now() } : {}) })
    return { share_id, link, expires_at }
  }
  async revokeShare(share_id) { this.shares?.delete(share_id) }
  async myShares() { return [...(this.shares ?? new Map())].filter(([, x]) => x.expires_at > Date.now()).map(([share_id, x]) => ({ share_id, ...x })).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0)) }
  async fetchAttachment(ref) { return new Uint8Array(await (await this.attachmentBlob(ref)).arrayBuffer()) }

  // ---- membership (mock: an invite that is joined by a pretend phone after a moment) ----
  async createInvite({ device_role = 'human', app_url = `${location.origin}/join`, session_id = null, takeover = false } = {}) {
    const invite_id = hex(32)
    const invite = { invite_id, device_role, link: `${app_url}#v1.mock.${this.model.room.room_id.slice(0, 16)}.${hex(32)}`, expires_at: Date.now() + 600000, invite_state: 'open', newcomer: null, error: null, check_code: null, session_id, takeover: !!takeover }
    this.changed(c => { this.model.invites.set(invite_id, invite); c.invites.add(invite_id) })
    setTimeout(() => this.changed(c => {
      invite.newcomer = { device_id: hex(64), device_name: device_role === 'agent' ? 'claude-session' : 'Phone (new)' }
      // every invite asks to compare the check code, agents included, as the core does
      invite.invite_state = 'confirm_code'
      // the core's format: six numbers 0–63, shown as emoji (core/check-emoji.ts)
      invite.check_code = Array.from({ length: 6 }, () => String(Math.floor(Math.random() * 64)).padStart(2, '0')).join('-')
      c.invites.add(invite_id)
    }), 2500)
    return invite
  }
  async confirmInvite(invite_id, matches) {
    const invite = this.model.invites.get(invite_id)
    if (matches !== true) { this.changed(c => { invite.invite_state = 'failed'; invite.error = 'code-mismatch'; c.invites.add(invite_id) }); throw Object.assign(new Error('the check codes do not match: nobody was added, the invite is spent'), { code: 'code-mismatch' }) }
    this.addMember(invite)
  }
  addMember(invite) {
    this.changed(c => {
      invite.invite_state = 'joined'; c.invites.add(invite.invite_id)
      const m = { device_id: invite.newcomer.device_id, device_role: invite.device_role, device_name: invite.newcomer.device_name, is_active: true, added_entry_number: ++this.entries, removed_entry_number: null, is_me: false, is_online: true }
      this.model.members.set(m.device_id, memberOf(m)); c.members = true
    })
  }
  // Storage use, handing a session to an agent: shaped like the core, nothing behind them.
  async usage() { return { bytes: 48_300_000, limit_bytes: 1_000_000_000 } }
  async removeDevices(ids) {
    this.changed(c => {
      const entry = ++this.entries
      for (const id of ids) { const m = this.model.members.get(id); if (m) { m.is_active = false; m.removed_entry_number = entry } }
      this.model.room.key_epoch++; c.members = true; c.room = true
    })
  }

  // ---- simulated agents ----
  agentAnswers(agent, object_id, content) {
    const s = this.model.sessions.get(agent)
    if (!s) return
    const key = object_id ? `chat:card/${object_id}` : `chat:session/${agent}`
    const say = (ms, body, after) => setTimeout(() => this.changed(c => {
      this.addItem(key, { envelope_number: this.next(), local_id: null, pending: false, envelope_hash: hex(64), sender_device_id: agent, sender_sequence: null, recipient_device_id: null, sent_at: Date.now(), item_state: 'loaded', content_type: 'message', content: body }, c)
      s.last_activity_at = Date.now(); c.sessions.add(agent)
      after?.(c)
    }), ms)
    if (content.explain) return say(1500, { text: 'In short: this is about which variant I build. Each option changes only one part; my recommendation is on the card.' })
    if (content.hand_back) {
      const card = this.model.cards.get(object_id)
      return say(1200, { text: 'Understood, I am reworking the card.' }, () => setTimeout(() => this.revise(card, content.text), 1500))
    }
    if (content.present_card) return
    say(900 + Math.random() * 800, { text: `Understood${content.text ? `: “${String(content.text).slice(0, 60)}”` : ''}. I will carry on.` })
  }
  revise(card, why) {
    if (!card || card.object_state !== 'open') return
    this.changed(c => {
      const n = this.next(), hash = hex(64)
      const content = { ...card.versions.at(-1).content, change_note: `Reworked: ${String(why ?? '').slice(0, 80)}`, body: `${card.body}\n\n(Reworked after you handed it back.)` }
      card.versions.push({ object_version: card.object_version + 1, version_hash: hash, previous_version_hash: card.version_hash, envelope_number: n, sent_at: Date.now(), object_state: 'open', urgency: card.urgency, content })
      Object.assign(card, content, { object_version: card.object_version + 1, version_hash: hash, envelope_number: n, updated_at: Date.now(), in_revision: null })
      c.cards.add(card.object_id); c.stack = true
    })
  }
}

// A small Desk for final answers (?mock=quiet): three open questions with an option their agent marked final (a chore
// with two named answers, a plain yes or no, one with three ways), two cards such an answer settled, two a session
// works on, and a few closed by their agents.
function quietDesk(f) {
  if (!f.sessions.length) return f   // (it is built around the room's first session)
  const now = Date.now(), MIN = 60e3, me = f.room.my_device_id
  const main = f.sessions[0], claude = main.agent_device_id
  Object.assign(main, { device_name: 'Claude', is_online: true, status_lines: [] })
  main.profile = { ...main.profile, agent_name: 'Claude', task: 'Fernly: the plant-care web app' }
  f.sessions = [main]
  const design = hex(64)
  f.sessions.push({ agent_device_id: design, agent_session_id: 'claude-design', device_name: 'Design', is_active: true, is_online: true,
    profile: { model: 'claude-opus-5-5', task: 'Landing page and style', icon: 'draw:brush', agent_name: 'Design', parent_session: main.agent_session_id, is_main: false },
    status_lines: [], settings: { name: '', desk: 'main', archived: false, group: null, icon: null } })
  const mine = new Set([claude, design])
  f.members = f.members.filter(m => m.device_role !== 'agent' || mine.has(m.device_id))
  f.human.session_settings = Object.fromEntries(Object.entries(f.human.session_settings ?? {}).filter(([k]) => mine.has(k)))
  f.human.snoozes = {}; f.human.drafts = {}
  f.timelines = Object.fromEntries(Object.entries(f.timelines ?? {}).filter(([k]) => k === `chat:session/${claude}`))
  f.cards = []; f.permissions = []; f.published = []
  let env = 9000
  // A card asked "ago" minutes back. how: 'open', 'answered' (its first option, with the agent), 'settled' (its first
  // option, final: closed by that answer) or a summary (its session closed it). options: [key, label, final?].
  const mk = (title, agent, ago, options, { body = '', how = 'open' } = {}) => {
    const id = hex(32), at = now - ago * MIN, n = ++env, version_hash = hex(64), open = how === 'open', by = !['open', 'answered', 'settled'].includes(how)
    const content = { card_type: 'decision', title, teaser: null, body, options: options.map(([key, label, final]) => ({ key, label, detail: '', ...(final ? { final: true } : {}) })), sections: null, html: null, allows_multiple: false, recommended: null, urgency_reason: '', attachments: [], change_note: '', close_summary: by ? how : null, withdraw_reason: null, merged_into_object_id: null, merged_from_object_ids: null }
    const answer = open ? null : { answer_action: 'answer', choices: [options[0][0]], note: '', option_notes: {}, attachments: [], marks: [], trusted: false, bound_version_hash: version_hash, bound_object_version: 1, envelope_number: ++env, envelope_hash: hex(64), by_device_id: me, answered_at: at, taken_back_at: null }
    f.cards.push({ object_id: id, agent_device_id: agent, first_envelope_number: n, created_at: at - (open ? 0 : 25 * MIN), answers: answer ? [answer] : [], answer, closed_how: open ? null : by ? 'closed' : how, in_revision: null, timeline_key: `chat:card/${id}`, content_state: 'ok', object_version: 1, version_hash, envelope_number: n, updated_at: at, urgency: 'normal', object_state: open ? 'open' : how === 'answered' ? 'answered' : 'closed', ...content,
      versions: [{ object_version: 1, version_hash, previous_version_hash: null, envelope_number: n, sent_at: at - (open ? 0 : 25 * MIN), object_state: 'open', urgency: 'normal', content }] })
  }
  mk('Which typeface for the headings?', design, 2 * 1440, [['bri', 'Bricolage'], ['int', 'Inter']], { how: 'Bricolage is in everywhere, the pricing page too.' })
  mk('A backup every night at 3?', claude, 1440, [['ja', 'Yes'], ['nein', 'No']], { how: 'The timer runs, the first backup is on the second disk.' })
  mk('Delete the old test data?', claude, 420, [['ja', 'Yes'], ['nein', 'No', true]], { how: '312 test accounts deleted, 1.4 GB free.' })
  mk('Round corners on the buttons?', design, 300, [['nein', 'Keep them square', true], ['ja', 'Round']], { how: 'settled', body: 'Square suits the plant cards; round would be an afternoon of work.' })
  mk('The shadow under the card: leave it?', design, 95, [['ja', 'Leave it', true], ['nein', 'Make it softer']], { how: 'settled', body: 'It is 2 px deep now and set a little to the right, as under the note.' })
  mk('Dog-ear: 20 % bigger, or leave it?', design, 12, [['gross', '20 % bigger'], ['so', 'Leave it', true]], { how: 'answered', body: 'Its tip would then stand 38 instead of 31 px from the corner.' })
  mk('Roll out the new server tonight?', claude, 25, [['nacht', 'Tonight'], ['morgen', 'Tomorrow']], { how: 'answered', body: 'The switch takes about two minutes; the site shows a short notice in that time.' })
  mk('Two small things for you (domain, auto mode)', claude, 34, [['done', 'Both done', true], ['hilfe', 'Show me how']], { body: '1. At your domain registrar, point “app” at the new server.\n2. In the terminal switch auto mode on (Shift+Tab), or every file asks by itself.' })
  mk('Leave the Later tag grey?', design, 21, [['ja', 'Yes', true], ['nein', 'No']], { body: 'Grey holds back like everything else that is off the desk. On No I build the blue one.' })
  mk('Review of the Today screen: three small things fixed. Fine like this?', design, 8, [['ok', 'Fine like this', true], ['nochmal', 'Once more'], ['bilder', 'Show pictures first']], { body: 'The heading no longer jumps, the sheet closes with Escape, the days stand right-aligned.' })
  f.human.desks = { main: f.human.desks.main }
  if (f.notes?.length) f.notes = [f.notes[0]]
  return f
}

// ?mock=foot: nothing open on the Desk ("Carry on."), but full piles at its foot: every question answered, and many
// pages the agents published (the phone's foot with three full piles and the empty Desk under them).
// ?mock=reads: only cards to read wait on the Desk (every question answered, no permission request): the duck and
// Blitz stand for them too.
function onlyReads(f) { settleAll(f, c => c.card_type === 'info'); return f }
function settleAll(f, keep = () => false) {
  for (const c of f.cards) if (!keep(c) && c.closed_how !== 'shredded' && (c.object_state !== 'closed' || c.closed_how === 'closed')) {
    const v = c.versions?.at(-1)
    c.answer ??= { answer_action: 'answer', choices: [v?.content?.options?.[0]?.key ?? 'a'], note: '', option_notes: {}, attachments: [], marks: [], trusted: false, bound_version_hash: c.version_hash, bound_object_version: c.object_version ?? 1, envelope_number: c.first_envelope_number, answered_at: Date.now() }
    c.answers = [c.answer]; c.object_state = 'closed'; c.closed_how = 'settled'; c.in_revision = null
  }
  f.permissions = []
}
function fullFoot(f) {
  settleAll(f)
  const pages = f.published.filter(p => p.attachments?.[0]?.media_type === 'text/html')
  const names = ['desklook-tabs', 'desklook-table', 'desklook-rows', 'cardscribble-trace', 'toast-slot', 'pages-pile', 'phone-foot', 'done-rows', 'tracing-sheet', 'all-desks']
  for (let i = 0; i < 60 && pages.length; i++) {
    const p = pages[i % pages.length], name = `${names[i % names.length]}-${Math.floor(i / names.length) + 1}`
    f.published.push({ ...structuredClone(p), object_id: hex(32), title: `${name}.html`, attachments: [{ ...p.attachments[0], attachment_id: hex(32), file_name: `${name}.html` }], envelope_number: (p.envelope_number ?? 1) + i + 1 })
  }
  return f
}

// The first run (?mock=fresh, ?mock=first): a new account's Desk before any agent (the invite note), and the same Desk
// a moment after the first agent came in and asked its first question.
function firstRun(f, withCard) {
  const main = f.sessions.find(s => s.device_name === 'Claude') ?? f.sessions[0]
  const first = f.cards.find(c => c.agent_device_id === main.agent_device_id && c.object_state === 'open' && c.versions.at(-1)?.content?.options?.length === 2)
  f.cards = []; f.permissions = []; f.published = []; f.notes = []; f.timelines = {}
  f.human.drafts = {}; f.human.snoozes = {}; f.human.ducks = {}; f.human.crown = null; f.human.desks = {}
  if (!withCard || !first) {
    f.sessions = []
    f.members = f.members.filter(m => m.device_role !== 'agent')
    f.human.session_settings = {}
    return f
  }
  f.sessions = [main]
  f.members = f.members.filter(m => m.device_role !== 'agent' || m.device_id === main.agent_device_id)
  f.human.session_settings = Object.fromEntries(Object.entries(f.human.session_settings ?? {}).filter(([k]) => k === main.agent_device_id))
  const v = first.versions.at(-1)
  first.content = v.content = { ...(first.content ?? v.content), teaser: null, title: 'Hello! Where should I keep the notes: SQLite or plain files?', body: 'My first question from this project. Both work; SQLite searches faster, plain files are easier to read by hand.', options: [{ key: 'sqlite', label: 'SQLite', detail: '' }, { key: 'files', label: 'Plain files', detail: '' }] }
  for (const k of ['title', 'body', 'options', 'teaser']) if (k in first) first[k] = first.content[k]
  first.created_at = v.sent_at = Date.now() - 40e3
  f.cards = [first]
  return f
}

let fixtureCache
/** The room of demo/data/fixture.json with its times moved to now: every time stamp (a number of ms under a key `at`,
 *  `until`, `since`, `*_at`, `*_since`) is shifted by now - made_at, so "5 min ago" stays five minutes ago. */
function moved(f) {
  const by = Date.now() - f.made_at
  const walk = (v, key) => {
    if (typeof v === 'number') return v > 1e12 && (key === 'at' || key === 'until' || key === 'since' || key.endsWith('_at') || key.endsWith('_since')) ? v + by : v
    if (Array.isArray(v)) return v.map(x => walk(x, key))
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]))
    return v
  }
  return walk(f, '')
}
async function loadFixture(kind) {
  if (kind === 'crazy') return crazyFixture()
  fixtureCache ??= await (await fetch('/demo/fixture.json')).json()
  return variantOf(moved(fixtureCache), kind)
}
/** The room `kind` names, built from the fixture's own sessions and cards ('1': the fixture as it is). */
export function variantOf(f, kind) {
  if (kind === 'quiet') return quietDesk(f)
  if (kind === 'fresh' || kind === 'first') return firstRun(quietDesk(f), kind === 'first')
  if (kind === 'many') return manyHelpers(crowded(f))
  if (kind === 'foot') return fullFoot(f)
  if (kind === 'reads') return onlyReads(f)
  return kind === 'side' ? crowded(f) : kind === 'link' ? linkDemo(f) : f
}

// ?mock=link: one session in each state of its link (app.mjs linkOf), and receipts. landing-page hears on its next step and
// is at work, copy the same but has done nothing for 46 minutes, widgets is cut off (its Claude Code runs, its Trommi tools
// are gone), cdn is gone; the others hear at once. Every older answer reached its session; two were not picked up.
function linkDemo(f) {
  const now = Date.now(), MIN = 60e3
  const by = id => f.sessions.find(s => s.agent_session_id === id)
  const report = (hears, min, more = {}) => ({ hears, attached: true, last_call_at: now - min * MIN, working: false, since: now - 300 * MIN, cut_since: null, exit: null, ...more })
  const LINK = {
    'landing-page': report('oncall', 1),
    copy: report('oncall', 46),
    widgets: report('live', 44),
    'payments-service': report('oncall', 3),
  }
  const HEARD = 1e9
  for (const s of f.sessions) { s.link = LINK[s.agent_session_id] ?? report('live', 2); s.heard_up_to = HEARD }
  const off = (id, min, exit) => { const s = by(id); if (s) { s.is_online = false; s.offline_since = now - min * MIN; s.link = { ...s.link, exit } } }
  off('widgets', 38, { reason: 'stdin', claude: 'alive' })
  off('cdn', 131, { reason: 'stdin', claude: 'gone' })
  const answer = (title, ago, heard) => {
    const c = f.cards.find(c => c.title === title); if (!c) return
    if (!c.answer) {
      const v = c.versions[0]
      c.answer ??= { answer_action: 'answer', choices: [c.options?.[0]?.key ?? 'ja'], note: '', option_notes: {}, attachments: [], marks: [], trusted: false, bound_version_hash: v.version_hash, bound_object_version: 1, envelope_number: c.first_envelope_number + 1, envelope_hash: hex(64), by_device_id: f.room.my_device_id, answered_at: now - ago * MIN, taken_back_at: null }
      c.answers = [c.answer]; c.object_state = 'answered'; c.closed_how = 'answered'
    }
    c.answer.answered_at = now - ago * MIN
    c.answer.envelope_number = heard ? Math.min(c.answer.envelope_number ?? 1, HEARD) : HEARD + 1
  }
  answer('Remind in the morning or in the evening?', 4, true)
  answer('Send a weekly summary e-mail on Sundays?', 12, false)
  // (and one answer each that waits: in the session that is cut off, in one that hears on its next step, in one that hears at once)
  const waiting = (id, ago) => { const s = by(id), c = s && f.cards.find(c => c.agent_device_id === s.agent_device_id && c.object_state === 'open' && c.card_type !== 'info' && c.urgency === 'normal' && !c.in_revision); if (c) answer(c.title, ago, false) }
  waiting('widgets', 6); waiting('landing-page', 1); waiting('fernly-web', 9)
  return f
}

// A full sidebar (?mock=side): eight more sessions beside the demo's two trees, with long names and none, one, two,
// five, six and twelve open questions, two of them disconnected.
// One main with many helpers (?mock=many): the full sidebar's eight sessions become Board's helpers, fourteen in all;
// the folded rail must stay calm with them.
function manyHelpers(f) {
  if (!f.sessions.length) return f
  const main = f.sessions[0].agent_session_id
  for (const s of f.sessions.slice(-8)) s.profile = { ...s.profile, parent_session: main }
  return f
}
function crowded(f) {
  const now = Date.now(), MIN = 60e3, like = f.cards.find(c => c.object_state === 'open' && c.card_type === 'decision' && c.urgency === 'normal' && !c.in_revision)
  if (!like) return f   // (its questions are copies of one of the room's open cards)
  const session = (id, name, icon, online, line, asks) => {
    const dev = hex(64)
    f.sessions.push({ agent_device_id: dev, agent_session_id: id, device_name: name, is_active: true, is_online: online,
      profile: { model: 'claude-opus-5-5', task: name, icon, agent_name: name, parent_session: null, is_main: false },
      status_lines: line ? [{ id: `${id}-1`, label: line, state: 'working', detail: '', object_id: null, updated_at: now - MIN }] : [],
      settings: { name: '', desk: 'main', archived: false, group: null, icon: null } })
    asks.forEach((title, i) => {
      const id = hex(32), at = now - (20 + i * 7) * MIN, version_hash = hex(64), c = structuredClone(like)
      Object.assign(c, { object_id: id, agent_device_id: dev, title, teaser: null, body: '', attachments: [], created_at: at, updated_at: at, timeline_key: `chat:card/${id}`, object_version: 1, version_hash, answers: [], answer: null })
      c.versions = [{ ...c.versions[0], object_version: 1, version_hash, previous_version_hash: null, sent_at: at, content: { ...c.versions[0].content, title, teaser: null, body: '', attachments: [] } }]
      f.cards.push(c)
    })
  }
  const ask = (n, what) => Array.from({ length: n }, (_, i) => `${what} ${i + 1}?`)
  session('release-notes', 'Release notes and changelog', 'draw:book', true, 'Changelog', ask(12, 'Mention change'))
  session('billing', 'Billing', 'draw:database', true, 'Invoices', [])
  session('translations', 'Translations (German, French)', 'draw:leaf', true, null, ask(2, 'Keep the English word'))
  session('research', 'Research', 'draw:eye', true, null, ask(1, 'Read the paper'))
  session('support', 'Support inbox', 'draw:heads', true, null, ask(5, 'Answer the mail'))
  session('design', 'Design', 'draw:pen', true, null, ask(6, 'Keep the variant'))
  session('importer', 'Old importer', 'draw:terminal', false, null, ask(4, 'Drop the column'))
  session('night-build', 'Night build', 'draw:rocket', false, null, [])
  return f
}
export async function openRoom({ mock = '1' } = {}) { return new MockClient(await loadFixture(mock)) }

// ---- the very big demo room (?mock=crazy: dev/perf.mjs) ----
// A very big mock room for performance work (?mock=crazy): 30+ sessions with status lines, 5,000 answered cards
// with revisions, hundreds of open cards on the Desk, 50,000 chat messages (one session thread over 2,000).
// Same shape as demo/data/fixture.json (the core's model, core/README.md).
function crazyFixture({ sessions = 32, answered = 5000, open = 300, messages = 50000 } = {}) {
  const hex = (n, seed) => { let h = ''; let x = seed * 2654435761 >>> 0; while (h.length < n) { x = (x ^ (x << 13)) >>> 0; x = (x ^ (x >>> 17)) >>> 0; x = (x ^ (x << 5)) >>> 0; h += x.toString(16).padStart(8, '0') } return h.slice(0, n) }
  const now = Date.now()
  const icons = ['draw:flask', 'draw:bug', 'draw:key', 'draw:brush', 'draw:rocket', 'draw:database', 'draw:terminal', 'draw:book', 'draw:bell', 'draw:leaf']
  const me = hex(64, 1)
  const ss = Array.from({ length: sessions }, (_, i) => ({
    agent_device_id: hex(64, 1000 + i), agent_session_id: `agent-${i + 1}`, device_name: `Agent ${i + 1}`, is_active: true, is_online: i % 3 !== 0,
    profile: { model: 'claude-opus-5-5', task: `Aufgabe ${i + 1}`, icon: icons[i % icons.length], agent_name: `Agent ${i + 1}`, parent_session: i > 0 && i % 5 === 0 ? 'agent-1' : null, is_main: i === 0 },
    status_lines: Array.from({ length: 1 + (i % 4) }, (_, k) => ({ id: `s${k}`, label: ['Tests', 'Build', 'Deploy', 'Docs'][k], state: ['working', 'done', 'decision', 'working'][(i + k) % 4], detail: `${(i * 7 + k) % 40}/40`, object_id: null, updated_at: now - k * 60000 })),
    settings: { name: '', desk: 'main', archived: false, group: null, icon: null },
  }))
  let n = 0
  const cards = []
  const mk = (i, isOpen) => {
    const s = ss[i % sessions]
    const id = hex(32, 50000 + i)
    const created = now - (answered + open - i) * 60000
    const options = [{ key: 'a', label: 'Variant A', detail: 'fast' }, { key: 'b', label: 'Variant B', detail: 'safe' }, ...(i % 3 ? [] : [{ key: 'c', label: 'Later', detail: '' }])]
    const content = { card_type: i % 11 === 0 ? 'info' : 'decision', title: `Question ${i + 1}: ${['Which variant to build?', 'Run the migration now?', 'Layout for the overview?', 'Renew the certificate?'][i % 4]}`, body: 'A short explanation of the question, two sentences long. More is in the conversation.', options: i % 11 === 0 ? [] : options, sections: null, html: null, allows_multiple: false, recommended: 'b', urgency_reason: '', attachments: [], change_note: '', close_summary: null, withdraw_reason: null, merged_into_object_id: null, merged_from_object_ids: null }
    const v1 = { object_version: 1, version_hash: hex(64, 9e5 + i), previous_version_hash: null, envelope_number: ++n, sent_at: created, object_state: 'open', urgency: i % 17 === 0 ? 'high' : 'normal', content }
    const versions = [v1]
    if (i % 4 === 0) versions.push({ ...v1, object_version: 2, version_hash: hex(64, 8e5 + i), previous_version_hash: v1.version_hash, envelope_number: ++n, sent_at: created + 1000, content: { ...content, body: `${content.body} (reworked)` } })
    const cur = versions.at(-1)
    const card = { object_id: id, agent_device_id: s.agent_device_id, first_envelope_number: v1.envelope_number, created_at: created, versions, answer: null, answers: [], closed_how: null, in_revision: null, timeline_key: `chat:card/${id}`, content_state: 'ok', ...cur.content, object_state: 'open', urgency: cur.urgency, object_version: cur.object_version, version_hash: cur.version_hash, envelope_number: cur.envelope_number, updated_at: cur.sent_at }
    if (!isOpen) {
      const a = { answer_action: content.card_type === 'info' ? 'read' : 'answer', choices: content.card_type === 'info' ? [] : ['a'], note: '', option_notes: {}, attachments: [], marks: [], trusted: false, bound_version_hash: cur.version_hash, bound_object_version: cur.object_version, envelope_number: ++n, envelope_hash: hex(64, 7e5 + i), by_device_id: me, answered_at: created + 5000, taken_back_at: null }
      Object.assign(card, { answer: a, answers: [a], object_state: 'closed', closed_how: a.answer_action === 'read' ? 'read' : 'answered' })
    }
    cards.push(card)
  }
  for (let i = 0; i < answered; i++) mk(i, false)
  for (let i = answered; i < answered + open; i++) mk(i, true)
  const timelines = {}
  for (let k = 0; k < messages; k++) {
    // A third into session 1's own thread (over 2,000 there), the rest spread over sessions and cards.
    const s = k % 3 === 0 ? ss[0] : ss[k % sessions]
    const card = k % 2 ? cards[(k * 7) % cards.length] : null
    const key = card ? `chat:card/${card.object_id}` : `chat:session/${s.agent_device_id}`
    const human = k % 4 === 0
    ;(timelines[key] ??= []).push({ envelope_number: ++n, local_id: null, pending: false, envelope_hash: hex(64, 6e6 + k), sender_device_id: human ? me : (card?.agent_device_id ?? s.agent_device_id), recipient_device_id: human ? (card?.agent_device_id ?? s.agent_device_id) : null, sent_at: now - (messages - k) * 1000, item_state: 'loaded', content_type: 'message', content: { text: human ? `Nachricht ${k}: bitte so machen.` : `Answer ${k}: **done**, the tests are running. Details in the log.` } })
  }
  const members = [{ device_id: me, device_role: 'human', device_name: 'Laptop', is_active: true, added_entry_number: 0, removed_entry_number: null, is_me: true, is_online: true }, ...ss.map((s, i) => ({ device_id: s.agent_device_id, device_role: 'agent', device_name: s.device_name, is_active: true, added_entry_number: i + 1, removed_entry_number: null, is_me: false, is_online: s.is_online, agent_session_id: s.agent_session_id }))]
  return {
    made_at: now, room: { room_id: hex(64, 2), hub_url: 'mock:', my_device_id: me, my_role: 'human', key_epoch: 1, last_entry_number: members.length - 1, last_envelope_number: n, connection: 'live' },
    members, sessions: ss, cards, permissions: [], notes: [], published: [], timelines,
    human: { drafts: {}, snoozes: {}, ducks: {}, crown: { agent_device_id: ss[0].agent_device_id }, desks: {}, session_settings: Object.fromEntries(ss.map(s => [s.agent_device_id, s.settings])) },
  }
}

// ---- All screens (demo only): /screens, a review page of every screen and state as live frames ----
// The Trommi menu shows "All screens" while the demo is on (sidebar.mjs); app.mjs adds this view only in the demo. A
// state that needs a click is driven by ?state=<name> on the frame's address (demoState, run once after the page is in).
// The screens that really exist: one per page of the app, each with its states beside it (a menu
// open, the selection, a toast, empty…) that switch the same pair of frames in place. The list is data, the same for
// every client: demo/data/screens.json in the repository (demo/README.md), which the build hands over as
// gen/vendor/demo-screens.mjs. A state there is { id, screen, state, web: { path, state, mock } } (path: the address;
// web.state: demoState's click; mock: a demo room); here [title, path, states, first state, room], a state
// [label, path, state, mock].
const SCREENS = []
for (const s of STATES) {
  const state = [s.state, s.web.path, s.web.state ?? '', s.web.mock]
  if (SCREENS.at(-1)?.[0] === s.screen) SCREENS.at(-1)[2].push(state)
  else SCREENS.push([s.screen, state[1], [], state[2], state[3]])
}
const frameSrc = (path, state, mock = '1') => `${path}${path.includes('?') ? '&' : '?'}mock=${mock || '1'}${state ? `&state=${state}` : ''}`
function screensMain() {
  // One screen: its title (opens it alone), its states as small buttons; the pair of frames shows the chosen one.
  const screen = ([title, path, states, first = '', base = '']) => {
    const all = [['As it is', path, first, base], ...states.map(([label, p, st, mock]) => [label, p || path, st ?? '', mock])]
    const src = frameSrc(path, first, base)
    const list = states.length ? `<div class="scr-states" role="group" aria-label="${title}: states">${all.map(([label], i) => `<button type="button" class="scr-state" data-action="screens#state" data-at="${i}"${i ? '' : ' aria-pressed="true"'}>${label}</button>`).join('')}</div>` : ''
    return `<figure class="scr-item" data-states='${JSON.stringify(all.map(([label, p, st, mock]) => ({ label, src: frameSrc(p, st, mock) }))).replace(/'/g, '&#39;')}'><figcaption><a href="${src}" target="_blank" rel="noopener" class="scr-title">${title}</a> <code>${path}</code></figcaption><div class="scr-row"><div class="scr-pair"><div class="scr-box is-wide"><iframe data-src="${src}" title="${title}, desktop" loading="lazy" width="1440" height="900" tabindex="-1"></iframe></div><div class="scr-box is-phone"><iframe data-src="${src}" title="${title}, phone" loading="lazy" width="390" height="844" tabindex="-1"></iframe></div></div>${list}</div></figure>`
  }
  return `<main id="screens" class="scr-page" data-controller="screens"><link rel="stylesheet" href="/demo/screens.css"><header class="scr-head"><h1>All screens</h1><p>Every screen once, its states beside it; a title opens it alone.</p><button type="button" class="scr-theme is-tour" data-action="screens#tour">▶ Play tour</button><button type="button" class="scr-theme" data-action="screens#eager" title="Load every frame now, for scrolling through all of them">Load all</button><button type="button" class="scr-theme" data-action="screens#theme">Light / dark</button></header>
<div class="scr-grid">${SCREENS.length ? SCREENS.map(screen).join('') : '<p class="scr-none">No screens are listed (demo/data/screens.json has no states).</p>'}</div></main>`
}
export const screensView = { register(t) { t.get(/^\/screens$/, ({ req, res }) => t.page(req, res, { title: 'All screens · Trommi', view: 'screens', sidebar: false, stream: null, main: screensMain() })) } }

/** Frames load as they come into view; the page's light/dark goes into every frame. */
export function screensController({ Controller, controller }) {
  controller('screens', class extends Controller {
    connect() {
      this.dark = document.documentElement.dataset.theme === 'dark'
      this.io = new IntersectionObserver(es => { for (const e of es) if (e.isIntersecting) { const f = e.target; f.src = f.dataset.src; f.addEventListener('load', () => this.paint(f)); this.io.unobserve(f) } }, { rootMargin: '400px' })
      for (const f of this.element.querySelectorAll('iframe[data-src]')) this.io.observe(f)
      if (new URLSearchParams(location.search).get('tour') === '1') requestAnimationFrame(() => this.tour())
      this.ro = new ResizeObserver(() => this.layout())
      this.ro.observe(this.element)
      this.layout()
    }
    disconnect() { this.io?.disconnect(); this.ro?.disconnect(); this.endTour() }
    // The whole width: the pair of frames as large as the row allows (never above its real size), the states at the far
    // right in as few columns as keep their list no taller than the frames. A narrow window: the frames stacked, the
    // states a wrapping grid under them (screens.css).
    layout() {
      const W = this.element.clientWidth - 2 * parseFloat(getComputedStyle(this.element).paddingLeft || '0')
      if (!(W > 0) || W === this.laidOut) return
      this.laidOut = W
      const narrow = W < 860, COL = 196, GAP = 6, ROW = 30, PAIR = 1440 + 390 + 12
      for (const item of this.element.querySelectorAll('.scr-item')) {
        const n = item.querySelectorAll('.scr-state').length
        let cols = n ? 1 : 0, s = Math.min(1, W / 1440), p = Math.min(.6, W / 390)
        if (!narrow) {
          const fit = k => Math.min(1, (W - (k ? k * COL + (k - 1) * GAP + 20 : 0)) / PAIR)
          while (n && cols < 4 && Math.ceil(n / cols) * ROW > 900 * fit(cols)) cols++
          s = p = fit(cols)
        }
        item.style.setProperty('--s', s.toFixed(4)); item.style.setProperty('--p', p.toFixed(4)); item.style.setProperty('--cols', String(cols || 1)); item.style.setProperty('--rows', String(Math.ceil(n / (cols || 1)) || 1))
      }
      this.element.classList.toggle('is-narrow', narrow)
    }
    // A state of a screen: the same pair of frames shows it
    state(e) {
      const b = e.currentTarget, item = b.closest('.scr-item'), st = JSON.parse(item.dataset.states)[Number(b.dataset.at)]
      for (const x of item.querySelectorAll('.scr-state')) x.setAttribute('aria-pressed', String(x === b))
      const url = new URL(st.src, location.origin), q = url.searchParams, mock = q.get('mock') || '1', name = q.get('state') || ''
      q.delete('mock'); q.delete('state')
      const path = url.pathname + (q.toString() ? `?${q}` : '')
      const t0 = performance.now()
      for (const f of item.querySelectorAll('iframe')) {
        const w = f.contentWindow, app = f.src && (() => { try { return w.trommi } catch { return null } })()
        if (app?.router?.forget && (f.dataset.mock || '1') === mock) {
          // the same demo room: the frame's own router paints the page anew and its click is made in place (no reload)
          f.dataset.src = st.src
          try { w.document.querySelectorAll('#says-host > *').forEach(n => n.remove()) } catch {}
          app.router.forget()
          Promise.resolve(app.router.visit(path, { action: 'replace' })).then(() => app.demoState?.(name, { now: true })).then(() => { item.dataset.took = String(Math.round(performance.now() - t0)); this.paint(f) })
        } else {
          this.io.unobserve(f); f.dataset.src = st.src; f.dataset.mock = mock; f.src = st.src
          f.addEventListener('load', () => { this.paint(f); item.dataset.took = String(Math.round(performance.now() - t0)) }, { once: true })
        }
      }
      item.querySelector('.scr-title').href = st.src
    }
    // Load every frame now (for scrolling through all of them)
    eager() { for (const f of this.element.querySelectorAll('iframe[data-src]:not([src])')) { this.io.unobserve(f); f.src = f.dataset.src; f.addEventListener('load', () => this.paint(f)) } }
    // ---- the tour: one screen at a time at its real size, desktop then phone, held a while once it is in ----
    stops() {
      // every screen, and within it each of its states
      const out = []
      for (const el of this.element.querySelectorAll('.scr-item')) {
        const group = el.querySelector('.scr-title').textContent
        for (const st of JSON.parse(el.dataset.states)) out.push({ group, name: st.label, src: st.src })
      }
      return out
    }
    tour() {
      if (this.box) return
      this.list = this.stops(); this.at = 0; this.playing = true; this.hold = 4000
      if (!this.list.length) return
      const box = this.box = document.createElement('div')
      box.className = 'tour'
      box.innerHTML = '<div class="tour-stage"></div><div class="tour-bar" role="toolbar" aria-label="Tour"><button type="button" class="tour-play">Pause</button><button type="button" class="tour-prev" title="The one before (←)">←</button><button type="button" class="tour-next" title="The next (→)">→</button><select class="tour-speed" aria-label="How long each screen stands"><option value="2000">2 s</option><option value="4000" selected>4 s</option><option value="8000">8 s</option></select><span class="tour-where"></span><span class="tour-wait"></span><button type="button" class="tour-close" title="Back to the grid (Esc)">Close</button></div>'
      document.body.append(box)
      const q = s => box.querySelector(s)
      q('.tour-play').addEventListener('click', () => this.toggle())
      q('.tour-prev').addEventListener('click', () => this.go(this.at - 1))
      q('.tour-next').addEventListener('click', () => this.go(this.at + 1))
      q('.tour-speed').addEventListener('change', e => { this.hold = Number(e.target.value); this.arm() })
      q('.tour-close').addEventListener('click', () => this.endTour())
      this.keys = e => {
        if (e.key === ' ') { e.preventDefault(); this.toggle() } else if (e.key === 'ArrowRight') { e.preventDefault(); this.go(this.at + 1) } else if (e.key === 'ArrowLeft') { e.preventDefault(); this.go(this.at - 1) } else if (e.key === 'Escape') { e.preventDefault(); this.endTour() }
      }
      addEventListener('keydown', this.keys, true)
      this.go(0)
    }
    toggle() { this.playing = !this.playing; this.box.querySelector('.tour-play').textContent = this.playing ? 'Pause' : 'Play'; this.arm() }
    endTour() { clearTimeout(this.timer); if (this.keys) removeEventListener('keydown', this.keys, true); this.box?.remove(); this.box = null }
    go(i) {
      if (!this.box) return
      this.at = (i + this.list.length) % this.list.length
      const s = this.list[this.at], stage = this.box.querySelector('.tour-stage')
      clearTimeout(this.timer); this.ready = false
      // one step: the screen at a desktop's size on the left and at a phone's on the right, both at their real size
      const frame = cls => { const f = document.createElement('iframe'); f.className = cls; f.tabIndex = -1; f.style.pointerEvents = 'none'; f.title = `${s.name}${cls === 'is-phone' ? ', phone' : ''}`; return f }
      const wide = frame('is-wide'), phone = frame('is-phone')
      const loaded = f => new Promise(done => f.addEventListener('load', async () => {
        this.paint(f)
        await new Promise(r => setTimeout(r, 1300))   // (the frame's own state click, demoState, waits 500 ms)
        // the pictures in view decoded (a lazy one below the fold never comes: at most 3 s)
        try {
          const vh = f.contentWindow.innerHeight
          const shown = [...f.contentDocument.images].filter(im => { const r = im.getBoundingClientRect(); return r.width && r.top < vh && r.bottom > 0 })
          await Promise.race([Promise.all(shown.map(im => (im.complete ? (im.decode?.() ?? Promise.resolve()) : new Promise(r => { im.addEventListener('load', r, { once: true }); im.addEventListener('error', r, { once: true }) })).catch(() => {}))), new Promise(r => setTimeout(r, 3000))])
        } catch {}
        done()
      }, { once: true }))
      const both = Promise.all([loaded(wide), loaded(phone)])
      wide.src = s.src; phone.src = s.src
      // The next pair loads in a layer of its own over the one in view, unseen (opacity 0); the old pair stays until the
      // new one is in, then the new layer fades in (140 ms) and the old goes: never an empty or white stage between two.
      // A step not yet in when the next is asked for is dropped.
      const layer = document.createElement('div')
      layer.className = 'tour-layer is-next'; layer.append(wide, phone)
      for (const l of stage.querySelectorAll('.tour-layer.is-next')) l.remove()
      stage.append(layer)
      const at = this.at
      both.then(() => {
        if (!this.box || this.at !== at || !layer.isConnected) return
        const old = [...stage.querySelectorAll('.tour-layer:not(.is-next)')]
        layer.classList.remove('is-next')
        setTimeout(() => old.forEach(l => l.remove()), 160)
        this.ready = true; this.arm()
      })
      this.box.querySelector('.tour-where').innerHTML = `<b>${this.at + 1} / ${this.list.length}</b> · ${s.group} · ${s.name}`
      this.box.querySelector('.tour-wait').textContent = 'loading…'
    }
    arm() {
      clearTimeout(this.timer)
      if (!this.box) return
      this.box.querySelector('.tour-wait').textContent = this.ready ? (this.playing ? '' : 'paused') : 'loading…'
      if (this.playing && this.ready) this.timer = setTimeout(() => this.go(this.at + 1), this.hold)
    }
    paint(f) { try { const d = f.contentDocument?.documentElement; if (!d) return; if (this.dark) d.dataset.theme = 'dark'; else delete d.dataset.theme } catch {} }
    theme() {
      this.dark = !this.dark
      if (this.dark) document.documentElement.dataset.theme = 'dark'; else delete document.documentElement.dataset.theme
      for (const f of this.element.querySelectorAll('iframe[src]')) this.paint(f)
    }
  })
}

/** ?state=<name> on a demo page: the click a state needs, done once the page is in (only in the demo). */
export async function demoState(name, { now = false } = {}) {
  const $ = s => document.querySelector(s), wait = ms => new Promise(r => setTimeout(r, ms)), click = s => { const el = $(s); el?.click(); return Boolean(el) }
  if (!name) return
  await wait(now ? 60 : 500)
  const S = {
    select: async () => { for (const b of [...document.querySelectorAll('#desk-list .inbox-row .row-mark')].slice(1, 3)) { b.click(); await wait(150) } },
    duck: () => click('.desk-duck-open'),
    toast: () => click('#desk-list .inbox-row .inbox-answer.is-thumb.is-lead:not(.is-ack)'),
    bottom: () => { const m = $('#inbox'); if (m) m.scrollTop = m.scrollHeight },
    menu: () => click('#brand-menu'),
    switch: async () => { document.documentElement.dataset.rail = 'folded'; await new Promise(r => setTimeout(r, 300)); click('.rail-tag') },
    rail: () => { document.documentElement.dataset.rail = 'folded'; dispatchEvent(new Event('resize')) },
    'phone-note': () => click('.tab[data-tab="note"]'),
    keys: () => document.dispatchEvent(new Event('trommi:keys')),
    note: () => click('.corner-note-head'),
    inside: () => { const l = $('.tc-card > .tc-left'); if (l) l.scrollTop = 900 },
    strip: () => { const m = $('#cardpage'); if (m) m.scrollTop = 2600 },
    more: () => click('.tc-more-open'),
    'with-agent': () => { const c = window.trommi.model().cards.find(x => x.with_agent); if (c) window.trommi.router.visit(`/card/${c.number}`) },
    'session-more': () => click('.t-head-more'),
    trail: () => { const d = $('.msg-work details.work'); if (d) { d.open = true; d.scrollIntoView({ block: 'center' }) } },
    pair: () => click('#settings-pair'),
    'pair-emoji': () => click('#settings-pair'),   // (the demo's new device answers after a moment: the six emoji come in place)
    'desk-open': () => click('#ledger-list details.set-desk > summary'),
    'session-dots': async () => { click('#ledger-list details.set-desk > summary'); await wait(150); click('#ledger-list .ledger-menu') },
    invite: () => click('#settings-invite-agent'),
    'desk-invite': () => click('#desk-invite-go'),
    'invite-emoji': async () => { click('.t-head-more'); await wait(200); [...document.querySelectorAll('.desk-move button')].find(b => /invite link/.test(b.textContent))?.click() },
    'invite-ended': async () => { click('#settings-invite-agent'); await wait(900); const inv = [...window.trommi.client.model.invites.values()].at(-1); if (inv) { inv.expires_at = Date.now() - 1000; window.trommi.client.changed(c => c.invites.add(inv.invite_id)) } },
    share: async () => { click('#artifacts-list .shr-copy'); await wait(400); const d = $('#artifacts-list .shr.is-on details'); if (d) d.open = true },
    'board-help': () => click('#help-btn'),
  }
  await S[name]?.()
}
