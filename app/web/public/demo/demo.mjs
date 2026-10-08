// The mock room: the client core's API and model shape (core/README.md in trommi-hub), without a hub and
// without crypto, fed from public/demo/fixture.json (dev/make-fixture.mjs) or generated big (?mock=crazy); ?mock=side is the fixture with a full sidebar, ?mock=quiet a small Desk with final answers. Used with
// ?mock=1 for UI work and the screen-by-screen comparison with today's board; the real core is the default.
// Agents are simulated: they reply to messages, rework a card that was handed back, explain on "What??".

const ZERO = () => ({ cards: new Set(), sessions: new Set(), permissions: new Set(), notes: new Set(), published: new Set(), timelines: new Set(), registers: new Set(), members: false, invites: new Set(), alerts: false, outbox: false, stack: false, room: false })
const URG = { critical: 0, high: 1, normal: 2, low: 3 }
const hex = n => [...crypto.getRandomValues(new Uint8Array(n / 2))].map(b => b.toString(16).padStart(2, '0')).join('')
const toMap = obj => new Map(Object.entries(obj ?? {}))

class MockClient {
  constructor(fixture, { simulate = true } = {}) {
    this.listeners = new Map()
    this.simulate = simulate
    this.store = new Map()          // timeline_key -> every item, oldest first (stands in for storage + hub)
    const f = fixture
    const sessions = new Map(f.sessions.map(s => [s.agent_device_id, { ...s, agent_alerts: [], registers: new Map(), card_ids: [], open_card_ids: [], timeline_key: `chat:session/${s.agent_device_id}`, last_activity_at: 0 }]))
    this.model = {
      room: { ...f.room },
      members: new Map(f.members.map(m => [m.device_id, { ...m }])),
      sessions,
      cards: new Map(f.cards.map(c => [c.object_id, c])),
      permissions: new Map((f.permissions ?? []).map(p => [p.object_id, p])),
      notes: new Map((f.notes ?? []).map(m => [m.object_id, m])),
      published: new Map((f.published ?? []).map(p => [p.object_id, p])),
      timelines: new Map(),
      human: {
        drafts: toMap(f.human.drafts), snoozes: toMap(f.human.snoozes), ducks: toMap(f.human.ducks), crown: f.human.crown ?? null,
        desks: toMap(f.human.desks), session_settings: toMap(f.human.session_settings), scribble_snapshots: new Map(), raw: new Map(),
      },
      invites: new Map(), alerts: [], outbox: [], stack: [], open_permission_ids: [],
    }
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
  async sendMessage({ agent_device_id, object_id = null, ...content }) {
    const key = object_id ? `chat:card/${object_id}` : `chat:session/${agent_device_id}`
    const to = agent_device_id ?? this.sessionOfCard(object_id)
    const item = { envelope_number: null, local_id: `l-${hex(8)}`, pending: true, envelope_hash: null, sender_device_id: this.model.room.my_device_id, recipient_device_id: to, sent_at: Date.now(), item_state: 'loaded', content_type: 'message', content }
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
    const answer = { answer_action: 'answer', choices: [], note: '', option_notes: {}, attachments: [], marks: [], trusted: false, ...fields, bound_version_hash: card.version_hash, bound_object_version: card.object_version, envelope_number: this.next(), envelope_hash: hex(64), by_device_id: this.model.room.my_device_id, answered_at: Date.now(), taken_back_at: null }
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
    const note = { object_id, by_device_id: this.model.room.my_device_id, text: '', ...had, ...fields, object_version: (had?.object_version ?? 0) + 1, version_hash: hex(64), envelope_number: this.next(), object_state: fields.object_state ?? had?.object_state ?? 'open' }
    this.changed(c => { this.model.notes.set(object_id, note); c.notes.add(object_id) })
    return object_id
  }
  async uploadAttachment(bytes, meta) {
    const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: meta.media_type })
    return { attachment_id: hex(32), file_key: '', sha256: '', total_size: blob.size, ...meta, url: URL.createObjectURL(blob) }
  }
  async attachmentBlob(ref) { return (await fetch(ref.url)).blob() }
  // Share links (the Links page): kept in this tab, the form of the real link (the mock has no keys: stand-ins).
  async shareAttachment(ref, { expires_at = Date.now() + 30 * 86400000 - 60000, app_url = location.origin, keep_link = false } = {}) {
    const b64 = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const share_id = hex(32), link = `${app_url}/a/${share_id}#${b64()}.${ref.file_key || b64()}.${ref.sha256 || b64()}`
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
      // the core's format: six numbers 0–63, shown as emoji (shared/check-emoji.mjs)
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
      const m = { device_id: invite.newcomer.device_id, device_role: invite.device_role, device_name: invite.newcomer.device_name, is_active: true, added_entry_number: ++this.model.room.last_entry_number, removed_entry_number: null, is_me: false, is_online: true }
      m.fingerprint = m.device_id.slice(0, 16).match(/.{4}/g).join(' ')
      this.model.members.set(m.device_id, m); c.members = true
    })
  }
  // Storage use, handing a session to an agent: shaped like the core, nothing behind them.
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

// Cards he put away, so the pile "Off the desk" holds a card of every place (desk.mjs): two snoozed, one
// handed back, one answered a moment ago (its session is still at it), one shredded. Times relative to now.
function putAway(f) {
  const now = Date.now(), MIN = 60e3, [zu, ui, , cr] = f.sessions.map(s => s.agent_device_id)
  const me = f.room.my_device_id
  let env = 9000
  const mk = (title, agent, ago, how) => {
    const id = hex(32), at = now - ago * MIN, n = ++env, version_hash = hex(64)
    const content = { card_type: 'decision', title, body: '', options: [{ key: 'a', label: 'Yes', detail: '' }, { key: 'b', label: 'No', detail: '' }], sections: null, html: null, allows_multiple: false, recommended: null, urgency_reason: '', attachments: [], change_note: '', close_summary: null, withdraw_reason: null, merged_into_object_id: null, merged_from_object_ids: null }
    const c = { object_id: id, agent_device_id: agent, first_envelope_number: n, created_at: at - 30 * MIN, answers: [], answer: null, closed_how: null, in_revision: null, timeline_key: `chat:card/${id}`, content_state: 'ok', object_version: 1, version_hash, envelope_number: n, updated_at: at, urgency: 'normal', object_state: 'open', ...content,
      versions: [{ object_version: 1, version_hash, previous_version_hash: null, envelope_number: n, sent_at: at - 30 * MIN, object_state: 'open', urgency: 'normal', content }] }
    const answer = action => ({ answer_action: action, choices: action === 'answer' ? ['a'] : [], note: '', option_notes: {}, attachments: [], marks: [], trusted: false, bound_version_hash: version_hash, bound_object_version: 1, envelope_number: n, envelope_hash: hex(64), by_device_id: me, answered_at: at, taken_back_at: null })
    if (how === 'snooze') (f.human.snoozes ??= {})[id] = { until: now + 4 * 60 * MIN, at }
    else if (how === 'revise') c.in_revision = { by: 'hand_back', envelope_number: n }
    else if (how === 'answer') Object.assign(c, { answer: answer('answer'), object_state: 'answered', closed_how: 'answered' })
    else if (how === 'shred') Object.assign(c, { answer: answer('shred'), object_state: 'closed', closed_how: 'shredded' })
    else if (how?.done) Object.assign(c, { answer: answer('answer'), object_state: 'closed', closed_how: 'closed', close_summary: how.done, updated_at: at })   // finished by its agent: a Done row
    if (c.answer) c.answers = [c.answer]
    f.cards.push(c)
  }
  mk('Tab bar at the bottom or at the top?', ui, 4, 'answer')
  mk('Write the release notes today?', zu, 18, 'snooze')
  mk('Delete the old test data?', cr, 35, 'shred')
  mk('Icon set: our own strokes or Lucide?', ui, 52, 'revise')
  mk('Backup at 3 at night?', zu, 95, 'snooze')
  mk('Ship the new invite page?', ui, 9, { done: 'Live: the invite page is on app.trommi.com, old links redirect.' })
  mk('Rotate the push keys tonight?', cr, 26, { done: 'Done: keys rotated on all 3 devices, no notification lost.' })
  return f
}

// More to play with (his wish, 4 October): simple yes/no questions, some with advice, a few with a line of context or
// pictures, spread over the sessions, mostly not urgent; and a few infos. Demo data only.
function filler(f) {
  const now = Date.now(), MIN = 60e3, [zu, ui, docs, cr] = f.sessions.map(s => s.agent_device_id)
  // (the demo's desk has a real name, his word 4 October: "Web App 3")
  // (one note: the demo keeps the newest of its notes)
  if (f.notes?.length) f.notes = [[...f.notes].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))[0]]
  for (const d of Object.values(f.human?.desks ?? {})) if (d.name === 'Desk') d.name = 'Web App 3'
  // (two knocks and one blocking card on the first desk: the board on the phone, the parallel tests; the migration blocks)
  // Teasers: what the agent says on the Desk in two lines (the card's own field, core FIELDS.card.teaser).
  const TEASE = {
    'Production is down: roll back now?': 'Since 12:04 the API returns 502. Rolling back takes two minutes; the old build is still warm.',
    'How should the board open on a phone?': 'A phone holds only one view. I would open with the Desk, not with the conversation.',
    'The certificate expires in 2 days. Renew now?': 'After that every browser warns. The renewal runs by itself; it only needs your yes.',
    'Which default theme?': 'Both themes are done. I only need the default for new users.',
    'Run the migration on the production database?': 'Adds a column and backfills 48,210 rows, about 40 seconds, no downtime.',
    'What do I build next?': 'Three ways are ready: search, sharing, or finishing the phone view.',
  }
  for (const c of f.cards) if (TEASE[c.title]) { c.teaser = TEASE[c.title]; for (const v of c.versions ?? []) if (v.content) v.content.teaser = TEASE[c.title] }
  let env = 9500
  const SHOWN = { 'thema-dunkel.png': 'theme-dark.png', 'thema-hell.png': 'theme-light.png', 'phone-entscheidungen.png': 'phone-decisions.png', 'phone-gespraech.png': 'phone-conversation.png' }   // (the files' names as shown)
  const pic = name => ({ attachment_id: hex(32), file_key: '', sha256: '', file_name: SHOWN[name] ?? name, media_type: name.endsWith('.webm') ? 'video/webm' : 'image/png', total_size: 0, url: `/demo/files/${name}` })
  const YN = [{ key: 'ja', label: 'Yes', detail: '' }, { key: 'nein', label: 'No', detail: '' }]
  const mk = (title, agent, ago, { body = '', teaser = null, type = 'decision', options = YN, recommended = null, urgency = 'normal', files = [] } = {}) => {
    const id = hex(32), at = now - ago * MIN, n = ++env, version_hash = hex(64)
    const content = { card_type: type, title, teaser, body, options: type === 'info' ? [] : options, sections: null, html: null, allows_multiple: false, recommended, urgency_reason: '', attachments: files.map(pic), change_note: '', close_summary: null, withdraw_reason: null, merged_into_object_id: null, merged_from_object_ids: null }
    const card = { object_id: id, agent_device_id: agent, first_envelope_number: n, created_at: at, answers: [], answer: null, closed_how: null, in_revision: null, timeline_key: `chat:card/${id}`, content_state: 'ok', object_version: 1, version_hash, envelope_number: n, updated_at: at, urgency, object_state: 'open', ...content,
      versions: [{ object_version: 1, version_hash, previous_version_hash: null, envelope_number: n, sent_at: at, object_state: 'open', urgency, content }] }
    f.cards.push(card)
    return card
  }
  mk('The talk under a card: how does it grow together with the card above it?', ui, 2, { files: ['board-desktop.png', 'thema-hell.png'], recommended: 'talk', teaser: 'Two worked-out variants with a long conversation (12 comments), both as a scrollable page to try out before you pick one.', options: [{ key: 'tray', label: 'Shared tray', detail: '' }, { key: 'talk', label: 'Talk inside the card', detail: '' }] })
  mk('Coffee before the next deploy?', zu, 3, { recommended: 'ja', teaser: 'The deploy takes twelve minutes. Time enough for an espresso.' })
  mk('May I run the tests in parallel?', zu, 7, { body: 'Halves the run time, but needs twice the memory.', recommended: 'ja', urgency: 'high' })
  mk('Dark theme as the default?', ui, 9, { files: ['thema-dunkel.png', 'thema-hell.png'] })
  mk('Round corners on the buttons?', ui, 12, { recommended: 'nein', teaser: 'Square goes better with the paper look. I would leave it.' })
  mk('Allow emoji in commit messages?', docs, 15, { teaser: 'Two helpers write them already. One way for all would be nicer.' })
  mk('Move the README to English?', docs, 21, { body: 'The other docs are in English already.', recommended: 'ja' })
  mk('Rotate the keys every 90 days?', cr, 26, { recommended: 'ja', teaser: 'Runs in the background; no device notices anything.' })
  mk('Archive old sessions after 30 days?', zu, 33, { teaser: 'The sidebar has 14 entries by now. Archived means: gone, but findable.' })
  mk('This is the phone now. Is that fine?', ui, 41, { files: ['phone-entscheidungen.png', 'phone-gespraech.png', 'clip.webm'], recommended: 'ja' })
  mk('Logo a little bigger?', ui, 48, { teaser: 'On a phone the bell looks a little lost.', options: [{ key: 'ja', label: 'Yes, bigger', detail: '' }, { key: 'nein', label: 'Leave it', detail: '' }] })
  mk('May I make the linter stricter?', zu, 57, { body: 'A few old files would turn red then.' })
  mk('A weekly report on Fridays?', docs, 66, { recommended: 'ja', teaser: 'One page: what got done, what is stuck, what comes next.' })
  mk('Raise the password length to 14 characters?', cr, 74, { urgency: 'low' })
  mk('A new typeface for the headings?', ui, 88, { files: ['board-desktop.png'], teaser: 'Bricolage is lively, but restless in long titles. A proposal in the picture.' })
  mk('Pushed: search finds notes too now', zu, 5, { type: 'info', body: 'Live.' })
  mk('Report: all 214 tests green', zu, 19, { type: 'info' })
  mk('Note: the help page has a table of contents', docs, 38, { type: 'info' })
  mk('Pushed: six-digit check code for pairing', cr, 62, { type: 'info' })
  // Sub-sessions (his wish, 4 October: the sidebar trees and the Desk lived-in): three under crypto, three under trommi,
  // each with its drawing, a status line, and a card or two (some answered while the session is still at it).
  const me = f.room.my_device_id
  const sub = (id, name, icon, parent, task, online, line) => {
    const dev = hex(64)
    f.sessions.push({ agent_device_id: dev, agent_session_id: id, device_name: name, is_active: true, is_online: online,
      profile: { model: 'claude-opus-5-5', task, icon, agent_name: name, parent_session: parent, is_main: false },
      status_lines: line ? [{ id: `${id}-1`, label: line[0], state: line[2] ?? 'working', detail: line[1], object_id: null, updated_at: now - (line[3] ?? 2) * MIN }] : [],
      settings: { name: '', desk: 'main', archived: false, group: null, icon: null } })
    return dev
  }
  const answered = (card, key = 'ja', ago = 3) => {
    const v = card.versions[0]
    card.answer = { answer_action: 'answer', choices: [key], note: '', option_notes: {}, attachments: [], marks: [], trusted: false, bound_version_hash: v.version_hash, bound_object_version: 1, envelope_number: ++env, envelope_hash: hex(64), by_device_id: me, answered_at: now - ago * MIN, taken_back_at: null }
    card.answers = [card.answer]; card.object_state = 'answered'; card.closed_how = 'answered'
  }
  const keys = sub('crypto-keys', 'Keys', 'draw:lock', 'crypto', 'Key rotation', true, ['Rotation', 'Old keys are being replaced (3/5)'])
  const pair = sub('crypto-pair', 'Pairing', 'draw:phone', 'crypto', 'Pairing devices', true, ['QR-Code', 'Check code display done', 'done', 20])
  const audit = sub('crypto-audit', 'Audit', 'draw:eye', 'crypto', 'Security review', false, ['Review', 'Reading the core, chapter Envelopes', 'working', 40])
  const hub = sub('trommi-hub', 'Hub', 'draw:database', 'trommi', 'Server and storage', true, ['Backup', 'Nightly backup tested'])
  const conn = sub('trommi-conn', 'Connector', 'draw:anchor', 'trommi', 'Claude-Code-Plugin', true, ['Release', 'Version 0.9 builds'])
  const tests = sub('trommi-tests', 'Tests', 'draw:flask', 'trommi', 'E2E and fuzz', true, ['E2E', '118 of 140 green', 'working', 1])
  // (a helper with a very long name, and a card of its that is out with it: the sidebar, the Desk's tail and a card's meta must hold it)
  const mover = sub('trommi-mover', 'Moving the old accounts over to the new sync engine', 'draw:rocket', 'trommi', 'Account migration', true, ['Accounts', '212 of 412 moved', 'working', 3])
  answered(mk('Move the accounts without a login since 2024 as well, or leave them behind?', mover, 40), 'ja', 3)
  mk('Delete old keys after 7 days?', keys, 11, { recommended: 'ja', teaser: 'Seven days are enough for every device to have been online once.' })
  answered(mk('Start the rotation on all devices now?', keys, 25), 'ja', 4)
  mk('Check code with six digits instead of four?', pair, 16, { recommended: 'ja' })
  mk('Report: pairing tested on 3 devices', pair, 30, { type: 'info' })
  mk('May the audit read the connector too?', audit, 45)
  mk('Storage limit per room at 1 GB?', hub, 13, { recommended: 'ja', teaser: 'The largest room is at 180 MB. 1 GB leaves plenty of air.' })
  answered(mk('Back up to a Hetzner Storage Box?', hub, 50), 'ja', 2)
  mk('Publish the plugin version in the marketplace?', conn, 8, { files: ['board-desktop.png'], teaser: 'Version 0.9 builds cleanly, all tests green. Visible to everyone from Monday.' })
  mk('Pushed: the connector reloads itself', conn, 22, { type: 'info' })
  answered(mk('Run the fuzz tests at night?', tests, 35), 'ja', 1)
  mk('Skip the flaky test "pairing-qr" for now?', tests, 6, { recommended: 'nein' })
  return f
}

// Two cards with far too much on them, the first two of the Desk (his wish, 7 October): stress cases for the card's
// page, the gallery and the Desk row. A decision (a three-line title, a long text with a list, code and a table, five
// wordy options, eight pictures and a video, three versions, a long talk) and an info (sections, a layout, pictures,
// a talk). Demo data only.
const EXPLAIN = 'Explain this question in more detail and in plain words: what it is about, what each option means for me, and what you would do.'
const HAND_BACK = 'Back to you: please rework this question and present it again. Take the comments under the card into account.'
function overloaded(f) {
  const now = Date.now(), MIN = 60e3, me = f.room.my_device_id, zu = f.sessions[0].agent_device_id, docs = f.sessions[2].agent_device_id
  const first = Math.min(...f.cards.filter(c => c.urgency === 'critical' && c.object_state === 'open').map(c => c.created_at), now - 90 * MIN)
  let env = 8000
  const att = (name, show, type, more = {}) => ({ attachment_id: hex(32), file_key: '', sha256: '', file_name: show, media_type: type, total_size: 0, url: `/demo/files/${name}`, ...more })
  const png = (name, show, w, h, caption, more = {}) => att(name, show, 'image/png', { width: w, height: h, caption, ...more })
  const item = (from, at, content) => ({ envelope_number: ++env, local_id: null, pending: false, envelope_hash: hex(64), sender_device_id: from === 'me' ? me : from, recipient_device_id: from === 'me' ? null : null, sent_at: at, item_state: 'loaded', content_type: 'message', content: { attachments: [], ...content } })
  const put = (agent, created, urgency, versions, talk, extra = {}) => {
    const id = hex(32), key = `chat:card/${id}`
    const vs = versions.map((v, i) => ({ object_version: i + 1, version_hash: hex(64), previous_version_hash: null, envelope_number: v.env, sent_at: v.at, object_state: 'open', urgency, content: v.content }))
    vs.forEach((v, i) => { if (i) v.previous_version_hash = vs[i - 1].version_hash })
    const last = vs.at(-1)
    f.cards.push({ object_id: id, agent_device_id: agent, first_envelope_number: vs[0].envelope_number, created_at: created, answers: [], answer: null, closed_how: null, in_revision: null, timeline_key: key, content_state: 'ok', object_version: last.object_version, version_hash: last.version_hash, envelope_number: last.envelope_number, updated_at: last.sent_at, urgency, object_state: 'open', ...last.content, versions: vs, ...extra(vs) })
    ;(f.timelines ??= {})[key] = talk.map(t => ({ ...t, recipient_device_id: t.sender_device_id === me ? agent : null }))
  }
  const base = { sections: null, html: null, allows_multiple: false, change_note: '', close_summary: null, withdraw_reason: null, merged_into_object_id: null, merged_from_object_ids: null }

  // ---- 1. the decision ----
  const t0 = first - 3 * MIN, at = n => t0 + n * 40e3
  const pictures = [
    png('tall-sheet.png', 'rollout-whole-page.png', 1440, 2160, 'The whole rollout page, long'),
    png('phone-entscheidungen.png', 'rollout-phone.png', 400, 860, 'The switch as a phone sees it'),
    png('board-desktop.png', 'rollout-desktop.png', 1360, 860, 'The dashboard during the canary, with its page', { page: '/demo/files/page-plan.html' }),
    png('thema-hell.png', 'canary-light.png', 1440, 900, 'Canary: 5 % of the rooms'),
    png('thema-dunkel.png', 'canary-dark.png', 1440, 900, 'The same at night'),
    png('d35bd5f7.png', 'queue-before.png', 1440, 900, 'The queue before the switch'),
    png('635b3af5.png', 'queue-after.png', 1440, 900, 'The queue after the switch'),
    png('12ca0ba4.png', 'rollback-drill.png', 1440, 900, 'The rollback drill of last Tuesday'),
    att('clip.webm', 'switch-in-ten-seconds.webm', 'video/webm'),
  ]
  const options = [
    { key: 'canary', label: 'Canary first: 5 % of the rooms for a day, then everyone', detail: 'Slowest, safest. A bad day costs twenty rooms an hour of delayed messages, nobody loses anything.' },
    { key: 'night', label: 'All rooms tonight at 02:00, while almost nobody is online', detail: 'One switch, one night. If it goes wrong the morning starts with a rollback and a status post.' },
    { key: 'region', label: 'Region by region over three nights, Europe last', detail: 'Three small switches instead of one big one; the on-call engineer is awake three nights in a row.' },
    { key: 'optin', label: 'Opt-in for two weeks, then switch whoever is left', detail: 'Rooms that want the speed get it now. Two code paths stay alive for two weeks, with twice the tests.' },
    { key: 'wait', label: 'Not before the audit of the new queue is finished', detail: 'The auditors need about ten more days. Until then the old engine keeps its 400 ms lag at peak.' },
  ]
  const body = v => `The new sync engine is ready on the staging hub. It replaces the polling loop with one long-lived stream per device and cuts the delay between an agent's question and your phone from about **400 ms** to under **60 ms** at peak.

What I need from you is the **order of the rollout**, not whether we do it: the old loop is the reason for last week's two lost notifications, and it has to go.

What I checked${v > 1 ? ' (now with the rollback drill you asked for)' : ''}:

- every envelope written during the switch is delivered exactly once (replayed 1.2 million from last month)
- a device on the old client keeps working: it falls back to \`GET /envelopes?after=\` until it updates
- the queue drains in under four minutes when the stream drops, see \`hub/ops/drain.mjs\`
- the rollback is one flag, \`SYNC_ENGINE=loop\`, and needs no migration

The switch itself:

\`\`\`sh
node hub/ops/flag.mjs set SYNC_ENGINE stream --rooms canary
node hub/ops/watch.mjs --metric delivery_lag_ms --alarm 250
\`\`\`

| Way | Rooms at risk | Nights awake | Old code gone by |
|---|--:|--:|---|
| Canary first | 20 | 1 | Thursday |
| All tonight | 412 | 1 | tomorrow |
| Region by region | 140 | 3 | Saturday |
| Opt-in | 0 | 0 | in two weeks |
| After the audit | 0 | 0 | about the 20th |

My advice is the canary: it costs one day and tells us what the load of real rooms does to the stream before all of them are on it.`
  const content = (v, note = '') => ({ ...base, card_type: 'decision', title: 'The new sync engine is ready on staging: in which order do we move the 412 rooms over to it, and how much risk are we willing to take in the first night?', teaser: 'Five ways from "everyone tonight" to "after the audit". I would start with a canary of 5 % of the rooms for one day; it costs a day and shows what real load does to the stream.', body: body(v), options: v === 1 ? options.slice(0, 3) : v === 2 ? options.slice(0, 4) : options, recommended: 'canary', urgency_reason: 'The old polling loop lost two notifications last week; every day on it risks another one, and the on-call rota for a night switch has to be fixed by this evening', attachments: v === 1 ? pictures.slice(0, 4) : pictures, change_note: note })
  const v1 = { env: ++env, at: at(0), content: content(1) }
  const say = (from, n, text, more = {}) => item(from, at(n), { text, ...more })
  const talk = [
    say(zu, 1, 'Some background before you pick: the stream is the same code that has carried the Scribble Board for three weeks, so it is not new in production, only new for cards and chat.'),
    say('me', 2, 'How sure are you about "exactly once"? Last time that sentence cost us a weekend.'),
    say(zu, 3, 'Fair. I replayed every envelope of September through the new engine on a copy of the hub and compared the delivery log line by line: 1,204,331 in, 1,204,331 out, no duplicate, none missing. The two that were lost last week are in that set and arrive.', { details: 'The replay took 41 minutes on the staging box.\n\n```\nreplay: 1204331 envelopes, 0 duplicates, 0 missing\nmax lag 212 ms, p95 58 ms\n```' }),
    say('me', 4, EXPLAIN, { explain: true }),
    say(zu, 5, 'In plain words: today every device asks the hub "anything new?" a few times a second. The new engine keeps one line open and the hub speaks when there is something. That is faster and loses nothing when a phone sleeps. The question is only how many rooms we move at once: few first (slow, safe), all in one night (fast, one risky night), or something in between.'),
    say('me', 6, 'Good. I miss an option where people can choose themselves. And I want to see a rollback actually done, not described.', { hand_back: true }),
    say(zu, 7, 'Understood. I add an opt-in way and run a rollback drill on staging tonight.'),
  ]
  const v2 = { env: ++env, at: at(8), content: content(2, 'Added the opt-in way and the pictures of the rollback drill') }
  talk.push(
    say(zu, 9, 'The drill is done: switched 40 staging rooms to the stream, pulled the flag back after ten minutes, nothing lost. The picture shows the queue during the drill.', { attachments: [png('12ca0ba4.png', 'rollback-drill.png', 1440, 900, 'The rollback drill')] }),
    say('me', 10, 'That looks calm. What does the on-call engineer have to do in the canary night, concretely?'),
    say(zu, 11, 'Three things, all in the runbook:\n\n- watch `delivery_lag_ms`; above 250 ms for two minutes the alarm rings\n- if it rings, set `SYNC_ENGINE=loop` for the canary rooms (one command)\n- write one line into the status page\n\nNothing else. No migration, no restart.'),
    say('me', 12, 'Here are the numbers from our last incident for comparison, in case you want to put them next to yours.', { attachments: [att('40c1a1e0.csv', 'incident-september.csv', 'text/csv')] }),
    say(zu, 13, 'Thank you. Your incident had a p95 of 1.9 s for eleven minutes; the worst minute of the drill was 212 ms. I put both into the table on the dashboard page.'),
    say('me', 14, 'One more thing: the auditors asked whether we can wait for them. Please make that a real option so I can say I considered it.'),
    say('me', 15, HAND_BACK, { hand_back: true }),
  )
  const v3 = { env: ++env, at: at(16), content: content(3, 'Added "not before the audit" as the fifth way, with what waiting costs') }
  talk.push(
    say(zu, 17, 'It is on the card now as the fifth way. Honest cost of waiting: about ten more days on the loop, at the current rate one more lost notification is likely.'),
    say('me', 18, 'Is the canary set random, or can I pick the rooms?'),
    say(zu, 19, 'You can pick. By default I take the twenty rooms with the most devices, because they show problems first. If you would rather start with our own rooms, say so and I change the list.'),
    say('me', 20, 'Our own rooms plus the ten busiest. And tell the support channel before anything is switched.'),
    say(zu, 21, 'Noted both. The list is in `hub/ops/canary-rooms.json`; the support channel gets a message one hour before the switch and one when it is done.'),
    say('me', 22, 'I picked "all tonight" by mistake a minute ago and took it back. Still thinking; leaning towards the canary.'),
    say(zu, 23, 'No harm done: nothing was switched, the answer was taken back before I acted on it. I am ready for whichever way you pick; for the canary I need your answer by 18:00 to fix the rota.'),
  )
  put(zu, t0, 'critical', [v1, v2, v3], talk, vs => { const n = ++env; return { answers: [{ answer_action: 'answer', choices: ['night'], note: '', option_notes: {}, attachments: [], marks: [], trusted: false, bound_version_hash: vs[2].version_hash, bound_object_version: 3, envelope_number: n - 4.5, envelope_hash: hex(64), by_device_id: me, answered_at: at(21.5), taken_back_at: n - 4.4, taken_back_sent_at: at(21.7) }] } })

  // ---- 2. the info ----
  const i0 = first - 2 * MIN, ia = n => i0 + n * 35e3
  const isay = (from, n, text, more = {}) => item(from, ia(n), { text, ...more })
  const info = { ...base, card_type: 'info', title: 'Handbook, chapter 4, is rewritten: what changed in "Pairing a device", why, and what the support team has to say differently from Monday on', teaser: 'The pairing chapter is new from the first line: six-digit check code, one invite per device, what to do when a code is refused. Nothing to decide, but support should read it before Monday.', body: '', options: [], recommended: null, urgency_reason: 'Support answers pairing questions with the old text until they have read this',
    sections: [
      { text: 'The chapter **Pairing a device** was written for the four-digit code and for invites that could be used twice. Both are gone since release 0.9, and the old text sent three people in a circle last week. I rewrote it from the first line.' },
      { text: '**What is different for the reader**\n\n- the check code has six digits and is shown on *both* devices; it is compared, never typed\n- an invite is for one device and ends after ten minutes or one use\n- a refused code is explained in one sentence, with the one thing to do next\n- the Emergency Kit has a page of its own instead of a paragraph at the end' },
      { text: '**What support says from Monday on**\n\nNo more "try the link again": an invite that was used is used up. The sentence is now: *"Make a new invite on a device that is already in the room, and compare the six digits."* The old macros `PAIR-02` and `PAIR-05` are replaced by `PAIR-10`.', html: '<div class="grid cols-3"><div class="card"><h4>Before</h4><p class="muted">4 digits, typed. Invite works twice.</p><p><span class="tag bad">3 tickets a day</span></p></div><div class="card"><h4>Since 0.9</h4><p class="muted">6 digits, compared. One invite, one device.</p><p><span class="tag warn">old text</span></p></div><div class="card"><h4>From Monday</h4><p class="muted">New chapter, new macro PAIR-10.</p><p><span class="tag good">in step</span></p></div></div>' },
      { text: '**Where it is**\n\n`docs/handbook/04-pairing.md` on `main`, built into the help page under "Pairing a device". The pictures below are the three screens the chapter walks through; the long one is the whole chapter as it prints.' },
    ],
    attachments: [png('phone-gespraech.png', 'pairing-step-1.png', 400, 860, 'Step 1: the invite'), png('phone-entscheidungen.png', 'pairing-step-2.png', 400, 860, 'Step 2: compare the six digits'), png('tall-sheet.png', 'chapter-4-print.png', 1440, 2160, 'The whole chapter as it prints'), png('c573b0a8.png', 'help-page.png', 1440, 900, 'The chapter on the help page')] }
  const italk = [
    isay(docs, 1, 'One thing I was unsure about: I call it "check code" everywhere, the app says "number" in one place. I kept the app\'s word in the screenshots and used "check code" in the text.'),
    isay('me', 2, 'Use "check code" everywhere and tell UI to change the one place in the app.'),
    isay(docs, 3, 'Done in the text; I sent UI a note with the line (`auth.mjs`, the confirm screen).'),
    isay('me', 4, 'Does the chapter say what happens when the two codes differ?'),
    isay(docs, 5, 'Yes, as its own short section: the codes differ when somebody else took the invite. The chapter says to press "They differ", which ends the invite, and to make a new one. It also says plainly that nothing was shared with the other device.'),
    isay('me', 6, 'Good. Is the Emergency Kit page linked from the pairing chapter?'),
    isay(docs, 7, 'Twice: at the start ("before you pair your last device, print the kit") and at the end. The kit page itself is chapter 7 now.'),
    isay('me', 8, 'Support wants a one-page version for the wall.', { attachments: [att('a62a99e2.json', 'support-macros.json', 'application/json')] }),
    isay(docs, 9, 'I can do that today: the three steps, the one sentence for a refused code, the new macro. It comes as a published page, not as a new card.'),
    isay('me', 10, 'Fine. I will acknowledge this once support has confirmed they read it.'),
  ]
  put(docs, i0, 'critical', [{ env: ++env, at: ia(0), content: info }], italk, () => ({}))

  // ---- 3. an everyday decision with one of everything attached: pictures (one with its page), a video, files ----
  const ui = zu, u0 = first - 4 * MIN, ua = n => u0 + n * 30e3
  const usay = (from, n, text, more = {}) => item(from, ua(n), { text, ...more })
  const tail = { ...base, card_type: 'decision', title: 'The working tail under the stack: with a heading or without?', teaser: 'Cards that are out with an agent lie flat under the stack. Without a heading the Desk is calmer; with one it says what they are.', body: 'The cards that are out with an agent now lie pressed flat under the last card of the stack. I built it both ways: **without a heading** (the flat cards speak for themselves) and **with a small heading** "With the agents".\n\nThe pictures show both at desktop and phone width, the first one comes with its page. The clip is the tail filling up; the measurements and the notes are attached as files.',
    options: [{ key: 'plain', label: 'Without a heading', detail: 'Calmer; the flat cards say who is on them.' }, { key: 'head', label: 'With a small heading', detail: 'Clearer for a first visit, one more line on the Desk.' }], recommended: 'plain', urgency_reason: '',
    sections: [{ text: '' }, { key: 'plain', label: 'Without a heading', text: 'The tail starts right under the last card, a shade paler. Nothing to read before the first flat card.', recommended: true, picture: 0 }, { key: 'head', label: 'With a small heading', text: 'One quiet line "With the agents" above the tail, in the Desk\'s small type.', recommended: false, picture: 1 }],
    attachments: [
      png('board-desktop.png', 'working-tail.png', 1360, 860, 'Without a heading', { page: '/demo/files/page-plan.html' }),
      png('thema-hell.png', 'working-tail-heading.png', 1440, 900, 'With a small heading'),
      png('phone-entscheidungen.png', 'working-tail-phone.png', 400, 860, 'The tail on a phone'),
      png('thema-dunkel.png', 'working-tail-dark.png', 1440, 900, 'The same at night'),
      att('clip.webm', 'tail-fills-up.webm', 'video/webm'),
      att('40c1a1e0.csv', 'row-heights.csv', 'text/csv', { total_size: 120 }),
      att('6e7ec91e.log', 'design-notes.log', 'text/plain', { total_size: 294 }),
    ] }
  tail.sections[0].text = tail.body
  put(ui, u0, 'high', [{ env: ++env, at: ua(0), content: tail }], [
    usay(ui, 1, 'Both ways are on the preview. The row heights I measured are in the table.', { attachments: [att('40c1a1e0.csv', 'row-heights.csv', 'text/csv', { total_size: 120 })] }),
    usay('me', 2, 'Here is how it looks on my screen, with the build log from this morning.', { attachments: [png('c573b0a8.png', 'my-screen.png', 1440, 900, 'My screen'), att('6e7ec91e.log', 'build.log', 'text/plain', { total_size: 294 })] }),
    usay(ui, 3, 'Thank you. On your screen the stack is three cards high, so the tail starts above the fold in both ways.'),
  ], () => ({}))

  // ---- 4. to 7. cards with a life behind them, so that every act lies in a card's talk once (card.mjs cardThread) ----
  // Envelope numbers are the order of the talk: every piece below is made in the order it happened.
  const life = (ago, step = 3) => { const l0 = now - ago * MIN, la = n => l0 + n * step * MIN; return { l0, la, say: (from, n, text, more = {}) => item(from, la(n), { text, ...more }) } }
  const act = (at, version, fields = {}) => ({ answer_action: 'answer', choices: [], note: '', option_notes: {}, attachments: [], marks: [], trusted: false, bound_object_version: version, envelope_number: ++env, envelope_hash: hex(64), by_device_id: me, answered_at: at, taken_back_at: null, taken_back_sent_at: null, ...fields })
  const undo = (a, at) => { a.taken_back_at = ++env; a.taken_back_sent_at = at }
  const bind = (vs, answers) => { for (const a of answers) a.bound_version_hash = vs[a.bound_object_version - 1].version_hash; return answers }

  // 4. a decision, closed by its session: handed back, a second version, answered, the answer taken back, answered
  //    again with notes and a file, closed.
  {
    const { l0, la, say } = life(46)
    const frames = (v, note = '') => ({ ...base, card_type: 'decision', title: 'The opened card’s frame: which way?', teaser: 'The sheet under an opened card, quieter. All ways are on the preview.', body: v === 1 ? 'The desk pad under an opened card is loud: a dark outline, a second line and four corners, and the round buttons stand on the corners. Three quieter ways are on the preview; what I measured is attached.' : 'Two ways that keep the row of round buttons above the card, as you asked: with the drawn paper, and with the hatched corners you like. What I measured is attached.',
      options: v === 1 ? [{ key: 'hairline', label: 'A hairline', detail: 'The tone and one thin line.' }, { key: 'paper', label: 'Paper', detail: 'One drawn outline.' }, { key: 'head', label: 'A row for the buttons', detail: 'Nothing stands beside the card.' }] : [{ key: 'paper', label: 'Row and paper', detail: 'The drawn outline, a second sheet.' }, { key: 'corners', label: 'Row and corners', detail: 'The hatched corners, clear of the buttons.' }], recommended: v === 1 ? 'head' : 'paper', urgency_reason: '', attachments: [att('40c1a1e0.csv', 'frame-measurements.csv', 'text/csv', { total_size: 120 })], change_note: note })
    const v1 = { env: ++env, at: la(0), content: frames(1) }
    const talk = [
      say(zu, 1, 'All three are on the preview. The row costs 40 px of height and frees both sides of the card.'),
      say('me', 2, 'Row and paper?'),
      say(zu, 3, 'That goes together: the row stays, the hairline becomes the drawn outline.'),
      say('me', 4, 'Then show me that. And one with the hatched corners after all, I like them.', { hand_back: true }),
    ]
    const v2 = { env: ++env, at: la(7), content: frames(2, 'Two ways with the row: with the paper, and with the hatched corners') }
    talk.push(say(zu, 8, 'Both are on the card now. On a phone the corners are smaller and the two buttons stand just inside them.'))
    const first = act(la(9), 2, { choices: ['paper'] })
    undo(first, la(9.5))
    talk.push(say('me', 10, 'Hm. On second thought the paper is one frame too many around the card.'), say(zu, 11, 'With the corners the card keeps the pad it has; only the buttons move up into their row.'))
    const second = act(la(12), 2, { choices: ['corners'], note: 'And leave Later’s tag where it hangs.', option_notes: { corners: 'Keep them small on the phone.' }, attachments: [att('6e7ec91e.log', 'corner-sizes.log', 'text/plain', { total_size: 294 })] })
    const closed = ++env
    put(zu, l0, 'normal', [v1, v2], talk, vs => ({ answers: bind(vs, [first, second]), answer: second, object_state: 'closed', closed_how: 'closed', close_summary: 'Built with the row and the hatched corners; Later’s tag hangs where it hung.', envelope_number: closed, updated_at: la(14) }))
  }
  // 5. a decision that is with its session: handed back and taken back, then left to the agent (the duck), the duck
  //    taken back, and the duck after all.
  {
    const { l0, la, say } = life(38)
    const v1 = { env: ++env, at: la(0), content: { ...base, card_type: 'decision', title: 'Name of the new pile: “Off the desk” or “Put away”?', teaser: 'Both fit the label. I lean to “Off the desk”.', body: 'The pile under the stack needs one name for everything that left the Desk. Both fit the label at every width.', options: [{ key: 'off', label: 'Off the desk', detail: 'Says where the cards are.' }, { key: 'away', label: 'Put away', detail: 'Says what you did.' }], recommended: 'off', urgency_reason: '', attachments: [] } }
    const talk = [say('me', 1, HAND_BACK, { hand_back: true }), say('me', 2, 'The human took the card back; no need to rework or explain it.', { present_card: true })]
    const first = act(la(3), 1, { trusted: true, choices: ['off'] })
    undo(first, la(4))
    talk.push(say('me', 5, 'Wait, is “Off the desk” short enough for the phone?'), say(ui, 6, 'Yes: 12 characters, it fits the label at 320 px with room to spare.'))
    const second = act(la(7), 1, { trusted: true, choices: ['off'], note: 'Whatever reads better in the sidebar.' })
    put(ui, l0, 'normal', [v1], talk, vs => ({ answers: bind(vs, [first, second]), answer: second, object_state: 'answered', closed_how: 'answered', updated_at: la(7) }))
  }
  // 6. an info: explained on request, read, taken back (unread again), read.
  {
    const { l0, la, say } = life(30)
    const v1 = { env: ++env, at: la(0), content: { ...base, card_type: 'info', title: 'The nightly backup moved from 03:00 to 04:30', teaser: 'It collided with the log rotation. Nothing to do.', body: 'The backup and the log rotation both started at 03:00 and fought over the disk. The backup now starts at 04:30 and finishes before the first builds.', options: [], recommended: null, urgency_reason: '', attachments: [] } }
    const talk = [say('me', 1, EXPLAIN, { explain: true }), say(docs, 2, 'In plain words: two jobs wanted the disk at the same minute, so one of them was slow. I moved the backup by ninety minutes. Your data is backed up as before, only later in the night.')]
    const first = act(la(3), 1, { answer_action: 'read' })
    undo(first, la(4))
    talk.push(say('me', 5, 'Does the restore test still run on Sundays?'), say(docs, 6, 'Yes, at 06:00, after the backup of that night.'))
    const second = act(la(7), 1, { answer_action: 'read' })
    put(docs, l0, 'normal', [v1], talk, vs => ({ answers: bind(vs, [first, second]), answer: second, object_state: 'closed', closed_how: 'read', updated_at: la(7) }))
  }
  // 7. a chore with a final option: shredded with a word, taken out of the shredder, then answered with the final
  //    option, which settles it.
  {
    const { l0, la, say } = life(22)
    const v1 = { env: ++env, at: la(0), content: { ...base, card_type: 'decision', title: 'Two things for you: renew the domain, confirm the invoice address', teaser: 'Both need your login. Tell me when they are done.', body: 'I cannot do these two for you: the registrar and the billing page both want your login.', options: [{ key: 'done', label: 'Both done', detail: '', final: true }, { key: 'later', label: 'Remind me tomorrow', detail: '' }], recommended: null, urgency_reason: '', attachments: [] } }
    const first = act(la(1), 1, { answer_action: 'shred', note: 'Not today.' })
    undo(first, la(2))
    const talk = [say('me', 3, 'Sorry, that was too quick. The domain is renewed; the address comes in a minute.')]
    const second = act(la(4), 1, { choices: ['done'] })
    put(zu, l0, 'normal', [v1], talk, vs => ({ answers: bind(vs, [first, second]), answer: second, object_state: 'closed', closed_how: 'settled', updated_at: la(4) }))
  }
  // 8. a question its session withdrew.
  {
    const { l0, la, say } = life(15)
    const v1 = { env: ++env, at: la(0), content: { ...base, card_type: 'decision', title: 'Raise the upload limit to 200 MB?', teaser: 'Two rooms hit the 64 MB limit this week.', body: 'Two rooms hit the 64 MB limit this week with screen recordings.', options: [{ key: 'yes', label: 'Yes', detail: '' }, { key: 'no', label: 'No', detail: '' }], recommended: 'yes', urgency_reason: '', attachments: [], withdraw_reason: 'Both recordings fit after all: the app now compresses a video before it is sent.' } }
    const talk = [say(zu, 1, 'I am measuring what the hub’s disk can take before you decide.')]
    const gone = ++env
    put(zu, l0, 'normal', [v1], talk, () => ({ object_state: 'closed', closed_how: 'withdrawn', envelope_number: gone, updated_at: la(3) }))
  }
  return f
}

// A small Desk for final answers (?mock=quiet): three open questions with an option their agent marked final (a chore
// with two named answers, a plain yes or no, one with three ways), two cards such an answer settled, two a session
// works on, and a few closed by their agents.
function quietDesk(f) {
  const now = Date.now(), MIN = 60e3, me = f.room.my_device_id
  const main = f.sessions[0], claude = main.agent_device_id
  Object.assign(main, { device_name: 'Claude', is_online: true, status_lines: [] })
  main.profile = { ...main.profile, agent_name: 'Claude', task: 'Trommi: hub, app and connector' }
  f.sessions = [main]
  const design = hex(64)
  f.sessions.push({ agent_device_id: design, agent_session_id: 'claude-design', device_name: 'Design', is_active: true, is_online: true,
    profile: { model: 'claude-opus-5-5', task: 'Desk and card design', icon: 'draw:brush', agent_name: 'Design', parent_session: main.agent_session_id, is_main: false },
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
  mk('Which typeface for the headings?', design, 2 * 1440, [['bri', 'Bricolage'], ['int', 'Inter']], { how: 'Bricolage is in everywhere, the help page too.' })
  mk('A backup every night at 3?', claude, 1440, [['ja', 'Yes'], ['nein', 'No']], { how: 'The timer runs, the first backup lies on the Storage Box.' })
  mk('Delete the old test data?', claude, 420, [['ja', 'Yes'], ['nein', 'No', true]], { how: '312 rooms deleted, 1.4 GB free.' })
  mk('Round corners on the buttons?', design, 300, [['nein', 'Keep them square', true], ['ja', 'Round']], { how: 'settled', body: 'Square suits the pen; round would be an afternoon of work.' })
  mk('The shadow under the card: leave it?', design, 95, [['ja', 'Leave it', true], ['nein', 'Make it softer']], { how: 'settled', body: 'It is 2 px deep now and set a little to the right, as under the note.' })
  mk('Dog-ear: 20 % bigger, or leave it?', design, 12, [['gross', '20 % bigger'], ['so', 'Leave it', true]], { how: 'answered', body: 'Its tip would then stand 38 instead of 31 px from the corner.' })
  mk('Roll out the new hub tonight?', claude, 25, [['nacht', 'Tonight'], ['morgen', 'Tomorrow']], { how: 'answered', body: 'The switch takes about two minutes; no card arrives in that time.' })
  mk('Two small things for you (Cloudflare, auto mode)', claude, 34, [['done', 'Both done', true], ['hilfe', 'Show me how']], { body: '1. In the Cloudflare dashboard set the DNS entry “hub” to “Proxied”.\n2. In the terminal switch auto mode on (Shift+Tab), or every file asks by itself.' })
  mk('Leave the Later tag grey?', design, 21, [['ja', 'Yes', true], ['nein', 'No']], { body: 'Grey holds back like everything else that is off the desk. On No I build the blue one.' })
  mk('Review of the Desk: three small things fixed. Fine like this?', design, 8, [['ok', 'Fine like this', true], ['nochmal', 'Once more'], ['bilder', 'Show pictures first']], { body: 'The heading no longer jumps, the pile closes with Escape, the times stand right-aligned.' })
  for (const d of Object.values(f.human?.desks ?? {})) if (d.name === 'Desk') d.name = 'Trommi'
  if (f.notes?.length) f.notes = [f.notes[0]]
  return f
}

// ?mock=foot: nothing open on the Desk ("Carry on."), but full piles at its foot: every question answered, and many
// pages the agents published (the phone's foot with three full piles and the empty Desk under them).
function fullFoot(f) {
  for (const c of f.cards) if (c.closed_how !== 'shredded' && (c.object_state !== 'closed' || c.closed_how === 'closed')) {
    const v = c.versions?.at(-1)
    c.answer ??= { answer_action: 'answer', choices: [v?.content?.options?.[0]?.key ?? 'a'], note: '', option_notes: {}, attachments: [], marks: [], trusted: false, bound_version_hash: c.version_hash, bound_object_version: c.object_version ?? 1, envelope_number: c.first_envelope_number, answered_at: Date.now() }
    c.answers = [c.answer]; c.object_state = 'closed'; c.closed_how = 'settled'; c.in_revision = null
  }
  f.permissions = []
  const pages = f.published.filter(p => p.attachments?.[0]?.media_type === 'text/html')
  const names = ['desklook-tabs', 'desklook-table', 'desklook-rows', 'cardscribble-trace', 'toast-slot', 'pages-pile', 'phone-foot', 'done-rows', 'tracing-sheet', 'all-desks']
  for (let i = 0; i < 60 && pages.length; i++) {
    const p = pages[i % pages.length], name = `${names[i % names.length]}-${Math.floor(i / names.length) + 1}`
    f.published.push({ ...structuredClone(p), object_id: hex(32), title: `${name}.html`, attachments: [{ ...p.attachments[0], attachment_id: hex(32), file_name: `${name}.html` }], envelope_number: (p.envelope_number ?? 1) + i + 1 })
  }
  return f
}

let fixtureCache
async function loadFixture(kind) {
  if (kind === 'crazy') return crazyFixture()
  fixtureCache ??= await (await fetch('/demo/fixture.json')).json()
  if (kind === 'quiet') return quietDesk(structuredClone(fixtureCache))
  const f = (overloaded(filler(putAway(structuredClone(fixtureCache)))))
  if (kind === 'many') return manyHelpers(crowded(f))
  if (kind === 'foot') return fullFoot(f)
  return kind === 'side' ? crowded(f) : kind === 'link' ? linkDemo(f) : f
}

// ?mock=link: one session in each state of its link (app.mjs linkOf), and receipts. UI hears on its next step and is at
// work, Connector the same but has done nothing for 46 minutes, Hub is cut off (its Claude Code runs, its Trommi tools
// are gone), Docs is gone; the others hear at once. Every older answer reached its session; two were not picked up.
function linkDemo(f) {
  const now = Date.now(), MIN = 60e3
  const by = id => f.sessions.find(s => s.agent_session_id === id)
  const report = (hears, min, more = {}) => ({ hears, attached: true, last_call_at: now - min * MIN, working: false, since: now - 300 * MIN, cut_since: null, exit: null, ...more })
  const LINK = {
    'trommi-ui': report('oncall', 1),
    'trommi-conn': report('oncall', 46),
    'trommi-hub': report('live', 44),
    crypto: report('oncall', 3),
  }
  const HEARD = 1e9
  for (const s of f.sessions) { s.link = LINK[s.agent_session_id] ?? report('live', 2); s.heard_up_to = HEARD }
  const off = (id, min, exit) => { const s = by(id); if (s) { s.is_online = false; s.offline_since = now - min * MIN; s.link = { ...s.link, exit } } }
  off('trommi-hub', 38, { reason: 'stdin', claude: 'alive' })
  off('trommi-docs', 131, { reason: 'stdin', claude: 'gone' })
  off('crypto-audit', 320, null)
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
  answer('Run the fuzz tests at night?', 1, true)
  answer('Start the rotation on all devices now?', 4, true)
  answer('Tab bar at the bottom or at the top?', 4, true)
  answer('Publish the plugin version in the marketplace?', 12, false)
  // (and one answer each that waits: in the session that is cut off, in one that hears on its next step, in one that hears at once)
  const waiting = (id, ago) => { const s = by(id), c = s && f.cards.find(c => c.agent_device_id === s.agent_device_id && c.object_state === 'open' && c.card_type !== 'info' && c.urgency === 'normal' && !c.in_revision); if (c) answer(c.title, ago, false) }
  waiting('trommi-hub', 6); waiting('trommi-ui', 1); waiting('trommi-tests', 9)
  return f
}

// A full sidebar (?mock=side): eight more sessions beside the demo's two trees, with long names and none, one, two,
// five, six and twelve open questions, two of them disconnected.
// One main with many helpers (?mock=many): the full sidebar's eight sessions become trommi's helpers, fourteen in all;
// the folded rail must stay calm with them.
function manyHelpers(f) {
  const main = f.sessions[0].agent_session_id
  for (const s of f.sessions.slice(-8)) s.profile = { ...s.profile, parent_session: main }
  return f
}
function crowded(f) {
  const now = Date.now(), MIN = 60e3, like = f.cards.find(c => c.object_state === 'open' && c.card_type === 'decision' && c.urgency === 'normal' && !c.in_revision)
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
// Same shape as public/mock/fixture.json (core model, core/README.md).
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
// The screens that really exist (his word, 8 October): one per page of the app, each with its states beside it (a menu
// open, the selection, a toast, empty…) that switch the same pair of frames in place. [title, path, states], a state
// [label, path?, state?, mock?] (path: another address of the same screen; state: demoState's click; mock: a demo room).
const SCREENS = [
  ['Desk', '/', [['With the selection bar', '', 'select'], ['Duck for all: the confirm', '', 'duck'], ['A toast with Undo', '', 'toast'], ['The end list and the piles', '', 'bottom'], ['Trommi menu open', '', 'menu'], ['A desk alone (filter)', '/?desk=test'], ['Note from the phone bar', '', 'phone-note'], ['Keys sheet', '', 'keys'], ['Corner note open', '', 'note'], ['Empty, full piles', '', '', 'foot'], ['Quiet desk', '', '', 'quiet']]],
  ['Card page', '/card/30', [['Long card', '/card/31'], ['Long card, scrolled inside', '/card/31', 'inside'], ['The strip (card scrolled away)', '/card/31', 'strip'], ['Yes or no', '/card/46'], ['Several answers', '/card/11'], ['Info card', '/card/19'], ['Answered', '/card/1'], ['With the agent', '/card/1', 'with-agent'], ['Finished by its agent', '/card/34'], ['More menu open', '', 'more']]],
  ['Full screen', '/card/31/picture/1', [['A video', '/card/31/picture/9']]],
  ['Blitz', '/blitz', []],
  ['Session', '/s/trommi', [['Three-dot menu open', '', 'session-more'], ['Questions only', '/s/trommi?only=questions'], ['Files', '/s/trommi/files'], ['A helper', '/s/trommi-ui']]],
  ['Settings', '/settings/agents', [['Invite an agent', '', 'invite'], ['Emoji compare', '/s/trommi', 'invite-emoji'], ['Link run out', '', 'invite-ended'], ['Pairing a device', '', 'pair'], ['Devices', '/settings/devices'], ['Account', '/settings/account']]],
  ['Artifacts', '/artifacts', [['Media', '/artifacts?kind=media'], ['Pages', '/artifacts?kind=pages'], ['Share open', '/artifacts?kind=pages', 'share']]],
  ['Off the desk', '/stacks/off', []],
  ['Scribble Board', '/scribble-board', [['Its keys', '', 'board-help']]],
  ['Log out', '/logout', []],
]
const frameSrc = (path, state, mock = '1') => `${path}${path.includes('?') ? '&' : '?'}mock=${mock || '1'}${state ? `&state=${state}` : ''}`
export function screensMain() {
  // One screen: its title (opens it alone), its states as small buttons; the pair of frames shows the chosen one.
  const screen = ([title, path, states, first = '']) => {
    const all = [['As it is', path, first], ...states.map(([label, p, st, mock]) => [label, p || path, st ?? '', mock])]
    const src = frameSrc(path, first)
    const list = states.length ? `<div class="scr-states" role="group" aria-label="${title}: states">${all.map(([label], i) => `<button type="button" class="scr-state" data-action="screens#state" data-at="${i}"${i ? '' : ' aria-pressed="true"'}>${label}</button>`).join('')}</div>` : ''
    return `<figure class="scr-item" data-states='${JSON.stringify(all.map(([label, p, st, mock]) => ({ label, src: frameSrc(p, st, mock) }))).replace(/'/g, '&#39;')}'><figcaption><a href="${src}" target="_blank" rel="noopener" class="scr-title">${title}</a> <code>${path}</code></figcaption><div class="scr-row"><div class="scr-pair"><div class="scr-box is-wide"><iframe data-src="${src}" title="${title}, desktop" loading="lazy" width="1440" height="900"></iframe></div><div class="scr-box is-phone"><iframe data-src="${src}" title="${title}, phone" loading="lazy" width="390" height="844"></iframe></div></div>${list}</div></figure>`
  }
  return `<main id="screens" class="scr-page" data-controller="screens"><style>
.scr-page{grid-column:1/-1;overflow-y:auto;height:100%;padding:24px 32px 80px;background:var(--bg);color:var(--fg)}
.scr-head{display:flex;align-items:center;gap:16px;margin-bottom:8px}.scr-head h1{font:800 2rem/1.1 var(--display);margin:0}
.scr-head p{margin:0;color:var(--muted)}.scr-theme.is-tour{margin-left:auto;background:var(--fg);color:var(--bg)}.scr-theme{min-height:36px;padding:0 14px;border:1.6px solid var(--fg);border-radius:9px 12px 8px 13px/12px 8px 13px 9px;background:var(--surface);color:var(--fg);font:700 var(--t-sm)/1 var(--font);cursor:pointer}
.scr-page h2{font:800 1.4rem/1.2 var(--display);margin:32px 0 12px;padding-top:12px;border-top:1px dashed var(--line-strong)}
.scr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(840px,1fr));gap:24px 28px}
.scr-row{display:flex;gap:16px;align-items:flex-start}
.scr-item{margin:0}.scr-item figcaption{display:flex;gap:10px;align-items:baseline;margin-bottom:6px;font:600 var(--t-sm)/1.3 var(--font)}
.scr-item figcaption a{color:var(--fg)}.scr-item code{font:500 var(--t-xs)/1 var(--mono);color:var(--muted)}
.scr-states{display:flex;flex-direction:column;align-items:stretch;gap:4px;width:190px;margin:0}.scr-state{min-height:26px;padding:0 9px;border:0;border-radius:8px;background:var(--surface);box-shadow:inset 0 0 0 1px var(--line-strong);color:var(--muted);font:600 var(--t-xs)/1 var(--font);cursor:pointer}.scr-state[aria-pressed="true"]{background:var(--fg);color:var(--bg);box-shadow:none}
.scr-item{padding-top:14px;border-top:1px dashed var(--line-strong)}.scr-item .scr-title{font:800 1.2rem/1.2 var(--display)}
.scr-pair{display:flex;gap:12px;align-items:flex-start}
.scr-box{position:relative;flex:none;overflow:hidden;border:1.5px solid var(--fg);border-radius:8px;background:var(--surface);box-shadow:0 8px 18px -12px rgb(20 30 25/.4)}
.scr-box.is-wide{width:480px;height:300px}.scr-box.is-phone{width:130px;height:281px;border-radius:14px}
.scr-box iframe{position:absolute;left:0;top:0;border:0;transform-origin:0 0;pointer-events:none}
.scr-box.is-wide iframe{transform:scale(.3333)}.scr-box.is-phone iframe{transform:scale(.3333)}
.tour{position:fixed;inset:0;z-index:200;display:grid;grid-template-rows:minmax(0,1fr) auto;background:var(--sunken)}
.tour-stage{position:relative;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 392px;gap:16px;padding:12px;align-items:start}
.tour-stage iframe{display:block;border:1.5px solid var(--fg);background:var(--surface);box-shadow:0 18px 40px -20px rgb(20 30 25/.5)}
.tour-stage .is-wide{width:100%;height:100%;border-radius:10px}
.tour-stage .is-phone{width:390px;height:min(844px,100%);border-radius:22px;justify-self:end}
.tour-bar{display:flex;align-items:center;gap:8px;min-height:44px;padding:4px 12px;border-top:1.5px solid var(--fg);background:var(--surface);color:var(--fg);font:600 var(--t-sm)/1.2 var(--font)}
.tour-bar button,.tour-bar select{min-height:34px;padding:0 12px;border:0;border-radius:10px;background:var(--surface);box-shadow:inset 0 0 0 1px var(--line-strong);color:var(--fg);font:600 var(--t-sm)/1 var(--font);cursor:pointer}
.tour-bar .tour-play{background:var(--fg);color:var(--bg);box-shadow:none;min-width:84px}
.tour-where{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--muted)}.tour-where b{color:var(--fg)}
.tour-wait{font:500 var(--t-xs)/1 var(--font);color:var(--muted)}
</style><header class="scr-head"><h1>All screens</h1><p>The demo room: every screen once, its states beside it; a title opens it alone.</p><button type="button" class="scr-theme is-tour" data-action="screens#tour">▶ Play tour</button><button type="button" class="scr-theme" data-action="screens#eager" title="Load every frame now, for scrolling through all of them">Load all</button><button type="button" class="scr-theme" data-action="screens#theme">Light / dark</button></header>
<div class="scr-grid">${SCREENS.map(screen).join('')}</div></main>`
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
    }
    disconnect() { this.io?.disconnect(); this.endTour() }
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
      stage.replaceChildren(wide, phone)
      const at = this.at
      both.then(() => { if (this.box && this.at === at) { this.ready = true; this.arm() } })
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
    'with-agent': () => { const c = window.trommi.model().state.cards.find(x => x.with_agent); if (c) window.trommi.router.visit(`/card/${c.number}`) },
    'session-more': () => click('.t-head-more'),
    pair: () => click('#settings-pair') || click('#pair-start'),
    invite: () => click('#settings-invite-agent'),
    'invite-emoji': async () => { click('.t-head-more'); await wait(200); [...document.querySelectorAll('.desk-move button')].find(b => /invite link/.test(b.textContent))?.click() },
    'invite-ended': async () => { click('#settings-invite-agent'); await wait(900); const inv = [...window.trommi.client.model.invites.values()].at(-1); if (inv) { inv.expires_at = Date.now() - 1000; window.trommi.client.changed(c => c.invites.add(inv.invite_id)) } },
    share: () => { const s = $('.lk-share .lk-switch input'); if (s) { s.checked = true; s.dispatchEvent(new Event('change', { bubbles: true })) } },
    'board-help': () => click('#help-btn'),
  }
  await S[name]?.()
}
