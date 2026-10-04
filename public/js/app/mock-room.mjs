// The mock room: the client core's API and model shape (client/core/README.md in trommi-hub), without a hub and
// without crypto, fed from public/mock/fixture.json (dev/make-fixture.mjs) or generated big (?mock=crazy). Used with
// ?mock=1 for UI work and the screen-by-screen comparison with today's board; the real core is the default.
// Agents are simulated: they reply to messages, rework a card that was handed back, explain on "What??".

const ZERO = () => ({ cards: new Set(), sessions: new Set(), permissions: new Set(), memos: new Set(), published: new Set(), timelines: new Set(), registers: new Set(), members: false, invites: new Set(), alerts: false, outbox: false, stack: false, room: false })
const URG = { critical: 0, high: 1, normal: 2, low: 3 }
const hex = n => [...crypto.getRandomValues(new Uint8Array(n / 2))].map(b => b.toString(16).padStart(2, '0')).join('')
const toMap = obj => new Map(Object.entries(obj ?? {}))

class MockClient {
  constructor(fixture, { simulate = true } = {}) {
    this.listeners = new Map()
    this.simulate = simulate
    this.store = new Map()          // timeline_key -> every item, oldest first (stands in for storage + hub)
    const f = fixture
    const sessions = new Map(f.sessions.map(s => [s.agent_device_id, { ...s, agent_alerts: [], registers: new Map(), read_up_to: 0, card_ids: [], open_card_ids: [], timeline_key: `chat:session/${s.agent_device_id}`, unread_count: 0, last_activity_at: 0 }]))
    this.model = {
      room: { ...f.room },
      members: new Map(f.members.map(m => [m.device_id, { ...m }])),
      sessions,
      cards: new Map(f.cards.map(c => [c.object_id, c])),
      permissions: new Map((f.permissions ?? []).map(p => [p.object_id, p])),
      memos: new Map((f.memos ?? []).map(m => [m.object_id, m])),
      published: new Map((f.published ?? []).map(p => [p.object_id, p])),
      timelines: new Map(),
      human: {
        drafts: toMap(f.human.drafts), snoozes: toMap(f.human.snoozes), ducks: toMap(f.human.ducks), crown: f.human.crown ?? null,
        desks: toMap(f.human.desks), session_settings: toMap(f.human.session_settings), read_up_to: toMap(f.human.read_up_to), canvas_snapshots: new Map(), raw: new Map(),
      },
      invites: new Map(), alerts: [], outbox: [], stack: [], open_permission_ids: [],
    }
    this.model.room.has_passphrase ??= false
    for (const m of this.model.members.values()) m.fingerprint ??= m.device_id.slice(0, 16).match(/.{4}/g).join(' ')
    for (const [key, items] of Object.entries(f.timelines ?? {})) this.store.set(key, items)
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
      t = { timeline_key: key, timeline_kind: kind, timeline_id: id, object_id: id.split('/')[1], item_count: 0, newest_envelope_number: 0, items: new Map(), loaded_down_to: Infinity, has_more: false }
      this.model.timelines.set(key, t)
    }
    return t
  }
  on(event, fn) { if (!this.listeners.has(event)) this.listeners.set(event, new Set()); this.listeners.get(event).add(fn); return () => this.listeners.get(event).delete(fn) }
  emit(event, value) { for (const fn of this.listeners.get(event) ?? []) { try { fn(value) } catch (err) { console.error(err) } } }
  changed(fill) { const c = ZERO(); fill(c); this.project(c); this.emit('change', c) }
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
  async timelineWindow(key, { before_envelope_number = Infinity, limit = 50 } = {}) {
    return (this.store.get(key) ?? []).filter(i => i.envelope_number < before_envelope_number).slice(-limit)
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
  async sendMessage({ agent_device_id, object_id = null, ...content }) {
    const key = object_id ? `chat:card/${object_id}` : `chat:session/${agent_device_id}`
    const to = agent_device_id ?? this.sessionOfCard(object_id)
    const item = { envelope_number: null, local_id: `l-${hex(8)}`, pending: true, envelope_hash: null, sender_device_id: this.model.room.my_device_id, recipient_device_id: to, sent_at: Date.now(), item_state: 'loaded', content_type: 'message', content }
    this.changed(c => {
      this.addItem(key, item, c)
      const card = object_id && this.model.cards.get(object_id)
      if (card && card.object_state === 'open' && (content.hand_back || content.explain)) { card.in_revision = { by: content.hand_back ? 'hand_back' : 'explain', envelope_number: this.model.room.last_envelope_number + 1 }; c.cards.add(object_id); c.stack = true }
      if (card && content.present_card === false) { card.in_revision = null; c.cards.add(object_id) }
    })
    setTimeout(() => this.confirm(key, item), 60)
    if (this.simulate) this.agentAnswers(to, object_id, content)
  }
  answerWith(object_id, fields) {
    const card = this.model.cards.get(object_id)
    if (!card) throw Object.assign(new Error('unknown card'), { code: 'not-found' })
    if (card.object_state !== 'open') throw Object.assign(new Error('card already decided'), { code: 'bad-argument' })
    const answer = { answer_action: 'answer', choices: [], note: '', option_notes: {}, attachments: [], marks: [], trusted: false, ...fields, bound_version_hash: card.version_hash, bound_object_version: card.object_version, envelope_number: this.next(), envelope_hash: hex(64), by_device_id: this.model.room.my_device_id, answered_at: Date.now(), taken_back_at: null }
    this.changed(c => {
      card.answer = answer; card.answers.push(answer)
      card.object_state = answer.answer_action === 'answer' ? 'answered' : 'closed'
      card.closed_how = answer.answer_action === 'shred' ? 'shredded' : answer.answer_action === 'read' ? 'read' : 'answered'
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
    this.changed(c => { card.answer.taken_back_at = this.next(); card.answer = null; card.object_state = 'open'; card.closed_how = null; c.cards.add(object_id); c.stack = true })
  }
  async verdict({ object_id, allow }) {
    const p = this.model.permissions.get(object_id)
    this.changed(c => { p.permission_state = allow ? 'allowed' : 'denied'; p.verdict = { allow, by_device_id: this.model.room.my_device_id, envelope_number: this.next() }; c.permissions.add(object_id); c.stack = true })
  }
  async setRegisters(values) {
    const h = this.model.human
    const MAPS = { draft: h.drafts, snooze: h.snoozes, duck: h.ducks, desk: h.desks, session: h.session_settings, read_up_to: h.read_up_to }
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
  setSessionSettings(id, v) { return this.setRegisters({ [`session/${id}`]: v }) }
  markReadUpTo(id, n) { return this.setRegisters({ [`read_up_to/${id}`]: n }) }
  async saveMemo({ object_id = hex(32), ...fields }) {
    const had = this.model.memos.get(object_id)
    const memo = { object_id, by_device_id: this.model.room.my_device_id, text: '', x: 0, y: 0, color: null, desk_id: 'main', ...had, ...fields, object_version: (had?.object_version ?? 0) + 1, version_hash: hex(64), envelope_number: this.next(), object_state: fields.object_state ?? had?.object_state ?? 'open' }
    this.changed(c => { this.model.memos.set(object_id, memo); c.memos.add(object_id) })
    return object_id
  }
  async uploadAttachment(bytes, meta) {
    const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: meta.media_type })
    return { attachment_id: hex(32), file_key: '', sha256: '', total_size: blob.size, ...meta, url: URL.createObjectURL(blob) }
  }
  async attachmentBlob(ref) { return (await fetch(ref.url)).blob() }
  async fetchAttachment(ref) { return new Uint8Array(await (await this.attachmentBlob(ref)).arrayBuffer()) }

  // ---- membership (mock: an invite that is joined by a pretend phone after a moment) ----
  async createInvite({ device_role = 'human', app_url = `${location.origin}/join` } = {}) {
    const invite_id = hex(32)
    const invite = { invite_id, device_role, link: `${app_url}#v1.mock.${this.model.room.room_id.slice(0, 16)}.${hex(32)}`, expires_at: Date.now() + 600000, invite_state: 'open', newcomer: null, error: null, check_code: String(100000 + Math.floor(Math.random() * 900000)) }
    this.changed(c => { this.model.invites.set(invite_id, invite); c.invites.add(invite_id) })
    setTimeout(() => this.changed(c => {
      invite.newcomer = { device_id: hex(64), device_name: device_role === 'agent' ? 'claude-session' : 'Phone (new)' }
      invite.invite_state = device_role === 'agent' ? 'adding' : 'confirm_code'
      if (device_role !== 'agent') { const six = () => String(100000 + Math.floor(Math.random() * 900000)); invite.code_choices = [invite.check_code, six(), six(), six()].sort(() => Math.random() - 0.5) }
      c.invites.add(invite_id)
      if (device_role === 'agent') setTimeout(() => this.addMember(invite), 400)
    }), 2500)
    return invite
  }
  async confirmInvite(invite_id, code) {
    const invite = this.model.invites.get(invite_id)
    if (code !== invite.check_code) { this.changed(c => { invite.invite_state = 'failed'; invite.error = 'bad-code'; c.invites.add(invite_id) }); throw Object.assign(new Error('the check code does not match; the invite is burnt'), { code: 'bad-code' }) }
    this.addMember(invite)
  }
  addMember(invite) {
    this.changed(c => {
      invite.invite_state = 'joined'; c.invites.add(invite.invite_id)
      const m = { device_id: invite.newcomer.device_id, device_role: invite.device_role, device_name: invite.newcomer.device_name, is_active: true, added_entry_number: ++this.model.room.last_entry_number, removed_entry_number: null, is_me: false, is_online: true }
      m.fingerprint = m.device_id.slice(0, 16).match(/.{4}/g).join(' ')
      this.model.members.set(m.device_id, m); c.members = true
    })
  }
  // Password sign-in (escrow), storage use, handing a session to an agent: shaped like the core, nothing behind them.
  async setPassphrase(p) {
    if (String(p).length < 14) throw Object.assign(new Error('weak passphrase'), { code: 'weak-passphrase' })
    await new Promise(r => setTimeout(r, 600))
    this.changed(c => { this.model.room.has_passphrase = true; c.room = true })
  }
  async removePassphrase() { await new Promise(r => setTimeout(r, 300)); this.changed(c => { this.model.room.has_passphrase = false; c.room = true }) }
  async usage() { return { bytes: 48_300_000, limit_bytes: 1_000_000_000 } }
  async assignSession() {}
  async removeDevices(ids) {
    this.changed(c => {
      const entry = ++this.model.room.last_entry_number
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
      this.addItem(key, { envelope_number: this.next(), local_id: null, pending: false, envelope_hash: hex(64), sender_device_id: agent, recipient_device_id: null, sent_at: Date.now(), item_state: 'loaded', content_type: 'message', content: body }, c)
      s.last_activity_at = Date.now(); c.sessions.add(agent)
      after?.(c)
    }), ms)
    if (content.explain) return say(1500, { text: 'Kurz erklärt: Es geht darum, welche Variante ich baue. Jede Option ändert nur einen Teil; meine Empfehlung steht auf der Karte.' })
    if (content.hand_back) {
      const card = this.model.cards.get(object_id)
      return say(1200, { text: 'Verstanden, ich überarbeite die Karte.' }, () => setTimeout(() => this.revise(card, content.text), 1500))
    }
    if (content.present_card === false) return
    say(900 + Math.random() * 800, { text: `Verstanden${content.text ? `: „${String(content.text).slice(0, 60)}“` : ''}. Ich mache weiter.` })
  }
  revise(card, why) {
    if (!card || card.object_state !== 'open') return
    this.changed(c => {
      const n = this.next(), hash = hex(64)
      const content = { ...card.versions.at(-1).content, change_note: `Überarbeitet: ${String(why ?? '').slice(0, 80)}`, body: `${card.body}\n\n(Überarbeitet nach deiner Rückgabe.)` }
      card.versions.push({ object_version: card.object_version + 1, version_hash: hash, previous_version_hash: card.version_hash, envelope_number: n, sent_at: Date.now(), object_state: 'open', urgency: card.urgency, content })
      Object.assign(card, content, { object_version: card.object_version + 1, version_hash: hash, envelope_number: n, updated_at: Date.now(), in_revision: null })
      c.cards.add(card.object_id); c.stack = true
    })
  }
}

let fixtureCache
async function loadFixture(kind) {
  if (kind === 'crazy') return (await import('./mock-crazy.mjs')).crazyFixture()
  fixtureCache ??= await (await fetch('/mock/fixture.json')).json()
  return structuredClone(fixtureCache)
}
export async function openRoom({ mock = '1' } = {}) { return new MockClient(await loadFixture(mock)) }
export async function foundRoom({ device_name = 'Laptop' } = {}) {
  const client = new MockClient(await loadFixture('1'))
  client.model.members.get(client.model.room.my_device_id).device_name = device_name
  const code = Array.from({ length: 13 }, () => hex(4).toUpperCase()).join('').replace(/[ILOU]/g, 'X').match(/.{4}/g).slice(0, 13).join('-')
  return { client, recovery_code: code }
}
export async function joinRoom() {
  let reveal
  const check_code = new Promise(r => { reveal = r })
  setTimeout(() => reveal(String(100000 + Math.floor(Math.random() * 900000))), 1500)
  return { check_code, client: check_code.then(() => new Promise(r => setTimeout(async () => r(new MockClient(await loadFixture('1'))), 4000))) }
}
export { MockClient }
