// The mock room: the client core's API and model shape (core/README.md in trommi-hub), without a hub and
// without crypto, fed from public/demo/fixture.json (dev/make-fixture.mjs) or generated big (?mock=crazy). Used with
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
    const sessions = new Map(f.sessions.map(s => [s.agent_device_id, { ...s, agent_alerts: [], registers: new Map(), read_up_to: 0, card_ids: [], open_card_ids: [], timeline_key: `chat:session/${s.agent_device_id}`, unread_count: 0, last_activity_at: 0 }]))
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
    if (content.present_card) return
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

// Cards he put away, so the pile "Off the desk" holds a card of every place (desk.mjs): two snoozed, one
// handed back, one answered a moment ago (its session is still at it), one shredded. Times relative to now.
function putAway(f) {
  const now = Date.now(), MIN = 60e3, [zu, ui, , cr] = f.sessions.map(s => s.agent_device_id)
  const me = f.room.my_device_id
  let env = 9000
  const mk = (title, agent, ago, how) => {
    const id = hex(32), at = now - ago * MIN, n = ++env, version_hash = hex(64)
    const content = { card_type: 'decision', title, body: '', options: [{ key: 'a', label: 'Ja', detail: '' }, { key: 'b', label: 'Nein', detail: '' }], sections: null, html: null, allows_multiple: false, recommended: null, urgency_reason: '', attachments: [], change_note: '', close_summary: null, withdraw_reason: null, merged_into_object_id: null, merged_from_object_ids: null }
    const c = { object_id: id, agent_device_id: agent, first_envelope_number: n, created_at: at - 30 * MIN, answers: [], answer: null, closed_how: null, in_revision: null, timeline_key: `chat:card/${id}`, content_state: 'ok', object_version: 1, version_hash, envelope_number: n, updated_at: at, urgency: 'normal', object_state: 'open', ...content,
      versions: [{ object_version: 1, version_hash, previous_version_hash: null, envelope_number: n, sent_at: at - 30 * MIN, object_state: 'open', urgency: 'normal', content }] }
    const answer = action => ({ answer_action: action, choices: action === 'answer' ? ['a'] : [], note: '', option_notes: {}, attachments: [], marks: [], trusted: false, bound_version_hash: version_hash, bound_object_version: 1, envelope_number: n, envelope_hash: hex(64), by_device_id: me, answered_at: at, taken_back_at: null })
    if (how === 'snooze') (f.human.snoozes ??= {})[id] = { until: now + 4 * 60 * MIN, at }
    else if (how === 'revise') c.in_revision = { by: 'hand_back', envelope_number: n }
    else if (how === 'answer') Object.assign(c, { answer: answer('answer'), object_state: 'answered', closed_how: 'answered' })
    else if (how === 'shred') Object.assign(c, { answer: answer('shred'), object_state: 'closed', closed_how: 'shredded' })
    if (c.answer) c.answers = [c.answer]
    f.cards.push(c)
  }
  mk('Tab-Leiste unten oder oben?', ui, 4, 'answer')
  mk('Release-Notes heute schreiben?', zu, 18, 'snooze')
  mk('Alte Testdaten löschen?', cr, 35, 'shred')
  mk('Icon-Set: eigene Striche oder Lucide?', ui, 52, 'revise')
  mk('Backup um 3 Uhr nachts?', zu, 95, 'snooze')
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
    'Produktion steht: jetzt zurückrollen?': 'Seit 12:04 gibt die API 502 zurück. Zurückrollen dauert zwei Minuten, der alte Build ist noch warm.',
    'Wie soll das Board auf dem Handy starten?': 'Auf dem Handy passt nur eine Ansicht. Ich würde mit dem Desk starten, nicht mit dem Gespräch.',
    'Zertifikat läuft in 2 Tagen ab. Jetzt erneuern?': 'Danach warnt jeder Browser. Die Erneuerung läuft automatisch, braucht nur dein Ja.',
    'Welches Standard-Theme?': 'Beide Themes sind fertig. Ich brauche nur den Standard für neue Nutzer.',
    'Migration auf der Produktions-Datenbank ausführen?': 'Fügt eine Spalte hinzu und füllt 48.210 Zeilen nach, etwa 40 Sekunden ohne Ausfall.',
    'Was baue ich als Nächstes?': 'Drei Wege liegen bereit: Suche, Teilen, oder die Handy-Ansicht fertig machen.',
  }
  for (const c of f.cards) if (TEASE[c.title]) { c.teaser = TEASE[c.title]; for (const v of c.versions ?? []) if (v.content) v.content.teaser = TEASE[c.title] }
  let env = 9500
  const pic = name => ({ attachment_id: hex(32), file_key: '', sha256: '', file_name: name, media_type: name.endsWith('.webm') ? 'video/webm' : 'image/png', total_size: 0, url: `/demo/files/${name}` })
  const YN = [{ key: 'ja', label: 'Ja', detail: '' }, { key: 'nein', label: 'Nein', detail: '' }]
  const mk = (title, agent, ago, { body = '', teaser = null, type = 'decision', options = YN, recommended = null, urgency = 'normal', files = [] } = {}) => {
    const id = hex(32), at = now - ago * MIN, n = ++env, version_hash = hex(64)
    const content = { card_type: type, title, teaser, body, options: type === 'info' ? [] : options, sections: null, html: null, allows_multiple: false, recommended, urgency_reason: '', attachments: files.map(pic), change_note: '', close_summary: null, withdraw_reason: null, merged_into_object_id: null, merged_from_object_ids: null }
    const card = { object_id: id, agent_device_id: agent, first_envelope_number: n, created_at: at, answers: [], answer: null, closed_how: null, in_revision: null, timeline_key: `chat:card/${id}`, content_state: 'ok', object_version: 1, version_hash, envelope_number: n, updated_at: at, urgency, object_state: 'open', ...content,
      versions: [{ object_version: 1, version_hash, previous_version_hash: null, envelope_number: n, sent_at: at, object_state: 'open', urgency, content }] }
    f.cards.push(card)
    return card
  }
  mk('Kaffee vor dem nächsten Deploy?', zu, 3, { recommended: 'ja', teaser: 'Der Deploy dauert zwölf Minuten. Genug Zeit für einen Espresso.' })
  mk('Darf ich die Tests parallel laufen lassen?', zu, 7, { body: 'Halbiert die Laufzeit, braucht aber doppelt so viel Speicher.', recommended: 'ja', urgency: 'high' })
  mk('Dunkles Theme als Standard?', ui, 9, { files: ['thema-dunkel.png', 'thema-hell.png'] })
  mk('Runde Ecken an den Knöpfen?', ui, 12, { recommended: 'nein', teaser: 'Eckig passt besser zum Papier-Look. Ich würde es lassen.' })
  mk('Emoji in Commit-Nachrichten erlauben?', docs, 15, { teaser: 'Zwei Helfer schreiben schon welche. Einheitlich wäre schöner.' })
  mk('README auf Englisch umstellen?', docs, 21, { body: 'Die Hilfe-Seite ist schon englisch.', recommended: 'ja' })
  mk('Schlüssel alle 90 Tage tauschen?', cr, 26, { recommended: 'ja', teaser: 'Läuft im Hintergrund, kein Gerät merkt etwas davon.' })
  mk('Alte Sitzungen nach 30 Tagen archivieren?', zu, 33, { teaser: 'Die Seitenleiste hat inzwischen 14 Einträge. Archiviert heißt: weg, aber findbar.' })
  mk('So sieht das Handy jetzt aus. Passt das?', ui, 41, { files: ['phone-entscheidungen.png', 'phone-gespraech.png', 'clip.webm'], recommended: 'ja' })
  mk('Logo etwas größer?', ui, 48, { teaser: 'Auf dem Handy wirkt die Glocke etwas verloren.', options: [{ key: 'ja', label: 'Ja, größer', detail: '' }, { key: 'nein', label: 'Lassen', detail: '' }] })
  mk('Darf ich den Linter strenger stellen?', zu, 57, { body: 'Ein paar alte Dateien würden dann rot.' })
  mk('Wöchentlicher Bericht am Freitag?', docs, 66, { recommended: 'ja', teaser: 'Eine Seite: was fertig wurde, was hängt, was als Nächstes kommt.' })
  mk('Passwort-Länge auf 14 Zeichen anheben?', cr, 74, { urgency: 'low' })
  mk('Neue Schrift für die Überschriften?', ui, 88, { files: ['board-desktop.png'], teaser: 'Bricolage ist lebendig, aber bei langen Titeln unruhig. Vorschlag im Bild.' })
  mk('Gepusht: Suche findet jetzt auch Notizen', zu, 5, { type: 'info', body: 'Live.' })
  mk('Bericht: alle 214 Tests grün', zu, 19, { type: 'info' })
  mk('Notiz: Hilfe-Seite hat ein Inhaltsverzeichnis', docs, 38, { type: 'info' })
  mk('Gepusht: Prüfcode beim Koppeln sechsstellig', cr, 62, { type: 'info' })
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
  const keys = sub('crypto-keys', 'Schlüssel', 'draw:lock', 'crypto', 'Schlüsselwechsel', true, ['Rotation', 'Alte Schlüssel werden abgelöst (3/5)'])
  const pair = sub('crypto-pair', 'Pairing', 'draw:phone', 'crypto', 'Geräte koppeln', true, ['QR-Code', 'Prüfcode-Anzeige fertig', 'done', 20])
  const audit = sub('crypto-audit', 'Audit', 'draw:eye', 'crypto', 'Sicherheits-Review', false, ['Review', 'Liest den Core, Kapitel Envelopes', 'working', 40])
  const hub = sub('trommi-hub', 'Hub', 'draw:database', 'trommi', 'Server und Speicher', true, ['Backup', 'Nächtliches Backup getestet'])
  const conn = sub('trommi-conn', 'Connector', 'draw:anchor', 'trommi', 'Claude-Code-Plugin', true, ['Release', 'Version 0.9 baut'])
  const tests = sub('trommi-tests', 'Tests', 'draw:flask', 'trommi', 'E2E und Fuzz', true, ['E2E', '118 von 140 grün', 'working', 1])
  mk('Alte Schlüssel nach 7 Tagen löschen?', keys, 11, { recommended: 'ja', teaser: 'Sieben Tage reichen, damit jedes Gerät einmal online war.' })
  answered(mk('Rotation jetzt auf allen Geräten starten?', keys, 25), 'ja', 4)
  mk('Prüfcode sechsstellig statt vierstellig?', pair, 16, { recommended: 'ja' })
  mk('Bericht: Pairing auf 3 Geräten getestet', pair, 30, { type: 'info' })
  mk('Darf das Audit auch den Connector lesen?', audit, 45)
  mk('Speicher-Limit pro Raum auf 1 GB?', hub, 13, { recommended: 'ja', teaser: 'Der größte Raum liegt bei 180 MB. 1 GB lässt viel Luft.' })
  answered(mk('Backup nach Hetzner Storage Box?', hub, 50), 'ja', 2)
  mk('Plugin-Version im Marketplace veröffentlichen?', conn, 8, { files: ['board-desktop.png'], teaser: 'Version 0.9 baut sauber, alle Tests grün. Sichtbar für alle ab Montag.' })
  mk('Gepusht: Connector lädt sich selbst neu', conn, 22, { type: 'info' })
  answered(mk('Fuzz-Tests nachts laufen lassen?', tests, 35), 'ja', 1)
  mk('Flaky Test „pairing-qr“ vorerst überspringen?', tests, 6, { recommended: 'nein' })
  return f
}

let fixtureCache
async function loadFixture(kind) {
  if (kind === 'crazy') return crazyFixture()
  fixtureCache ??= await (await fetch('/demo/fixture.json')).json()
  return filler(putAway(structuredClone(fixtureCache)))
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
    const options = [{ key: 'a', label: 'Variante A', detail: 'schnell' }, { key: 'b', label: 'Variante B', detail: 'sicher' }, ...(i % 3 ? [] : [{ key: 'c', label: 'Später', detail: '' }])]
    const content = { card_type: i % 11 === 0 ? 'info' : 'decision', title: `Frage ${i + 1}: ${['Welche Variante bauen?', 'Migration jetzt ausführen?', 'Layout für die Übersicht?', 'Zertifikat erneuern?'][i % 4]}`, body: 'Kurze Erklärung zur Frage, zwei Sätze lang. Mehr steht im Gespräch.', options: i % 11 === 0 ? [] : options, sections: null, html: null, allows_multiple: false, recommended: 'b', urgency_reason: '', attachments: [], change_note: '', close_summary: null, withdraw_reason: null, merged_into_object_id: null, merged_from_object_ids: null }
    const v1 = { object_version: 1, version_hash: hex(64, 9e5 + i), previous_version_hash: null, envelope_number: ++n, sent_at: created, object_state: 'open', urgency: i % 17 === 0 ? 'high' : 'normal', content }
    const versions = [v1]
    if (i % 4 === 0) versions.push({ ...v1, object_version: 2, version_hash: hex(64, 8e5 + i), previous_version_hash: v1.version_hash, envelope_number: ++n, sent_at: created + 1000, content: { ...content, body: `${content.body} (überarbeitet)` } })
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
    ;(timelines[key] ??= []).push({ envelope_number: ++n, local_id: null, pending: false, envelope_hash: hex(64, 6e6 + k), sender_device_id: human ? me : (card?.agent_device_id ?? s.agent_device_id), recipient_device_id: human ? (card?.agent_device_id ?? s.agent_device_id) : null, sent_at: now - (messages - k) * 1000, item_state: 'loaded', content_type: 'message', content: { text: human ? `Nachricht ${k}: bitte so machen.` : `Antwort ${k}: **erledigt**, die Tests laufen. Details im Log.` } })
  }
  const members = [{ device_id: me, device_role: 'human', device_name: 'Laptop', is_active: true, added_entry_number: 0, removed_entry_number: null, is_me: true, is_online: true }, ...ss.map((s, i) => ({ device_id: s.agent_device_id, device_role: 'agent', device_name: s.device_name, is_active: true, added_entry_number: i + 1, removed_entry_number: null, is_me: false, is_online: s.is_online, agent_session_id: s.agent_session_id }))]
  return {
    made_at: now, room: { room_id: hex(64, 2), hub_url: 'mock:', my_device_id: me, my_role: 'human', key_epoch: 1, last_entry_number: members.length - 1, last_envelope_number: n, connection: 'live' },
    members, sessions: ss, cards, permissions: [], notes: [], published: [], timelines,
    human: { drafts: {}, snoozes: {}, ducks: {}, crown: { agent_device_id: ss[0].agent_device_id }, desks: {}, session_settings: Object.fromEntries(ss.map(s => [s.agent_device_id, s.settings])), read_up_to: {} },
  }
}
